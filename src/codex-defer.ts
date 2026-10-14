import { writeTraffic } from "./traffic.ts";
// Codex 忙时合并唤醒（issue #41，docs/wake-protocol.md §1.1）。
//
// 毛病：`codex queue` 和 Desktop IPC 在目标正跑回合时都不会丢弃输入，而是排进宿主自己的
// 队列，回合结束后逐条开新回合。协作中对方连发 10 条 DM，就是 10 条唤醒排着队——接收方
// 早在任务里 `ocs read` 读完了，任务结束后仍被逐条唤醒 10 次，每次都只能回「已处理」，
// 还有把旧计划当新指令重跑的风险。宿主队列一旦写进去就撤不回，所以闸门只能放在**入队之前**：
//
//   * 目标空闲：照旧立刻投递（行为和 0.7.3 一样）。
//   * 目标正在回合中：消息照常落盘，唤醒不入宿主队列，记进
//     `$OCS_HOME/codex-wakes/<thread>.<channel>.json`，并为这对（接收方, 频道）派一个脱离终端
//     的等待器。同一对上后续消息只追加记录，不再派第二个。
//   * 等待器看到回合结束：取出记录，按接收方读游标筛掉**已经读过**的 seq，剩下的合成**一条**
//     唤醒（正文是最新那条，头部写明前面还有几条未读、从哪个 seq 起），走原来的投递阶梯；
//     全部已读就什么都不发。投递期间又来的消息留在记录里，等下一次空闲。
//
// 首选不是这里：目标正忙时 deliverToCodexTask 先用守护进程 `turn/steer` 把唤醒插进当前回合
// （codex-steer.ts，终端 TUI 实测可用）。这里是插不进时的退路——Desktop 托管的 task（steer 会
// 丢掉 IPC 的原生来源信封，铁律 10）、没有守护进程、宿主拒绝 steer。
//
// 不丢消息：正文始终在频道日志里，记录只决定「要不要再敲一次门」。等待器挂了、目标退出，
// 未读消息照样在 `ocs inbox` / `ocs read` 里。合并唤醒同样遵守 unknown-outcome 不重放（铁律 5）：
// 投出去的 seq 无论结果如何都已从记录里取走，等待器绝不补发。
//
// 「读过」只认读游标前进（接收方 `ocs read`），不认唤醒被投递——一条唤醒正文内联过不代表
// agent 处理了它，但这里本来就只在决定要不要再发一条提醒，判错的代价是多一条唤醒，不是丢消息。

import { spawnDetached } from "./detach.ts";
import { closeSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { codexRolloutPath, codexThreadLivePid } from "./codex-queue.ts";
import { isCodexThreadId } from "./codex-sessions.ts";
import { identityCursorConsumer } from "./inbox.ts";
import { listOcsNames } from "./names.ts";
import { acquireLock, CHANNEL_RE, loadCursor, ocsHome, readMessages } from "./store.ts";
import type { WakeLang, WakeNoteInput } from "./wake.ts";

export const CODEX_WAKE_WATCH_COMMAND = "_codex-wake-watch";
/** 等待器轮询间隔；和 idle watcher 共用同一个测试旋钮。 */
export const CODEX_WAKE_POLL_MS_ENV = "OCS_IDLE_POLL_MS";
export const CODEX_WAKE_POLL_DEFAULT_MS = 2000;
/** 心跳超过这么久没更新 = 等待器已死，下一个发送方接手重派。 */
export const CODEX_WAKE_HEARTBEAT_STALE_MS = 30_000;
/** 一直不空闲也不能一直憋着：超过这个时长照样投一条合并唤醒（宿主会排队，但只有一条）。 */
export const CODEX_WAKE_MAX_DEFER_MS = 6 * 60 * 60 * 1000;
/** 连续多少次查不到活进程才认定目标退出（同 idle watcher：瞬时读失败自愈）。 */
export const CODEX_WAKE_GONE_CONFIRMATIONS = 3;

export interface DeferredWakeEntry {
  seq: number;
  from: string;
  replyTo?: number;
  dmReplyTarget?: string;
  /** 入记录的时间（ISO）。 */
  deferredAt: string;
}

export interface DeferredCodexWake {
  v: 1;
  threadId: string;
  channel: string;
  /** 本轮积压开始的时间（ISO）；超过 CODEX_WAKE_MAX_DEFER_MS 强制投递。 */
  since: string;
  lang: WakeLang;
  sourceThreadId?: string;
  pending: DeferredWakeEntry[];
}

export function codexWakesDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "codex-wakes");
}

