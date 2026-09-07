// Codex 官方跨会话通道：`codex queue --thread <id> --message <text>`。
//
// 为什么这条路优先于 ChatGPT Desktop IPC 和 cmux 按键注入：
//   * `codex queue` 是公开的 CLI 表面，按 thread UUID 精确寻址，不碰终端、不模拟按键，
//     也不要求目标被 Desktop renderer 认领——终端里裸跑的 codex TUI 一样能收到。
//   * Desktop IPC（codex-ipc.ts）是 ChatGPT.app 的私有协议（铁律 5），宿主升级可能破；
//     cmux 注入要求用户装 cmux，且靠 `codex-<8hex>` 标题正则匹配，都是绕路。
// 实测（v0.153.4）：往 tmux 里一个纯终端 codex TUI queue 一条消息，TUI 真的跑了那一轮。
// 不需要 `codex app-server daemon start`（那条命令另外要求官方 standalone 安装）。
//
// 送达语义 —— 与铁律 4（Claude 注入 ok ≠ 已送达）同构，而且更严格:
//   `codex queue` 是往 thread store 写待处理输入，**不是投递**。目标会话已经退出时它
//   照样 exit=0 并打印 "Queued message …"。所以活性判断必须由我们自己做，绝不能拿
//   queue 的退出码清欠账。活性证据取 rollout 文件的持有者：活着的 codex 进程一直
//   打开着自己的 rollout，`lsof -t <rollout>` 拿到 pid 即为在跑（终端/Desktop 通用，
//   比标题匹配和 renderer 认领都硬）。
//
// 超时/信号杀死一律记 unknown-outcome：帧可能已写进 store（铁律 5，绝不重放）。

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { isCodexThreadId, listCodexRolloutFiles, codexSessionsRoot } from "./codex-sessions.ts";

/** `codex --version` 探测预算。 */
export const CODEX_CLI_PROBE_TIMEOUT_MS = 3000;
/** `codex queue` 预算：要连 thread store，比纯探测宽。 */
export const CODEX_QUEUE_TIMEOUT_MS = 20_000;
/** `lsof` 预算：单文件查询，很快；卡住就当查不到（fail closed）。 */
export const CODEX_LSOF_TIMEOUT_MS = 4000;

export type CodexQueueResult =
  | { ok: true; messageId: string | null; threadId: string; pid: number }
  | {
      ok: false;
      reason: "unavailable" | "bad-thread-id" | "not-live" | "failed" | "unknown-outcome";
      detail?: string;
    };

let cliProbeCache: boolean | null = null;

/** 测试用：清掉 `codex` CLI 可用性缓存。 */
export function resetCodexCliProbeCache(): void {
  cliProbeCache = null;
}

/**
 * 本机有没有可用的 `codex` CLI。只探一次并缓存——send 路径上每个 codex 目标都会问。
 * 探 `queue --help` 而不是 `--version`：老版本有 codex 但没有 queue 子命令，我们要的是
 * 「这条通道在不在」，不是「codex 在不在」。
 */
export function codexQueueAvailable(env: NodeJS.ProcessEnv = process.env): boolean {
  if (cliProbeCache !== null) return cliProbeCache;
  const probe = spawnSync("codex", ["queue", "--help"], {
    encoding: "utf8",
    timeout: CODEX_CLI_PROBE_TIMEOUT_MS,
    env,
  });
  cliProbeCache = probe.status === 0 && (probe.stdout ?? "").includes("--thread");
  return cliProbeCache;
}

/** 该 thread 的 rollout 文件路径（thread id 就是 rollout 文件名里的 UUID）。 */
export function codexRolloutPath(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (!isCodexThreadId(threadId)) return null;
  const wanted = threadId.toLowerCase();
  return listCodexRolloutFiles(codexSessionsRoot(env))
    .find((file) => file.threadId === wanted)?.path ?? null;
}

/**
 * 活性证据：拿着这个 thread 的 rollout 文件的进程 pid。
 * 活着的 codex 会话（终端 TUI 或 Desktop 任务）全程持有自己的 rollout fd；会话退出后
 * 没人持有。查不到就是查不到——宁可判死也不要往死会话投递（fail closed）。
 */
