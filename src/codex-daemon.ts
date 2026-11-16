// Codex app-server 守护进程托管的会话：活性与寻址的第二条证据。
//
// 为什么需要（微信反馈 2026-11-10 / 11-13）：Codex CLI 0.16x 起终端 TUI 不再自己跑会话，而是
// 连本用户的 `codex app-server` 守护进程（`~/.codex/app-server-control/app-server-control.sock`）。
// 两个后果：
//   * 新开的会话在第一轮之前**没有 rollout 文件**，lsof 判活无从查起——statebar 已经显示
//     `ocs codex-<id>`，别的会话 dm 它却报「没有活会话」。
//   * rollout 由守护进程持有，不由 TUI 持有；持有方式随宿主版本变，单靠 lsof 会漏。
// 守护进程的 `thread/loaded/list` 直接回答「这个 thread 现在在不在内存里」。实测（daemon 0.163,
// CLI 0.167.2）：loaded 的 thread 收到 `codex queue` 会真的跑一轮——TUI 开着就在 TUI 里显示；
// TUI 已退出但 thread 仍 loaded 时，守护进程照样在后台跑完这一轮（rollout 里有回复）。
// 所以 loaded 证明的是「这条唤醒会被 agent 处理」，**不**证明有人正盯着终端——和 rollout
// 持有者那条证据的含义一样（守护进程在 TUI 退出后也继续持有 rollout）。
//
// 规矩：
//   * 只连 `trustedDaemonSocket` 认可的 socket（本用户、目录不许他人写），与 turn/steer 同一闸门。
//   * 只读：initialize → thread/loaded/list → thread/read。绝不 thread/resume、绝不 `queue --resume`
//     ——没 loaded 的 thread 不替用户拉起来。
//   * 任何失败（连不上、超时、应答畸形）= 没有这条证据（fail closed）。只读探测，可安全重试。
//   * ephemeral thread（宿主内部的标题生成等辅助线程）不是会话，不算。
//   * 传输进程 pid 取自守护进程自己写的 daemon.pid，且必须过 codex 二进制身份校验；校验不过
//     就不采信这条证据——投递后的复查要靠这个 pid。
//
// 热路径（解析、判活）是同步的，守护进程是异步 WebSocket：命令入口先 `primeCodexDaemon()`
// 拍一张快照，同步代码读快照。没拍过 = 空快照 = 没有证据。

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { codexSessionsRoot, isCodexThreadId, listCodexRolloutFiles } from "./codex-sessions.ts";
import { codexDaemonSocketPath, DaemonConnection, trustedDaemonSocket } from "./codex-steer.ts";
import { isCodexRolloutHolder, type PsEntry } from "./codex-queue.ts";

/** 连接 + 每个请求的预算。只读探测，卡住就当没有证据。 */
export const CODEX_DAEMON_PROBE_TIMEOUT_MS = 1500;
/** 单次最多对这么多条 loaded thread 补读元数据（防御：正常只有个位数没有 rollout）。 */
const MAX_THREAD_READS = 32;

export interface CodexDaemonThread {
  threadId: string;
  /** 守护进程报的工作目录；读不到为 null。 */
  cwd: string | null;
}

export interface CodexDaemonSnapshot {
  /** 守护进程 pid（已过 codex 身份校验）。null = 没有可信的传输进程，快照不采信。 */
  pid: number | null;
  /** loaded 且非 ephemeral 的 thread（小写完整 id）。 */
  threads: Map<string, CodexDaemonThread>;
}

const EMPTY: CodexDaemonSnapshot = { pid: null, threads: new Map() };
let snapshot: CodexDaemonSnapshot = EMPTY;

/** 当前快照（同步读）。pid 为 null 时一律当作没有 loaded thread。 */
export function codexDaemonSnapshot(): CodexDaemonSnapshot {
  return snapshot.pid === null ? EMPTY : snapshot;
}

/** 测试用：直接放一张快照 / 清空。 */
export function setCodexDaemonSnapshot(next: CodexDaemonSnapshot | null): void {
  snapshot = next ?? EMPTY;
}

/** 这个 thread 在守护进程里 loaded（且快照可信）时返回守护进程 pid。 */
export function codexDaemonLoadedPid(threadId: string): number | null {
  const current = codexDaemonSnapshot();
  return current.threads.has(threadId.toLowerCase()) ? current.pid : null;
}

function codexHome(env: NodeJS.ProcessEnv): string {
  const configured = env.CODEX_HOME?.trim();
  return configured !== undefined && configured !== "" ? configured : join(homedir(), ".codex");
}

/**
 * 守护进程自报的 pid（`$CODEX_HOME/app-server-daemon/daemon.pid` 的 `pid` 字段），过身份校验：
 * 进程必须是 codex / codex-cxs 二进制（或挂在它下面）。文件格式变了、pid 复用成别的进程，
 * 都返回 null。
 */