function recordPath(threadId: string, channel: string, env: NodeJS.ProcessEnv): string {
  return join(codexWakesDir(env), `${threadId.toLowerCase()}.${channel}.json`);
}

function heartbeatPath(threadId: string, channel: string, env: NodeJS.ProcessEnv): string {
  return `${recordPath(threadId, channel, env)}.beat`;
}

function validKey(threadId: string, channel: string): boolean {
  return isCodexThreadId(threadId) && CHANNEL_RE.test(channel);
}

function isEntry(value: unknown): value is DeferredWakeEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.seq) && (v.seq as number) > 0 && typeof v.from === "string" &&
    typeof v.deferredAt === "string" &&
    (v.replyTo === undefined || Number.isInteger(v.replyTo)) &&
    (v.dmReplyTarget === undefined || typeof v.dmReplyTarget === "string");
}

export function loadDeferredCodexWake(
  threadId: string,
  channel: string,
  env: NodeJS.ProcessEnv = process.env,
): DeferredCodexWake | null {
  if (!validKey(threadId, channel)) return null;
  try {
    const value = JSON.parse(readFileSync(recordPath(threadId, channel, env), "utf8")) as Record<string, unknown>;
    if (value.v !== 1 || value.threadId !== threadId.toLowerCase() || value.channel !== channel) return null;
    if (typeof value.since !== "string" || (value.lang !== "en" && value.lang !== "zh")) return null;
    if (!Array.isArray(value.pending) || !value.pending.every(isEntry)) return null;
    if (value.sourceThreadId !== undefined && typeof value.sourceThreadId !== "string") return null;
    return value as unknown as DeferredCodexWake;
  } catch {
    return null;
  }
}

function saveRecord(record: DeferredCodexWake, env: NodeJS.ProcessEnv): void {
  mkdirSync(codexWakesDir(env), { recursive: true, mode: 0o700 });
  const path = recordPath(record.threadId, record.channel, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(record), { mode: 0o600 });
  renameSync(tmp, path);
}

function removeRecord(threadId: string, channel: string, env: NodeJS.ProcessEnv): void {
  for (const path of [recordPath(threadId, channel, env), heartbeatPath(threadId, channel, env)]) {
    try {
      unlinkSync(path);
    } catch {
      // 已经没了
    }
  }
}

function withRecordLock<T>(threadId: string, channel: string, env: NodeJS.ProcessEnv, fn: () => T): T {
  mkdirSync(codexWakesDir(env), { recursive: true, mode: 0o700 });
  const unlock = acquireLock(`${recordPath(threadId, channel, env)}.lock`, env);
  try {
    return fn();
  } finally {
    unlock();
  }
}

function beat(threadId: string, channel: string, env: NodeJS.ProcessEnv): void {
  const path = heartbeatPath(threadId, channel, env);
  const now = new Date();
  try {
    utimesSync(path, now, now);
  } catch {
    try {
      writeFileSync(path, "", { mode: 0o600 });
    } catch {
      // 心跳写不了只会让下一个发送方多派一个等待器，两个等待器在同一把锁下取记录，不会重复投递
    }
  }
}

function watcherAlive(threadId: string, channel: string, env: NodeJS.ProcessEnv, now = Date.now()): boolean {
  try {
    return now - statSync(heartbeatPath(threadId, channel, env)).mtimeMs < CODEX_WAKE_HEARTBEAT_STALE_MS;
  } catch {
    return false;
  }
}

/** rollout 尾部往前找回合生命周期事件时，每次多读这么多字节。 */
const TAIL_CHUNK_BYTES = 256 * 1024;
const LIFECYCLE_RE = /"type":"event_msg","payload":\{"type":"(task_started|task_complete|turn_aborted)"(?:,"turn_id":"([^"]+)")?/g;

