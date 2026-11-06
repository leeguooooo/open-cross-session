// Lightweight inbox derived only from channel logs + existing cursors.
// New DM frames carry opaque namespaced identities so a restarted session can
// prove which messages belong to it without enumerating or guessing private DMs.

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { seenKey } from "./seen-wakes.ts";
import {
  cursorPath,
  listChannels,
  loadCursor,
  readRoutedMessages,
  saveCursor,
  type RoutedOcsMessage,
} from "./store.ts";

export interface InboxIdentityContext {
  /** Human/display identity used by ordinary read cursors. */
  primaryName: string;
  /** Full namespaced identities this runtime can prove it owns. */
  identities: readonly string[];
  /** Human addresses that count as a directed mention in ordinary channels. */
  mentionNames: readonly string[];
  /**
   * Wakes the host's own session record proves entered this conversation (src/seen-wakes.ts,
   * keys from seenKey). The note carried the full body, so they are read. Never derived from
   * delivery success (iron rule 4).
   */
  seen?: ReadonlySet<string>;
}

export interface InboxThread {
  channel: string;
  unread: number;
  lastSeq: number;
  lastFrom: string;
  lastAt: string;
}

/** Stable, path-safe cursor key without leaking a workspace/thread identity. */
export function identityCursorConsumer(identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex").slice(0, 40);
  return `identity-${digest}`;
}

function cursorExists(channel: string, consumer: string, env: NodeJS.ProcessEnv): boolean {
  try {
    const stat = lstatSync(cursorPath(channel, consumer, env));
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function matchedIdentities(
  channel: string,
  messages: readonly RoutedOcsMessage[],
  context: InboxIdentityContext,
): string[] {
  if (!channel.startsWith("dm-") && !channel.startsWith("lan-")) return [];
  const owned = new Set(context.identities);
  const matched = new Set<string>();
  for (const message of messages) {
    if (message.from_identity !== undefined && owned.has(message.from_identity)) {
      matched.add(message.from_identity);
    }
    if (message.to_identity !== undefined && owned.has(message.to_identity)) {
      matched.add(message.to_identity);
    }
  }
  return [...matched].sort();
}

export interface InboxCursorState {
  cursor: number;
  consumers: string[];
}

/** Resolve both the legacy display-name cursor and any stable DM identity cursor. */
export function inboxCursorState(
  channel: string,
  messages: readonly RoutedOcsMessage[],
  context: InboxIdentityContext,
  env: NodeJS.ProcessEnv = process.env,
): InboxCursorState {
  const consumers = [
    context.primaryName,
    ...matchedIdentities(channel, messages, context).map(identityCursorConsumer),
  ];
  return {
    cursor: Math.max(...consumers.map((consumer) => loadCursor(channel, consumer, env))),
    consumers,
  };
}

export function saveInboxCursor(
  channel: string,
  consumers: readonly string[],
  cursor: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const consumer of new Set(consumers)) saveCursor(channel, consumer, cursor, env);
}

export function isInboxSelf(message: RoutedOcsMessage, context: InboxIdentityContext): boolean {
  return message.from === context.primaryName ||
    (message.from_identity !== undefined && context.identities.includes(message.from_identity));
}

/**
 * Messages in one channel that `ocs inbox` would count as unread for this identity.
 * Side effect: with `context.seen` evidence it persists the read cursor over the seen prefix
 * (only for DMs or channels this identity already joined). Keep it out of paths that must not
 * write.
 */
export function unreadInChannel(
  channel: string,
  messages: readonly RoutedOcsMessage[],
  context: InboxIdentityContext,
  env: NodeJS.ProcessEnv = process.env,
  identities: ReadonlySet<string> = new Set(context.identities),
  mentionNames: ReadonlySet<string> = new Set(context.mentionNames),
): RoutedOcsMessage[] {
  const state = inboxCursorState(channel, messages, context, env);
  const joined = cursorExists(channel, context.primaryName, env) || state.consumers
    .slice(1)
    .some((consumer) => cursorExists(channel, consumer, env));
  // lan-* 是跨机 DM（docs/lan.md），归属规则同 dm-*。
  const dm = channel.startsWith("dm-") || channel.startsWith("lan-");
  const candidate = (message: RoutedOcsMessage) => {
    if (message.seq <= state.cursor || isInboxSelf(message, context)) return false;
    if (message.to_identity !== undefined && identities.has(message.to_identity)) return true;
    if (dm) return joined && message.to_identity === undefined;
    return joined || message.mentions.some((mention) => mentionNames.has(mention));
  };
  const seen = context.seen;
  if (seen === undefined || seen.size === 0) return messages.filter(candidate);
  const isSeen = (message: RoutedOcsMessage) => seen.has(seenKey(channel, message.seq));
  // 把游标推过「已经在对话里看过」的连续前缀并落盘：会话记录只读尾部，老的证据会滚出窗口，
  // 推过去之后就不再依赖它。中间夹着一条没看过的就停，后面的不跳。
  let advanced = state.cursor;
  let sawAny = false;
  for (const message of [...messages].sort((a, b) => a.seq - b.seq)) {
    if (message.seq <= state.cursor) continue;
    if (candidate(message) && !isSeen(message)) break;
    if (isSeen(message)) sawAny = true;
    advanced = message.seq;
  }
  // 普通频道里，游标文件本身就意味着「加入了这个频道」（之后每条都算未读）：只被 @ 过一次、
  // 看过那条的会话不能因此被拉进频道。没加入就只在内存里排除，不落盘。
  if (sawAny && advanced > state.cursor && (dm || joined)) {
    try {
      saveInboxCursor(channel, state.consumers, advanced, env);
    } catch {
      // 只是省一次重复提示，写不了就下次再算
    }
  }
  return messages.filter((message) => candidate(message) && !isSeen(message));
}

/**
 * List only threads attributable to the current identity:
 * - new DMs: explicit to_identity;
 * - old DMs: an existing cursor proves prior participation;
 * - ordinary channels: an existing cursor or a direct @ mention.
 */
export function listInboxThreads(
  context: InboxIdentityContext,
  env: NodeJS.ProcessEnv = process.env,
): InboxThread[] {
  const identities = new Set(context.identities);
  const mentionNames = new Set(context.mentionNames);
  const threads: InboxThread[] = [];
  for (const channel of listChannels(env)) {
    const messages = readRoutedMessages(channel, { env });
    if (messages.length === 0) continue;
    const unread = unreadInChannel(channel, messages, context, env, identities, mentionNames);
    const last = unread.at(-1);
    if (last === undefined) continue;
    threads.push({
      channel,
      unread: unread.length,
      lastSeq: last.seq,
      lastFrom: last.from,
      lastAt: last.ts,
    });
  }
  threads.sort((a, b) => b.lastAt.localeCompare(a.lastAt) || b.lastSeq - a.lastSeq);
  return threads;
}
