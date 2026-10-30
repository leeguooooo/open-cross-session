// Claude 唤醒 + 投递回执的**发起侧**：落一份 job、派出脱离终端的 helper（src/wake-helper.ts）、
// 等它的第一行结果。
//
// 为什么要 helper：接收端按「写帧进程的 pid」把回执发回去（见 src/claude-receipt.ts），所以写帧的
// 进程必须同时监听回执 socket，而一条被扣下的消息要 5 分钟才有终态——CLI 不能陪着等。
// 模型照抄 notify-when-idle 的 watcher（src/idle.ts）：同一个二进制、内部子命令、detached。
//
// 送达语义（铁律 4/5）：
// - helper 一旦派出，帧由它写，CLI **绝不**再自己写一遍——等不到结果就是 unknown（退出码 3）。
// - 只有「根本没派出 helper」（Windows、OCS_NO_RECEIPTS、spawn 失败）才在本进程走旧的无回执路径。

import { spawnDetached } from "./detach.ts";
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeClaudeSession } from "./claude-inject.ts";
import type { PeerReceiptStatus } from "./claude-receipt.ts";
import type { Lang } from "./i18n.ts";
import { ocsHome } from "./store.ts";
import { wakeNote, wakeSessions, type WakeInput } from "./wake.ts";

export const WAKE_HELPER_COMMAND = "_claude-wake";
/** 设为 1 关掉回执（回到 0.6 的行为与措辞）。 */
export const RECEIPTS_DISABLED_ENV = "OCS_NO_RECEIPTS";
/**
 * CLI 等 helper 第一行结果的上限。正常路径 ≈ helper 启动 + 400 ms 回执窗口；上限另外留出
 * 冷启动和探活的余量。超时按 unknown 报（帧可能已写出，不重放）。
 */
export const RECEIPT_CLI_WAIT_MS = 1500;
export const RECEIPT_CLI_WAIT_MS_ENV = "OCS_RECEIPT_CLI_WAIT_MS";

/** 终态没送达时要通知的发送方会话。null = 发送方不是一个可唤醒的会话（裸 shell、远端）。 */
export type NoticeSender =
  | { kind: "claude"; pid: number; sessionId: string | null; name: string }
  | { kind: "codex"; threadId: string }
  | { kind: "opencode"; sessionId: string }
  | { kind: "pi"; sessionId: string }
  | { kind: "grok"; sessionId: string }
  | { kind: "hermes"; sessionKey: string };

export interface WakeJob {
  v: 1;
  id: string;
  created: string;
  /** 帧的 msg_id；回执用 orig_msg_id 指回它。 */
  msgId: string;
  target: { pid: number; sessionId: string | null; name: string };
  /** 已生成好的唤醒 note（协议 §1）。 */
  note: string;
  fromName: string;
  channel: string;
  seq: number;
  sender: NoticeSender | null;
  lang: Lang;
  /** helper 起来后回填，供 sweepWakeJobs 清理被 SIGKILL 的 helper 留下的 socket。 */
  helperPid?: number;
  replySock?: string;
}

/** helper 写到 stdout 的第一行（也是唯一一行）。 */
export type FirstPhase =
  /** 回执监听建不起来：helper 走了旧的无回执注入，帧已写入收件箱。 */
  | { kind: "plain" }
  | { kind: "failed"; reason: string; detail?: string }
  /** accepted = 窗口内没有任何回执。 */
  | { kind: "receipt"; status: "accepted" | PeerReceiptStatus; reason?: string };

export type TrackedWake = FirstPhase | { kind: "unknown"; detail: string };

const ID_RE = /^[0-9a-f-]{36}$/;
const FIRST_STATUSES: ReadonlySet<string> = new Set([
  "accepted", "held", "delivered", "expired", "refused", "dropped", "denied",
]);

export function wakeJobsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "wake-jobs");
}

function jobPath(id: string, env?: NodeJS.ProcessEnv): string {
  return join(wakeJobsDir(env), `${id}.json`);
}

function isNoticeSender(value: unknown): value is NoticeSender {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  if (r.kind === "claude") {
    return typeof r.pid === "number" && typeof r.name === "string" &&
      (r.sessionId === null || typeof r.sessionId === "string");
  }
  if (r.kind === "codex") return typeof r.threadId === "string";
  if (r.kind === "opencode") return typeof r.sessionId === "string";
  if (r.kind === "pi") return typeof r.sessionId === "string";
  if (r.kind === "grok") return typeof r.sessionId === "string";
  if (r.kind === "hermes") return typeof r.sessionKey === "string";
  return false;
}