/**
 * 目标此刻正在跑的回合 id；空闲返回 null。证据取 rollout 里最后一个回合生命周期事件：
 * `task_started` 之后还没有 `task_complete` / `turn_aborted` = 正忙。
 * 从文件尾按块往前找，长回合的事件多也能找到；读不到 rollout 或找不到任何事件按空闲处理
 * （空闲＝照旧立即投递，即 0.7.3 的行为，不会因为判不出来而把唤醒憋住）。
 * 忙但 task_started 没带 turn_id（旧格式）返回空串：仍算忙，只是没法 steer。
 */
export function codexActiveTurnId(threadId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const path = codexRolloutPath(threadId, env);
  if (path === null) return null;
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const size = statSync(path).size;
    let end = size;
    let carry = "";
    while (end > 0) {
      const start = Math.max(0, end - TAIL_CHUNK_BYTES);
      const buf = Buffer.alloc(end - start);
      readSync(fd, buf, 0, buf.length, start);
      // 块边界可能切开一行：把上一块（更靠后）开头那半行拼回来再找。
      const text = buf.toString("utf8") + carry;
      let last: RegExpMatchArray | null = null;
      for (const match of text.matchAll(LIFECYCLE_RE)) last = match;
      if (last !== null) return last[1] === "task_started" ? (last[2] ?? "") : null;
      const firstNewline = text.indexOf("\n");
      carry = firstNewline === -1 ? text : text.slice(0, firstNewline);
      end = start;
    }
    return null;
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

export function codexThreadBusy(threadId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return codexActiveTurnId(threadId, env) !== null;
}

export type DeferResult =
  /** 目标空闲且没有积压：调用方照旧立即投递。 */
  | { deferred: false }
  /** 已记入积压；spawned 表示这次派了新的等待器。 */
  | { deferred: true; spawned: boolean; pending: number };

export interface DeferInput {
  threadId: string;
  wakeInput: Omit<WakeNoteInput, "receiver">;
  sourceThreadId?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：判忙与派等待器。 */
  isBusy?: (threadId: string, env: NodeJS.ProcessEnv) => boolean;
  spawnWatcher?: (threadId: string, channel: string, env: NodeJS.ProcessEnv) => void;
}

/**
 * 投递前的闸门：已有积压（等待器在跑）就并进去；没有积压但目标正忙就开一份积压并派等待器；
 * 否则返回 deferred:false，调用方立即投递。整个判断在记录锁内，和等待器取记录互斥——
 * 等待器刚取走一批时进来的消息要么进下一批，要么（记录已删、目标空闲）立即投递，不会落空。
 */
export function deferCodexWakeIfBusy(input: DeferInput): DeferResult {
  const env = input.env ?? process.env;
  const threadId = input.threadId.toLowerCase();
  const { channel } = input.wakeInput;
  if (!validKey(threadId, channel) || input.wakeInput.rawNote !== undefined) return { deferred: false };
  const isBusy = input.isBusy ?? codexThreadBusy;
  const spawn = input.spawnWatcher ?? spawnCodexWakeWatcher;
  return withRecordLock(threadId, channel, env, () => {
    const existing = loadDeferredCodexWake(threadId, channel, env);
    if (existing === null && !isBusy(threadId, env)) return { deferred: false };
    const entry: DeferredWakeEntry = {
      seq: input.wakeInput.seq,
      from: input.wakeInput.from,
      ...(input.wakeInput.replyTo !== undefined ? { replyTo: input.wakeInput.replyTo } : {}),
      ...(input.wakeInput.dmReplyTarget !== undefined ? { dmReplyTarget: input.wakeInput.dmReplyTarget } : {}),
      deferredAt: new Date().toISOString(),
    };
    const record: DeferredCodexWake = existing ?? {
      v: 1,
      threadId,
      channel,
      since: entry.deferredAt,
      lang: input.wakeInput.lang ?? "en",
      pending: [],
    };
    if (!record.pending.some((p) => p.seq === entry.seq)) record.pending.push(entry);
    record.pending.sort((a, b) => a.seq - b.seq);
    if (existing !== null && existing.pending.length === 0) record.since = entry.deferredAt;
    if (input.sourceThreadId !== undefined) record.sourceThreadId = input.sourceThreadId;
    record.lang = input.wakeInput.lang ?? record.lang;
    saveRecord(record, env);
    if (watcherAlive(threadId, channel, env)) return { deferred: true, spawned: false, pending: record.pending.length };
    // 先写心跳再派：并发的下一个发送方看到心跳就不会再派一个。
    beat(threadId, channel, env);
    spawn(threadId, channel, env);
    return { deferred: true, spawned: true, pending: record.pending.length };
  });
}

let watcherCommand: string[] | null = null;

/** cli 启动时注入自身命令（`selfCommand()`），避免这里反向依赖 idle.ts。 */
export function setCodexWakeWatcherCommand(command: string[]): void {
  watcherCommand = command;
}

function spawnCodexWakeWatcher(threadId: string, channel: string, env: NodeJS.ProcessEnv): void {
  if (watcherCommand === null) throw new Error("codex wake watcher command not configured");
  const [cmd, ...args] = watcherCommand;
  const child = spawnDetached(cmd!, [...args, CODEX_WAKE_WATCH_COMMAND, threadId, channel], {
    stdio: "ignore",
    env: { ...env },
  });
  child.unref();
}

/**
 * 接收方在这个频道里读到哪了。codex 里 `ocs read` 的消费者名是 thread id（或 $OCS_NAME），
 * DM 还会写一份按 `codex:<thread>` 身份的游标；给这个 thread 登记过的 ocs 名字也算。
 * 取最大值：任何一个身份读过就算读过。
 */
export function codexReceiverCursor(threadId: string, channel: string, env: NodeJS.ProcessEnv = process.env): number {
  const tid = threadId.toLowerCase();
  const consumers = new Set<string>([tid, identityCursorConsumer(`codex:${tid}`)]);
  for (const entry of listOcsNames(env)) {
    if (entry.kind === "codex" && entry.id.toLowerCase() === tid) consumers.add(entry.name);
  }
  return Math.max(0, ...[...consumers].map((consumer) => loadCursor(channel, consumer, env)));
}

export function formatAgo(ms: number, lang: WakeLang): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const value = s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return lang === "zh" ? `${value}前` : `${value} ago`;
}

