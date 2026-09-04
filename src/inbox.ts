// Lightweight inbox derived only from channel logs + existing cursors.
// New DM frames carry opaque namespaced identities so a restarted session can
// prove which messages belong to it without enumerating or guessing private DMs.

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
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
  if (!channel.startsWith("dm-")) return [];
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
    const state = inboxCursorState(channel, messages, context, env);
    const joined = cursorExists(channel, context.primaryName, env) || state.consumers
      .slice(1)
      .some((consumer) => cursorExists(channel, consumer, env));
    const dm = channel.startsWith("dm-");
    const unread = messages.filter((message) => {
      if (message.seq <= state.cursor || isInboxSelf(message, context)) return false;
      if (message.to_identity !== undefined && identities.has(message.to_identity)) return true;
      if (dm) return joined && message.to_identity === undefined;
      return joined || message.mentions.some((mention) => mentionNames.has(mention));
    });
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
