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