export function codexDaemonPid(
  env: NodeJS.ProcessEnv = process.env,
  table?: ReadonlyMap<number, PsEntry>,
): number | null {
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(join(codexHome(env), "app-server-daemon", "daemon.pid"), "utf8")) as { pid?: unknown }).pid;
  } catch {
    return null;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return null;
  return isCodexRolloutHolder(pid, table ?? processChain(pid)) ? pid : null;
}

/**
 * 只查这一个 pid 往上的祖先链（每跳一次 `ps -p`）。全机 `ps -A` 实测 230ms，而守护进程
 * 通常一跳就到（ppid=1、自己就是 codex），每条 dm/send 都付全表的钱不值。
 */
function processChain(pid: number): Map<number, PsEntry> {
  const table = new Map<number, PsEntry>();
  let cursor = pid;
  for (let hop = 0; hop < 12 && cursor > 1 && !table.has(cursor); hop++) {
    const probe = spawnSync("ps", ["-o", "ppid=,tty=,comm=", "-p", String(cursor)], {
      encoding: "utf8",
      timeout: CODEX_DAEMON_PROBE_TIMEOUT_MS,
      env: { ...process.env, PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/bin" },
    });
    const match = /^\s*(\d+)\s+(\S+)\s+(.*?)\s*$/.exec(probe.stdout ?? "");
    if (match === null) break;
    const entry: PsEntry = { ppid: Number(match[1]), tty: match[2]!, comm: match[3]! };
    table.set(cursor, entry);
    if (["codex", "codex-cxs"].includes(entry.comm.split("/").pop() ?? "")) break;
    cursor = entry.ppid;
  }
  return table;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * 问一次守护进程，返回快照（不改全局）。失败返回空快照。
 * 有 rollout 的 thread 只确认 loaded（元数据从 rollout 头读；ephemeral 本来就不落盘）；
 * 没有 rollout 的要补读 cwd 并确认 `ephemeral:false`。
 */
export async function probeCodexDaemon(options: {
  env?: NodeJS.ProcessEnv;
  /** 本机已有 rollout 文件的 thread（小写）；不在其中的 loaded thread 要补读元数据。缺省现场列目录。 */
  rolloutThreadIds?: ReadonlySet<string>;
  /** 测试注入：守护进程 pid 的来源。 */
  daemonPid?: () => number | null;
  timeoutMs?: number;
}): Promise<CodexDaemonSnapshot> {
  const env = options.env ?? process.env;
  const timeout = options.timeoutMs ?? CODEX_DAEMON_PROBE_TIMEOUT_MS;
  const path = trustedDaemonSocket(codexDaemonSocketPath(env));
  if (path === null) return EMPTY;
  const pid = (options.daemonPid ?? (() => codexDaemonPid(env)))();
  if (pid === null) return EMPTY;
  let conn: DaemonConnection;
  try {
    conn = await DaemonConnection.open(path, timeout);
  } catch {
    return EMPTY;
  }
  try {
    const init = await conn.request(
      "initialize",
      { clientInfo: { name: "ocs", title: null, version: "1" }, capabilities: { experimentalApi: true } },
      timeout,
    );
    if (init.error !== undefined) return EMPTY;
    conn.send({ method: "initialized" });
    const loaded: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const response = await conn.request("thread/loaded/list", cursor === null ? {} : { cursor }, timeout);
      const result = record(response.result);
      if (result === null || !Array.isArray(result.data)) return EMPTY;
      for (const id of result.data) if (typeof id === "string" && isCodexThreadId(id)) loaded.push(id.toLowerCase());
      cursor = typeof result.nextCursor === "string" && result.nextCursor !== "" ? result.nextCursor : null;
      if (cursor === null) break;
    }
    const threads = new Map<string, CodexDaemonThread>();
    const withRollout = options.rolloutThreadIds ??
      new Set(listCodexRolloutFiles(codexSessionsRoot(env)).map((file) => file.threadId));
    let reads = 0;
    for (const threadId of loaded) {
      if (withRollout.has(threadId)) {
        threads.set(threadId, { threadId, cwd: null });
        continue;
      }
      if (reads++ >= MAX_THREAD_READS) continue; // 读不到元数据的不采信
      let thread: Record<string, unknown> | null;
      try {
        thread = record(record((await conn.request("thread/read", { threadId }, timeout)).result)?.thread);
      } catch {
        continue;
      }
      // 只认明确的 ephemeral:false；字段缺失/畸形不采信（宿主内部辅助线程就是 ephemeral）。
      if (thread === null || thread.ephemeral !== false) continue;
      threads.set(threadId, { threadId, cwd: typeof thread.cwd === "string" ? thread.cwd : null });
    }
    return { pid, threads };
  } catch {
    return EMPTY;
  } finally {
    conn.close();
  }
}

/** 命令入口调用：问一次守护进程并替换全局快照。永不抛错。 */
export async function primeCodexDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if (process.platform === "win32") return; // Windows 的 Codex 走 Desktop IPC（铁律 10）
  try {
    snapshot = await probeCodexDaemon({ env });
  } catch {
    snapshot = EMPTY;
  }
}