/** 一批积压合成的那一条唤醒；null = 全部已读，什么都不用发。 */
export function coalescedWakeInput(
  record: Pick<DeferredCodexWake, "threadId" | "channel" | "lang">,
  batch: readonly DeferredWakeEntry[],
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): { wakeInput: Omit<WakeNoteInput, "receiver">; seqs: number[]; alreadyRead: number[] } | null {
  const cursor = codexReceiverCursor(record.threadId, record.channel, env);
  const unread = batch.filter((entry) => entry.seq > cursor);
  const alreadyRead = batch.filter((entry) => entry.seq <= cursor).map((entry) => entry.seq);
  if (unread.length === 0) return null;
  const latest = unread[unread.length - 1]!;
  const message = readMessages(record.channel, { env }).find((m) => m.seq === latest.seq);
  if (message === undefined) return null; // 日志里没有这条（被手工删了）：没有可提醒的正文
  const sentAt = Date.parse(message.ts);
  return {
    wakeInput: {
      channel: record.channel,
      seq: latest.seq,
      from: latest.from,
      body: message.body,
      lang: record.lang,
      ...(latest.replyTo !== undefined ? { replyTo: latest.replyTo } : {}),
      ...(latest.dmReplyTarget !== undefined ? { dmReplyTarget: latest.dmReplyTarget } : {}),
      ...(Number.isFinite(sentAt) ? { ago: formatAgo(now - sentAt, record.lang) } : {}),
      ...(unread.length > 1 ? { earlier: { count: unread.length - 1, firstSeq: unread[0]!.seq } } : {}),
    },
    seqs: unread.map((entry) => entry.seq),
    alreadyRead,
  };
}

export type CoalescedDeliver = (
  threadId: string,
  wakeInput: Omit<WakeNoteInput, "receiver">,
  sourceThreadId: string | undefined,
) => Promise<{ lines: string[]; outcome: "ok" | "failed" | "unknown" }>;

export interface CodexWakeWatchOptions {
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
  deliver: CoalescedDeliver;
  /** 测试注入。 */
  isBusy?: (threadId: string, env: NodeJS.ProcessEnv) => boolean;
  isLive?: (threadId: string, env: NodeJS.ProcessEnv) => boolean;
  now?: () => number;
}

