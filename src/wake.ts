// 唤醒：把「频道有新消息」的指针注入目标 Claude 会话。
//
// 承袭上游指针模式：注入载荷 ≤512 字节，只带 channel+seq 指针和一条读取命令，
// 正文永远由被唤醒方回频道日志重读——防 ps 泄露、防截断、防注入正文被当指令。
// 送达语义同上游：ok:true 只代表帧进了收件箱 socket，接收端 crossSessionInbound
// 默认 hold（5 分钟无人 Deliver 即丢）。`ocs doctor` 负责引导用户把它设为 accept。

import { Buffer } from "node:buffer";
import {
  injectChannelMessage,
  listNativeSessions,
  type InjectResult,
  type NativeClaudeSession,
} from "./claude-inject.ts";
import {
  CodexDesktopIpcClient,
  CodexDesktopIpcRequestError,
  CodexDesktopIpcUnavailableError,
  CodexDesktopIpcUnknownOutcomeError,
  codexDesktopIpcAvailable,
} from "./codex-ipc.ts";
import { codexSessionsRoot, isCodexThreadId, listCodexSessions } from "./codex-sessions.ts";

export const WAKE_NOTE_MAX_BYTES = 512;

export type WakeLang = "en" | "zh";

export function wakeNote(channel: string, seq: number, from: string, lang: WakeLang = "en"): string {
  const note = lang === "zh"
    ? `[open-cross-session] 频道 #${channel} 有来自 ${from} 的新消息（seq ${seq}）。` +
      `请运行 \`ocs read ${channel} --as <你的名字>\` 读取并处理；` +
      `回复用 \`ocs send ${channel} "<正文>" --as <你的名字>\`。`
    : `[open-cross-session] New message from ${from} in #${channel} (seq ${seq}). ` +
      `Run \`ocs read ${channel} --as <your-name>\` to read and handle it; ` +
      `reply with \`ocs send ${channel} "<text>" --as <your-name>\`.`;
  if (Buffer.byteLength(note, "utf8") > WAKE_NOTE_MAX_BYTES) {
    throw new Error("wake note exceeds 512 bytes"); // 构造恒定，超限属编程错误
  }
  return note;
}

export interface WakeTargetSelection {
  targets: NativeClaudeSession[];
  /** 被排除的自身会话 pid（防自我唤醒回环）。 */
  excludedSelf: number[];
}

/**
 * mention 分流：形如 codex thread id（uuid）的 @ 走 ChatGPT Desktop IPC，
 * 其余按 Claude 原生会话名匹配。用户直觉是「@ 谁就唤谁」，不该要求记两套语法。
 */
export function splitWakeMentions(mentions: readonly string[]): {
  claudeNames: string[];
  codexThreads: string[];
} {
  const claudeNames: string[] = [];
  const codexThreads: string[] = [];
  for (const mention of mentions) {
    (isCodexThreadId(mention) ? codexThreads : claudeNames).push(mention);
  }
  return { claudeNames, codexThreads };
}

/**
 * 沿进程祖先链找到本进程所属的 Claude 会话 pid（`~/.claude/sessions/<pid>.json` 存在
 * 即命中）。ocs 通常经由 Claude 的 Bash 工具调用，`process.ppid` 是中间 shell 而非
 * Claude 本体——拿它做自我排除形同虚设（真机验证过：自 @ 自己会真的注入回环）。
 */
export function findSelfClaudePid(
  env: NodeJS.ProcessEnv = process.env,
  maxHops = 10,
): number | null {
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const alive = new Set(listNativeSessions(env).map((s) => s.pid));
  let pid = process.pid;
  for (let hop = 0; hop < maxHops; hop++) {
    const out = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    const parent = Number(out.stdout.trim());
    if (!Number.isInteger(parent) || parent <= 1) return null;
    if (alive.has(parent)) return parent;
    pid = parent;
  }
  return null;
}

/**
 * 目标选择：mentions 与本机活 Claude 原生会话名求交集。
 * - 排除 selfPids（发送方自己所在的会话，通常传 [process.ppid]）。
 * - 同名多会话不消歧、全部命中（本地个人场景下同名即同人多开，都该被叫醒）。
 */
