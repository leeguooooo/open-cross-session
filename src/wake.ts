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
  CodexDesktopIpcUnknownOutcomeError,
  codexDesktopIpcAvailable,
} from "./codex-ipc.ts";
import { codexSessionsRoot, isCodexThreadId, listCodexSessions } from "./codex-sessions.ts";

export const WAKE_NOTE_MAX_BYTES = 512;

export function wakeNote(channel: string, seq: number, from: string): string {
  const note =
    `[open-cross-session] 频道 #${channel} 有来自 ${from} 的新消息（seq ${seq}）。` +
    `请运行 \`ocs read ${channel} --as <你的名字>\` 读取并处理；` +
    `回复用 \`ocs send ${channel} "<正文>" --as <你的名字>\`。`;
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
  input: { channel: string; seq: number; from: string; env?: NodeJS.ProcessEnv },
): Promise<WakeOutcome[]> {
  const outcomes: WakeOutcome[] = [];
  for (const session of targets) {
    const result = await injectChannelMessage({
      name: session.name ?? `pid-${session.pid}`,
      pid: session.pid,
      sessionId: session.sessionId,
      body: wakeNote(input.channel, input.seq, input.from),
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
 * 选 source thread：Desktop IPC 的 `thread-follower-start-turn` 需要一个 source 任务
 * （UI 里显示「来自任务 X 的消息」）。未显式指定时，取最近的一个非目标 rollout thread。
 */
export function pickCodexSourceThread(
  targetThreadId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const wanted = targetThreadId.toLowerCase();
  for (const session of listCodexSessions(codexSessionsRoot(env), { limit: 20 })) {
    if (session.threadId.toLowerCase() !== wanted) return session.threadId;
  }
  return null;
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
  env?: NodeJS.ProcessEnv;
}): Promise<CodexWakeResult> {
  const env = input.env ?? process.env;
  if (!isCodexThreadId(input.targetThreadId)) {
    return { ok: false, reason: "bad-thread-id", detail: input.targetThreadId };
  }
  if (!codexDesktopIpcAvailable(env)) {
    return { ok: false, reason: "unavailable", detail: "ChatGPT Desktop IPC socket 不可用（Desktop 没开？）" };
  }
  const sourceThreadId = input.sourceThreadId ?? pickCodexSourceThread(input.targetThreadId, env);
  if (sourceThreadId === null) {
    return { ok: false, reason: "no-source", detail: "没有第二个 codex task 可作为 source（IPC 需要成对任务）" };
  }
  if (!isCodexThreadId(sourceThreadId) || sourceThreadId.toLowerCase() === input.targetThreadId.toLowerCase()) {
    return { ok: false, reason: "bad-thread-id", detail: sourceThreadId };
  }
  const client = new CodexDesktopIpcClient({ env });
  try {
    await client.connect();
    const [targetOwner, sourceOwner] = await Promise.all([
      client.discoverThreadOwner(input.targetThreadId),
      client.discoverThreadOwner(sourceThreadId),
    ]);
    if (targetOwner !== sourceOwner) {
      return {
        ok: false,
        reason: "route-mismatch",
        detail: `source 与 target 不属于同一个 renderer（${sourceOwner} ≠ ${targetOwner}）`,
      };
    }
    const prompt = wakeNote(input.channel, input.seq, input.from);
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
    return { ok: false, reason: "failed", detail: String(error) };
  } finally {
    client.close();
  }
}