function isWakeJob(value: unknown): value is WakeJob {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  const target = r.target as Record<string, unknown> | null | undefined;
  return (
    r.v === 1 && typeof r.id === "string" && ID_RE.test(r.id) && typeof r.msgId === "string" &&
    typeof target === "object" && target !== null &&
    typeof target.pid === "number" && typeof target.name === "string" &&
    (target.sessionId === null || typeof target.sessionId === "string") &&
    typeof r.note === "string" && typeof r.fromName === "string" &&
    typeof r.channel === "string" && typeof r.seq === "number" &&
    (r.sender === null || isNoticeSender(r.sender)) &&
    (r.lang === "en" || r.lang === "zh")
  );
}

export function saveWakeJob(job: WakeJob, env?: NodeJS.ProcessEnv): void {
  const dir = wakeJobsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = jobPath(job.id, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(job), { mode: 0o600 });
  renameSync(tmp, path);
}

export function loadWakeJob(id: string, env?: NodeJS.ProcessEnv): WakeJob | null {
  if (!ID_RE.test(id)) return null;
  try {
    const value = JSON.parse(readFileSync(jobPath(id, env), "utf8")) as unknown;
    return isWakeJob(value) ? value : null;
  } catch {
    return null;
  }
}

export function removeWakeJob(id: string, env?: NodeJS.ProcessEnv): void {
  if (!ID_RE.test(id)) return;
  try {
    unlinkSync(jobPath(id, env));
  } catch {
    // 已清理
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** 没回填 helperPid 的 job 多久算孤儿（helper 根本没起来）。 */
const ORPHAN_JOB_MS = 60_000;

/**
 * 清理死掉的 helper 留下的东西：job 文件，以及它登记过的回执 socket（helper 被 SIGKILL 时
 * 来不及删）。只删**登记在 job 里**的路径，且它必须还是一个属于本 uid 的 socket——
 * Claude 的 socket 目录里别的文件一概不碰。
 */
export function sweepWakeJobs(env: NodeJS.ProcessEnv = process.env, now = Date.now()): void {
  let files: string[];
  try {
    files = readdirSync(wakeJobsDir(env));
  } catch {
    return;
  }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const id = file.slice(0, -".json".length);
    const job = loadWakeJob(id, env);
    if (job === null) continue;
    if (job.helperPid === undefined) {
      if (now - Date.parse(job.created) > ORPHAN_JOB_MS) removeWakeJob(id, env);
      continue;
    }
    if (pidAlive(job.helperPid)) continue;
    if (job.replySock !== undefined && /\/[0-9a-f]{16}\.sock$/.test(job.replySock)) {
      try {
        const stat = lstatSync(job.replySock);
        if (stat.isSocket() && (typeof process.getuid !== "function" || stat.uid === process.getuid())) {
          unlinkSync(job.replySock);
        }
      } catch {
        // 已经没了
      }
    }
    removeWakeJob(id, env);
  }
}

let helperCommand: string[] | null = null;

/**
 * 登记「怎么把自己再跑一遍」。只有 ocs CLI 入口（cli.ts 的 main）会调用：helper 是 CLI 的内部
 * 子命令，别的宿主进程（把这些模块当库用的测试、嵌入方）argv 指向的不是 ocs，照着它 spawn
 * 会跑出完全无关的东西。没登记就没有 helper，唤醒走旧的无回执路径。
 */
export function setWakeHelperCommand(command: string[] | null): void {
  helperCommand = command === null ? null : [...command];
}

export function receiptsAvailable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") return false;
  const off = env[RECEIPTS_DISABLED_ENV];
  return !(typeof off === "string" && off !== "" && off !== "0");
}

function cliWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env[RECEIPT_CLI_WAIT_MS_ENV]);
  return Number.isInteger(raw) && raw >= 1 ? raw : RECEIPT_CLI_WAIT_MS;
}