export function selectWakeTargets(
  mentions: readonly string[],
  options: { selfPids?: readonly number[]; env?: NodeJS.ProcessEnv } = {},
): WakeTargetSelection {
  const selfPids = new Set(options.selfPids ?? []);
  const wanted = new Set(mentions);
  const targets: NativeClaudeSession[] = [];
  const excludedSelf: number[] = [];
  for (const session of listNativeSessions(options.env)) {
    if (session.name === null || !wanted.has(session.name)) continue;
    if (selfPids.has(session.pid)) {
      excludedSelf.push(session.pid);
      continue;
    }
    targets.push(session);
  }
  return { targets, excludedSelf };
}

export interface WakeOutcome {
  session: NativeClaudeSession;
  result: InjectResult;
}

export async function wakeSessions(
  targets: readonly NativeClaudeSession[],
  input: { channel: string; seq: number; from: string; lang?: WakeLang; env?: NodeJS.ProcessEnv },
): Promise<WakeOutcome[]> {
  const outcomes: WakeOutcome[] = [];
  for (const session of targets) {
    const result = await injectChannelMessage({
      name: session.name ?? `pid-${session.pid}`,
      pid: session.pid,
      sessionId: session.sessionId,
      body: wakeNote(input.channel, input.seq, input.from, input.lang),
      fromName: input.from,
      env: input.env,
    });
    outcomes.push({ session, result });
  }
  return outcomes;
}

// ───────────────────────── Codex / ChatGPT Desktop 侧 ─────────────────────────

export type CodexWakeResult =
  | { ok: true; turnId: string; targetThreadId: string; sourceThreadId: string }
  | { ok: false; reason: "unavailable" | "bad-thread-id" | "no-source" | "route-mismatch" | "failed" | "unknown-outcome"; detail?: string };

/**
 * source thread 候选：Desktop IPC 的 `thread-follower-start-turn` 需要一个 source 任务
 * （UI 里显示「来自任务 X 的消息」）。未显式指定时按 rollout 新旧序逐个当候选——
 * rollout 存在 ≠ 在 Desktop 里开着，谁能用要靠 owner 探测逐个试。
 */
/**
 * owner 探测异常分类（review #13）：只有「明确无 renderer 认领」才算 not-open，
 * 超时/断连/协议错误是 transport——把传输故障说成「任务没开」会误导用户去开任务。
 */
function classifyOwnerError(error: unknown): "not-open" | "transport" {
  if (error instanceof CodexDesktopIpcUnavailableError && error.message.includes("No ChatGPT renderer owns")) {
    return "not-open";
  }
  if (error instanceof CodexDesktopIpcRequestError && error.message.includes("no-client-found")) {
    return "not-open";
  }
  return "transport";
}

export function listCodexSourceCandidates(
  targetThreadId: string,
  env: NodeJS.ProcessEnv = process.env,
  limit = 50, // review #12：唯一开着的 source 可能比最近 10 个已关闭 rollout 更老
): string[] {
  const wanted = targetThreadId.toLowerCase();
  return listCodexSessions(codexSessionsRoot(env), { limit: limit + 1 })
    .map((s) => s.threadId)
    .filter((t) => t.toLowerCase() !== wanted)
    .slice(0, limit);
}

/** 兼容旧签名：最近的一个非目标 rollout（不保证在 Desktop 里开着）。 */
export function pickCodexSourceThread(
  targetThreadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  return listCodexSourceCandidates(targetThreadId, env, 1)[0] ?? null;
}

/**
 * 唤醒一个 ChatGPT Desktop task（#1012 同款机制的 ocs 版）。
 * 路由校验替代上游注册表判据：source 与 target 必须由**同一个 renderer**（同 clientId）
 * 拥有——两次 discoverThreadOwner 结果比对，不一致即拒投（route-mismatch）。
 * 送达语义：ok 表示 renderer 接受了 turn（拿到 turnId）；unknown-outcome 表示帧已写出
 * 但结果未知——**绝不重放**（上游铁律），交由调用方自行核对。
 */