/** 等待器的投递流水：排查「这条唤醒什么时候、为什么发 / 没发」用。 */
function logHistory(env: NodeJS.ProcessEnv, entry: Record<string, unknown>): void {
  try {
    mkdirSync(codexWakesDir(env), { recursive: true, mode: 0o700 });
    appendFileSync(join(codexWakesDir(env), "history.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, {
      mode: 0o600,
    });
  } catch {
    // 流水只是诊断
  }
}

/**
 * 等待器主循环（`ocs _codex-wake-watch <thread> <channel>`）：目标空闲（或积压超时）就把
 * 记录里的一批取走、合成一条唤醒投出去；投递期间又积压了就继续等，没有就删记录退出。
 * 目标退出：删记录退出（消息都在日志里，下次 inbox/read 照样看得见）。
 */
export async function runCodexWakeWatch(
  threadId: string,
  channel: string,
  options: CodexWakeWatchOptions,
): Promise<void> {
  const env = options.env ?? process.env;
  const tid = threadId.toLowerCase();
  if (!validKey(tid, channel)) return;
  const raw = Number(env[CODEX_WAKE_POLL_MS_ENV]);
  const pollMs = options.pollMs ?? (Number.isInteger(raw) && raw >= 10 ? raw : CODEX_WAKE_POLL_DEFAULT_MS);
  const isBusy = options.isBusy ?? codexThreadBusy;
  const isLive = options.isLive ?? ((id: string, e: NodeJS.ProcessEnv) => codexThreadLivePid(id, e) !== null);
  const now = options.now ?? Date.now;
  let gone = 0;
  for (;;) {
    beat(tid, channel, env);
    const record = loadDeferredCodexWake(tid, channel, env);
    if (record === null) return;
    if (record.pending.length === 0) {
      const done = withRecordLock(tid, channel, env, () => {
        const latest = loadDeferredCodexWake(tid, channel, env);
        if (latest !== null && latest.pending.length > 0) return false;
        removeRecord(tid, channel, env);
        return true;
      });
      if (done) return;
      continue;
    }
    if (!isLive(tid, env)) {
      gone += 1;
      if (gone >= CODEX_WAKE_GONE_CONFIRMATIONS) {
        withRecordLock(tid, channel, env, () => removeRecord(tid, channel, env));
        logHistory(env, { threadId: tid, channel, seqs: record.pending.map((p) => p.seq), outcome: "target-gone" });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    gone = 0;
    const overdue = now() - Date.parse(record.since) >= CODEX_WAKE_MAX_DEFER_MS;
    if (!overdue && isBusy(tid, env)) {
      await new Promise((resolve) => setTimeout(resolve, pollMs));
      continue;
    }
    // 锁内取走一批：之后进来的消息进下一批。取走即算处理过——结果未知也不补发（铁律 5）。
    const taken = withRecordLock(tid, channel, env, () => {
      const latest = loadDeferredCodexWake(tid, channel, env);
      if (latest === null) return null;
      saveRecord({ ...latest, pending: [], since: new Date(now()).toISOString() }, env);
      return latest;
    });
    if (taken === null) return;
    const batch = taken.pending;
    const built = coalescedWakeInput(taken, batch, env, now());
    if (built === null) {
      logHistory(env, { threadId: tid, channel, seqs: [], alreadyRead: batch.map((p) => p.seq), outcome: "skipped-read" });
      continue;
    }
    const event = { v: 1 as const, kind: "coalesced" as const, channel, seq: built.wakeInput.seq,
      at: new Date(now()).toISOString(), outcome: "unknown" as const, items: built.seqs.length };
    const eventId = writeTraffic(event, env);
    const result = await options.deliver(tid, built.wakeInput, taken.sourceThreadId);
    writeTraffic({ ...event, outcome: result.outcome === "ok" ? "accepted" : result.outcome }, env, eventId);
    logHistory(env, {
      threadId: tid,
      channel,
      seqs: built.seqs,
      alreadyRead: built.alreadyRead,
      overdue,
      outcome: result.outcome,
      lines: result.lines,
    });
  }
}
