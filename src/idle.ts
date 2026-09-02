// notify-when-idle（docs/wake-protocol.md §2）：一次性订阅「目标会话下次 busy→idle 或退出」，
// 触发时往**订阅方自己的会话**注入一条 idle notice（§1 同一条 UDS 注入路径，from-name=ocs）。
//
// ocs 没有常驻进程，所以每份订阅由一个脱离终端的 watcher 进程（`ocs _idle-watch <id>`，
// setsid + stdio 全关 + unref）轮询目标的 `~/.claude/sessions/<pid>.json`：
// - status 是 Claude 自己写的（busy/idle），pid + sessionId 双重钉住防 pid 复用；
// - 文件消失 / pid 死 / sessionId 变了 ＝ 目标退出；
// - 订阅时目标已 idle → 第一次轮询就触发；6 小时未触发 → 投一条过期通知后退出。
// 订阅记录落在 `$OCS_HOME/idle-subs/<id>.json`：`ocs who` 据此列出待触发项，同一
// （目标, 订阅方）对上重复订阅去重。

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  injectChannelMessage,
  listNativeSessions,
  resolveSessionSocketByPid,
  type NativeClaudeSession,
} from "./claude-inject.ts";
import { messages, type Lang } from "./i18n.ts";
import { ocsHome } from "./store.ts";
import { findSelfClaudePid } from "./wake.ts";

/** 订阅有效期（协议 §2：6 小时）。 */
export const IDLE_SUB_TTL_MS = 6 * 60 * 60 * 1000;
/** watcher 轮询间隔；测试用 env 调小。 */
export const IDLE_POLL_MS_ENV = "OCS_IDLE_POLL_MS";
export const IDLE_POLL_DEFAULT_MS = 2000;
export const IDLE_WATCH_COMMAND = "_idle-watch";

export type IdleSubState = "pending" | "fired" | "exited" | "expired" | "failed";

export interface IdleSubscription {
  v: 1;
  id: string;
  target: { pid: number; sessionId: string | null; name: string };
  subscriber: { pid: number; sessionId: string | null; name: string };
  /** ISO 时间。 */
  created: string;
  expires: string;
  state: IdleSubState;
  lang: Lang;
  watcherPid?: number;
  /** 首次观测到 busy 的起点（ms epoch），算 "busy for" 用。 */
  busySince?: number;
  detail?: string;
}

export function idleSubsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "idle-subs");
}

function subPath(id: string, env?: NodeJS.ProcessEnv): string {
  return join(idleSubsDir(env), `${id}.json`);
}

const ID_RE = /^[0-9a-f-]{36}$/;

export function loadIdleSubscription(id: string, env?: NodeJS.ProcessEnv): IdleSubscription | null {
  if (!ID_RE.test(id)) return null;
  try {
    const value = JSON.parse(readFileSync(subPath(id, env), "utf8")) as unknown;
    return isIdleSubscription(value) ? value : null;
  } catch {
    return null;
  }
}

function isIdleSubscription(value: unknown): value is IdleSubscription {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const party = (p: unknown): boolean =>
    typeof p === "object" && p !== null &&
    typeof (p as Record<string, unknown>).pid === "number" &&
    typeof (p as Record<string, unknown>).name === "string";
  return (
    r.v === 1 && typeof r.id === "string" && party(r.target) && party(r.subscriber) &&
    typeof r.created === "string" && typeof r.expires === "string" &&
    typeof r.state === "string" && (r.lang === "en" || r.lang === "zh")
  );
}

/** tmp + 原子 rename，崩溃不留半截 JSON。 */
export function saveIdleSubscription(sub: IdleSubscription, env?: NodeJS.ProcessEnv): void {
  const dir = idleSubsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = subPath(sub.id, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(sub), { mode: 0o600 });
  renameSync(tmp, path);
}

