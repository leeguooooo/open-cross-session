// 交回结果：`send/dm --notify-when-idle` 触发 idle 时，把目标处理这条唤醒的那一轮的最终回复
// 一并带回给订阅方（docs/wake-protocol.md §2.1）。
//
// 证据只来自目标会话自己的 transcript（与 seen-wakes 同一来源、同一套文件校验），不装钩子、
// 不改用户设置。宁可不带结果，也不带错的结果——下列情况一律返回 null，只发原来的空闲通知：
//   * 记录里找不到这条唤醒进入对话（被扣留、被拒、超出尾窗、会话换了）；
//   * 唤醒之后、回合结束之前出现了真人输入（排队输入、打断、/命令）：最后那段话可能是在回答用户；
//   * 唤醒之后还没有 `end_turn` 的 assistant 消息（中断、还在写盘）；
//   * 子代理（sidechain）的记录一律不看。
// 唤醒在回合中途被并进正在跑的那一轮时，结果就是那一轮的结尾——它包含唤醒前已在做的事，
// 这是宿主的语义，通知里照实说「那一轮的最后回复」。
//
// 结果是对方会话可控的数据：调用方必须 neutralizeWakeBody 并明确框成引文（铁律 7 / 10）。

import { conversationTexts, parseSeenWake, readRecordTail, sessionRecordPath } from "./seen-wakes.ts";

export interface WakeRef {
  channel: string;
  seq: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** 这条记录带进对话的文本里，有没有指定的唤醒；`other` = 有不是任何唤醒的输入（真人输入）。 */
function classifyInput(rec: Record<string, unknown>, wake: WakeRef): "match" | "wake" | "other" | "none" {
  const { texts, wrapper } = conversationTexts("claude", rec);
  const all = [...texts];
  // 数组形态的 user 文本（如 "[Request interrupted by user]"）也算输入；tool_result 不算。
  const message = record(rec.message);
  if (rec.type === "user" && message?.role === "user" && Array.isArray(message.content)) {
    for (const part of message.content) {
      const p = record(part);
      if (p?.type === "text" && typeof p.text === "string") all.push(p.text);
    }
  }
  if (all.length === 0) return "none";
  let sawWake = false;
  for (const text of all) {
    const hit = parseSeenWake(text, { allowWrapper: wrapper || rec.type === "user", allowTruncated: true });
    // 宿主自己生成的 isMeta 输入（钩子、系统提示）不是真人输入。
    if (hit === null) {
      if (rec.isMeta === true) continue;
      return "other";
    }
    if (hit.channel === wake.channel && hit.seq === wake.seq) return "match";
    sawWake = true;
  }
  return sawWake ? "wake" : "none";
}

/** transcript 行 → 处理这条唤醒的那一轮的最终回复文本；证据不足返回 null。 */
export function claudeTurnResultInLines(lines: readonly string[], wake: WakeRef): string | null {
  const records: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    try {
      const rec = record(JSON.parse(line));
      if (rec !== null && rec.isSidechain !== true) records.push(rec);
    } catch {
      continue;
    }
  }
  let start = -1;
  for (let i = 0; i < records.length; i++) {
    if (classifyInput(records[i]!, wake) === "match") start = i;
  }
  if (start < 0) return null;
  for (let i = start + 1; i < records.length; i++) {
    const rec = records[i]!;
    if (classifyInput(rec, wake) === "other") return null;
    if (rec.type !== "assistant") continue;
    const message = record(rec.message);
    if (message?.stop_reason !== "end_turn") continue;
    const id = message.id;
    // 一条 assistant 消息按内容块拆成多行记录，共用 message.id。
    const texts: string[] = [];
    for (let j = start + 1; j < records.length; j++) {
      const m = record(records[j]!.message);
      if (records[j]!.type !== "assistant" || m === null || m.id !== id || !Array.isArray(m.content)) continue;
      for (const part of m.content) {
        const p = record(part);
        if (p?.type === "text" && typeof p.text === "string") texts.push(p.text);
      }
    }
    const text = texts.join("\n\n").trim();
    return text === "" ? null : text;
  }
  return null;
}

/** 读目标会话的 transcript 尾部取结果。 */
export function claudeTurnResult(sessionId: string | null, wake: WakeRef, env: NodeJS.ProcessEnv = process.env): string | null {
  if (sessionId === null) return null;
  const path = sessionRecordPath({ kind: "claude", sessionId }, env);
  return path === null ? null : claudeTurnResultInLines(readRecordTail(path), wake);
}