export function codexThreadLivePid(
  threadId: string,
  env: NodeJS.ProcessEnv = process.env,
): number | null {
  const path = codexRolloutPath(threadId, env);
  if (path === null) return null;
  const probe = spawnSync("lsof", ["-t", "--", realpathOrSelf(path)], {
    encoding: "utf8",
    timeout: CODEX_LSOF_TIMEOUT_MS,
    env: lsofEnv(env),
  });
  // lsof 没命中时 status=1 且无输出，这是正常的「不在跑」，不是错误。
  const pid = Number((probe.stdout ?? "").split("\n").map((l) => l.trim()).find((l) => l !== ""));
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * 批量版活性探测：一次 lsof 查多个 thread，给 `ocs who` 用（逐个 spawn 会把 who 拖慢）。
 * `lsof -F pn` 逐文件输出 `p<pid>` / `n<path>`；部分文件无人持有时 lsof 退 1，这是正常
 * 结果不是错误，只按输出解析。
 */
export function codexThreadLivePids(
  threadIds: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Map<string, number> {
  const live = new Map<string, number>();
  const byPath = new Map<string, string>();
  for (const id of threadIds) {
    const path = codexRolloutPath(id, env);
    // lsof 报的是解析过符号链接的真实路径（macOS 的 /var/folders → /private/var/folders），
    // 按原始路径匹配会全部落空。
    if (path !== null) byPath.set(realpathOrSelf(path), id.toLowerCase());
  }
  if (byPath.size === 0) return live;
  const probe = spawnSync("lsof", ["-F", "pn", "--", ...byPath.keys()], {
    encoding: "utf8",
    timeout: CODEX_LSOF_TIMEOUT_MS,
    env: lsofEnv(env),
  });
  let pid: number | null = null;
  for (const line of (probe.stdout ?? "").split("\n")) {
    if (line.startsWith("p")) {
      const parsed = Number(line.slice(1));
      pid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } else if (line.startsWith("n") && pid !== null) {
      const id = byPath.get(line.slice(1));
      if (id !== undefined && !live.has(id)) live.set(id, pid);
    }
  }
  return live;
}

/**
 * lsof 是系统工具，跟 `codex` CLI 在不在 PATH 上无关：调用方传进来的 env 可能是只带
 * CODEX_HOME 的最小环境，用它去找 lsof 会 ENOENT。这里固定用进程自己的 PATH。
 */
function lsofEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/bin" };
}

function realpathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const QUEUED_ID_RE = /Queued message ([0-9a-f-]{36})/i;

/**
 * 把一条唤醒载荷 queue 给指定 thread。
 * 只在确认目标活着之后才真的发（见文件头「送达语义」）；`livePid` 可由调用方传入以
 * 复用已经做过的活性探测，省一次 lsof。
 */
export function queueCodexThread(input: {
  threadId: string;
  prompt: string;
  env?: NodeJS.ProcessEnv;
  /** 已知的活进程 pid；不传则现场探测。 */
  livePid?: number;
}): CodexQueueResult {
  const env = input.env ?? process.env;
  const threadId = input.threadId.toLowerCase();
  if (!isCodexThreadId(threadId)) return { ok: false, reason: "bad-thread-id", detail: input.threadId };
  if (!codexQueueAvailable(env)) {
    return {
      ok: false,
      reason: "unavailable",
      detail: "`codex queue` unavailable (no codex CLI on PATH, or too old to have the subcommand)",
    };
  }
  const pid = input.livePid ?? codexThreadLivePid(threadId, env);
  if (pid === null) {
    return {
      ok: false,
      reason: "not-live",
      detail:
        `no live process holds the rollout for thread ${threadId}; ` +
        `\`codex queue\` would write to the thread store with nobody to read it`,
    };
  }
  const proc = spawnSync("codex", ["queue", "--thread", threadId, "--message", input.prompt], {
    encoding: "utf8",
    timeout: CODEX_QUEUE_TIMEOUT_MS,
    env,
  });
  // 超时/被信号杀死：帧可能已经写进 thread store，结果未知——如实上报，绝不重放。
  if (proc.error !== undefined || proc.signal !== null) {
    return {
      ok: false,
      reason: "unknown-outcome",
      detail: `codex queue did not report an outcome (${proc.signal ?? String(proc.error)})`,
    };
  }
  if (proc.status !== 0) {
    return {
      ok: false,
      reason: "failed",
      detail: (proc.stderr ?? proc.stdout ?? "").trim() || `codex queue exited ${proc.status}`,
    };
  }
  const messageId = QUEUED_ID_RE.exec(proc.stdout ?? "")?.[1] ?? null;
  return { ok: true, messageId, threadId, pid };
}