export function listIdleSubscriptions(env?: NodeJS.ProcessEnv): IdleSubscription[] {
  let files: string[];
  try {
    files = readdirSync(idleSubsDir(env));
  } catch {
    return [];
  }
  const out: IdleSubscription[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const sub = loadIdleSubscription(file.slice(0, -".json".length), env);
    if (sub !== null) out.push(sub);
  }
  out.sort((a, b) => a.created.localeCompare(b.created));
  return out;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 仍会触发的订阅：pending、未到期、且 watcher（若已派出）还活着。 */
export function isIdleSubscriptionLive(sub: IdleSubscription, now = Date.now()): boolean {
  if (sub.state !== "pending") return false;
  if (now >= Date.parse(sub.expires)) return false;
  if (sub.watcherPid !== undefined && !pidAlive(sub.watcherPid)) return false;
  return true;
}

export function pendingIdleSubscriptions(env?: NodeJS.ProcessEnv, now = Date.now()): IdleSubscription[] {
  return listIdleSubscriptions(env).filter((sub) => isIdleSubscriptionLive(sub, now));
}

/** 订阅方 = 调用 ocs 的那个 Claude 会话（沿祖先链找）；不在会话里返回 null。 */
export function resolveIdleSubscriber(env: NodeJS.ProcessEnv = process.env): NativeClaudeSession | null {
  const pid = findSelfClaudePid(env);
  if (pid === null) return null;
  return listNativeSessions(env).find((s) => s.pid === pid) ?? null;
}

export interface CreateIdleSubscriptionInput {
  target: NativeClaudeSession;
  subscriber: NativeClaudeSession;
  lang: Lang;
  env?: NodeJS.ProcessEnv;
  now?: number;
}

/**
 * 落一份订阅记录（不派 watcher）。同一（目标 pid+sessionId, 订阅方 pid+sessionId）已有
 * 存活订阅时直接返回它——一次性语义下第二份只会造成重复通知。
 */
export function createIdleSubscription(
  input: CreateIdleSubscriptionInput,
): { sub: IdleSubscription; deduped: boolean } {
  const now = input.now ?? Date.now();
  const sameParty = (a: { pid: number; sessionId: string | null }, b: NativeClaudeSession) =>
    a.pid === b.pid && (a.sessionId ?? null) === (b.sessionId ?? null);
  for (const existing of pendingIdleSubscriptions(input.env, now)) {
    if (sameParty(existing.target, input.target) && sameParty(existing.subscriber, input.subscriber)) {
      return { sub: existing, deduped: true };
    }
  }
  const sub: IdleSubscription = {
    v: 1,
    id: randomUUID(),
    target: {
      pid: input.target.pid,
      sessionId: input.target.sessionId,
      name: input.target.name ?? `pid-${input.target.pid}`,
    },
    subscriber: {
      pid: input.subscriber.pid,
      sessionId: input.subscriber.sessionId,
      name: input.subscriber.name ?? `pid-${input.subscriber.pid}`,
    },
    created: new Date(now).toISOString(),
    expires: new Date(now + IDLE_SUB_TTL_MS).toISOString(),
    state: "pending",
    lang: input.lang,
  };
  saveIdleSubscription(sub, input.env);
  return { sub, deduped: false };
}

/**
 * 自身可执行命令：源码模式是 `bun src/cli.ts`，编译后的单文件二进制 argv[1] 是虚拟的
 * `/$bunfs/root/...`（磁盘上不存在），此时只用 execPath 本身。
 */
export function selfCommand(): string[] {
  const script = process.argv[1];
  if (typeof script === "string" && !script.startsWith("/$bunfs/") && existsSync(script)) {
    return [process.execPath, script];
  }
  return [process.execPath];
}

/** 派出脱离终端的 watcher 进程并把 pid 记进订阅。 */
export function spawnIdleWatcher(sub: IdleSubscription, env: NodeJS.ProcessEnv = process.env): IdleSubscription {
  const [cmd, ...args] = selfCommand();
  const child = spawn(cmd!, [...args, IDLE_WATCH_COMMAND, sub.id], {
    detached: true,
    stdio: "ignore",
    env: { ...env },
  });
  child.unref();
  const updated: IdleSubscription = { ...sub, ...(child.pid !== undefined ? { watcherPid: child.pid } : {}) };
  saveIdleSubscription(updated, env);
  return updated;
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

type Observation =
  | { kind: "idle" | "busy" | "unknown"; statusUpdatedAt: number | null }
  | { kind: "exited" };

/** 读目标当前状态：文件没了 / pid 死 / sessionId 对不上都算退出。 */
export function observeIdleTarget(
  target: IdleSubscription["target"],
  env: NodeJS.ProcessEnv = process.env,
): Observation {
  const resolved = resolveSessionSocketByPid(target.pid, { expectSessionId: target.sessionId, env });
  if (!resolved.ok) return { kind: "exited" };
  const status = resolved.session.status;
  const kind = status === "idle" ? "idle" : status === "busy" ? "busy" : "unknown";
  return { kind, statusUpdatedAt: resolved.session.statusUpdatedAt };
}

function pollMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[IDLE_POLL_MS_ENV]);
  return Number.isInteger(raw) && raw >= 10 ? raw : IDLE_POLL_DEFAULT_MS;
}

/**
 * watcher 主循环：轮询到 idle / 退出 / 过期三者之一即投递通知、落终态、返回。
 * **一次性**：投递后立即返回，不再盯后续翻转。
 */
export async function runIdleWatch(
  id: string,
  options: { env?: NodeJS.ProcessEnv; pollMs?: number } = {},
): Promise<IdleSubscription | null> {
  const env = options.env ?? process.env;
  const pollMs = options.pollMs ?? pollMsFromEnv(env);
  let sub = loadIdleSubscription(id, env);
  if (sub === null) return null;
  if (sub.state !== "pending") return sub;
  const M = messages(sub.lang);

  const finish = async (body: string, state: IdleSubState): Promise<IdleSubscription> => {
    const result = await injectChannelMessage({
      name: sub!.subscriber.name,
      pid: sub!.subscriber.pid,
      sessionId: sub!.subscriber.sessionId,
      body,
      fromName: "ocs",
      env,
    });
    sub = result.ok
      ? { ...sub!, state }
      : { ...sub!, state: "failed", detail: `${state}: ${result.reason}${result.detail ? ` (${result.detail})` : ""}` };
    saveIdleSubscription(sub, env);
    return sub;
  };

  for (;;) {
    const now = Date.now();
    if (now >= Date.parse(sub.expires)) {
      return finish(M.idleNoticeExpired(sub.target.name), "expired");
    }
    const seen = observeIdleTarget(sub.target, env);
    if (seen.kind === "exited") {
      return finish(M.idleNoticeExited(sub.target.name), "exited");
    }
    if (seen.kind === "idle") {
      const busyFor = sub.busySince === undefined ? 0 : now - sub.busySince;
      return finish(M.idleNoticeIdle(sub.target.name, formatDuration(busyFor)), "fired");
    }
    if (seen.kind === "busy" && sub.busySince === undefined) {
      sub = { ...sub, busySince: seen.statusUpdatedAt ?? now };
      saveIdleSubscription(sub, env);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