export function parseFirstPhase(line: string): FirstPhase | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const r = value as Record<string, unknown>;
  if (r.kind === "plain") return { kind: "plain" };
  if (r.kind === "failed" && typeof r.reason === "string") {
    return { kind: "failed", reason: r.reason, ...(typeof r.detail === "string" ? { detail: r.detail } : {}) };
  }
  if (r.kind === "receipt" && typeof r.status === "string" && FIRST_STATUSES.has(r.status)) {
    return {
      kind: "receipt",
      status: r.status as "accepted" | PeerReceiptStatus,
      ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
    };
  }
  return null;
}

export interface TrackedWakeOptions {
  /** 终态没送达时通知谁；null 不通知（只记旁车帧）。 */
  sender: NoticeSender | null;
  env?: NodeJS.ProcessEnv;
  /** 测试注入。 */
  platform?: NodeJS.Platform;
  /** helper 的启动命令；缺省用 setWakeHelperCommand 登记的那个。 */
  command?: string[];
}

async function plainWake(session: NativeClaudeSession, input: WakeInput): Promise<TrackedWake> {
  const [outcome] = await wakeSessions([session], input);
  const result = outcome!.result;
  if (result.ok) return { kind: "plain" };
  return { kind: "failed", reason: result.reason, ...(result.detail === undefined ? {} : { detail: result.detail }) };
}

/**
 * 唤醒一个 Claude 会话并拿到第一阶段结果。回执可用时由 helper 写帧；不可用时等价于
 * wakeSessions（旧行为，返回 plain / failed）。
 */
export async function wakeClaudeTracked(
  session: NativeClaudeSession,
  input: WakeInput,
  options: TrackedWakeOptions,
): Promise<TrackedWake> {
  const env = options.env ?? input.env ?? process.env;
  const command = options.command ?? helperCommand;
  if (command === null || command.length === 0 || !receiptsAvailable(env, options.platform)) {
    return plainWake(session, { ...input, env });
  }
  const receiver = session.name ?? `pid-${session.pid}`;
  const job: WakeJob = {
    v: 1,
    id: randomUUID(),
    created: new Date().toISOString(),
    msgId: randomUUID(),
    target: { pid: session.pid, sessionId: session.sessionId, name: receiver },
    note: wakeNote({ ...input, receiver, implicitReceiver: true }),
    fromName: input.from,
    channel: input.channel,
    seq: input.seq,
    sender: options.sender,
    lang: input.lang ?? "en",
  };
  let child: ReturnType<typeof spawnDetached>;
  try {
    sweepWakeJobs(env);
    saveWakeJob(job, env);
    const [cmd, ...args] = command;
    child = spawnDetached(cmd!, [...args, WAKE_HELPER_COMMAND, job.id], {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...env },
    });
    // 命令不存在时 spawn 不抛、而是异步发 error：先挂一个监听，别让它变成未捕获异常。
    child.on("error", () => {});
    if (child.pid === undefined || child.stdout === null) throw new Error("helper did not start");
  } catch {
    // helper 没派出去 → 没有任何帧被写过，可以安全地在本进程走旧路径。
    removeWakeJob(job.id, env);
    return plainWake(session, { ...input, env });
  }
  const stdout = child.stdout!;
  const waitMs = cliWaitMs(env);
  const first = await new Promise<TrackedWake>((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (result: TrackedWake) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ kind: "unknown", detail: `no result from the wake helper within ${waitMs}ms` }),
      waitMs,
    );
    stdout.setEncoding("utf8");
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      finish(parseFirstPhase(buffer.slice(0, newline)) ?? { kind: "unknown", detail: "malformed wake helper result" });
    });
    // helper 没写结果就没了：spawn 出错（命令不存在）时帧肯定没写过，可以回落；
    // 已经跑起来再死的，帧写没写不知道——unknown，不重放。
    child.once("error", () => finish({ kind: "failed", reason: "helper-spawn-failed" }));
    stdout.once("close", () => finish({ kind: "unknown", detail: "wake helper exited without a result" }));
  });
  // 让 helper 脱离：不再读它的 stdout（它之后也不会再写），CLI 可以退出。
  stdout.removeAllListeners();
  stdout.destroy();
  child.removeAllListeners();
  child.on("error", () => {});
  child.unref();
  if (first.kind === "failed" && first.reason === "helper-spawn-failed") {
    removeWakeJob(job.id, env);
    return plainWake(session, { ...input, env });
  }
  return first;
}