export async function wakeCodexTask(input: {
  targetThreadId: string;
  sourceThreadId?: string;
  channel: string;
  seq: number;
  from: string;
  lang?: WakeLang;
  env?: NodeJS.ProcessEnv;
}): Promise<CodexWakeResult> {
  const env = input.env ?? process.env;
  if (!isCodexThreadId(input.targetThreadId)) {
    return { ok: false, reason: "bad-thread-id", detail: input.targetThreadId };
  }
  if (!codexDesktopIpcAvailable(env)) {
    return { ok: false, reason: "unavailable", detail: "ChatGPT Desktop IPC socket unavailable (is the Desktop app running?)" };
  }
  if (input.sourceThreadId !== undefined &&
      (!isCodexThreadId(input.sourceThreadId) ||
        input.sourceThreadId.toLowerCase() === input.targetThreadId.toLowerCase())) {
    return { ok: false, reason: "bad-thread-id", detail: input.sourceThreadId };
  }
  const client = new CodexDesktopIpcClient({ env });
  try {
    await client.connect();
    // 分开探测、准确归因：target 探不到就是 target 没开，绝不把 source 的问题算到它头上。
    let targetOwner: string;
    try {
      targetOwner = await client.discoverThreadOwner(input.targetThreadId);
    } catch (error) {
      return classifyOwnerError(error) === "not-open"
        ? {
            ok: false,
            reason: "failed",
            detail: `target task ${input.targetThreadId} is not open in ChatGPT Desktop (IPC only reaches open tasks)`,
          }
        : {
            ok: false,
            reason: "failed",
            detail: `IPC error while discovering target owner: ${String(error)}`,
          };
    }
    // source：显式指定则严格校验；自动选择则逐候选试探，跳过没开着的 rollout。
    let sourceThreadId: string;
    if (input.sourceThreadId !== undefined) {
      let sourceOwner: string;
      try {
        sourceOwner = await client.discoverThreadOwner(input.sourceThreadId);
      } catch (error) {
        return classifyOwnerError(error) === "not-open"
          ? {
              ok: false,
              reason: "failed",
              detail: `source task ${input.sourceThreadId} is not open in ChatGPT Desktop`,
            }
          : {
              ok: false,
              reason: "failed",
              detail: `IPC error while discovering source owner: ${String(error)}`,
            };
      }
      if (sourceOwner !== targetOwner) {
        return {
          ok: false,
          reason: "route-mismatch",
          detail: `source and target belong to different renderers (${sourceOwner} != ${targetOwner})`,
        };
      }
      sourceThreadId = input.sourceThreadId;
    } else {
      let picked: string | null = null;
      for (const candidate of listCodexSourceCandidates(input.targetThreadId, env)) {
        try {
          if ((await client.discoverThreadOwner(candidate)) === targetOwner) {
            picked = candidate;
            break;
          }
        } catch (error) {
          // 只有「确实没开」才跳过继续；传输故障必须中止并如实报告（review #13），
          // 否则会把断连/超时伪装成 no-source。
          if (classifyOwnerError(error) === "transport") {
            return {
              ok: false,
              reason: "failed",
              detail: `IPC error while probing source candidates: ${String(error)}`,
            };
          }
        }
      }
      if (picked === null) {
        return {
          ok: false,
          reason: "no-source",
          detail: "no second open task under the same Desktop to act as source (open another task, or pass --codex-source)",
        };
      }
      sourceThreadId = picked;
    }
    const prompt = wakeNote(input.channel, input.seq, input.from, input.lang);
    const { turnId } = await client.startDelegatedTurn({
      targetThreadId: input.targetThreadId,
      sourceThreadId,
      prompt,
      clientUserMessageId: crypto.randomUUID(),
    });
    return { ok: true, turnId, targetThreadId: input.targetThreadId, sourceThreadId };
  } catch (error) {
    if (error instanceof CodexDesktopIpcUnknownOutcomeError) {
      return { ok: false, reason: "unknown-outcome", detail: error.message };
    }
    const text = String(error);
    if (text.includes("no-client-found") || text.includes("No ChatGPT renderer owns")) {
      return {
        ok: false,
        reason: "failed",
        detail: "target task is not open in ChatGPT Desktop (check `ocs codex-sessions`, then open it in the Desktop app)",
      };
    }
    return { ok: false, reason: "failed", detail: text };
  } finally {
    client.close();
  }
}
