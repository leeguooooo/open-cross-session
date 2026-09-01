#!/usr/bin/env bun
// ocs — open-cross-session CLI（M1：send / read / sessions / watch）。
//
// 命令面刻意贴近上游 party CLI 的使用习惯，降低将来 `ocs upgrade` 迁到托管版的心智成本。

import { statSync } from "node:fs";
import { listNativeSessions } from "./claude-inject.ts";
import {
  appendMessage,
  channelLogPath,
  lastSeq,
  loadCursor,
  readMessages,
  saveCursor,
  NAME_RE,
} from "./store.ts";
import { selectWakeTargets, wakeSessions } from "./wake.ts";

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(key, next);
        i++;
      } else {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`ocs: ${message}`);
  process.exit(1);
}

function requireString(parsed: Parsed, flag: string): string {
  const value = parsed.flags.get(flag);
  if (typeof value !== "string" || value === "") fail(`--${flag} <value> is required`);
  return value;
}

function printMessage(m: { seq: number; ts: string; from: string; body: string }): void {
  console.log(`#${m.seq} ${m.ts} <${m.from}> ${m.body}`);
}

const HELP = `ocs — 跨 agent 的 cross-session，本机直连，零服务器

用法:
  ocs send <channel> <body> --as <name> [--reply-to <seq>] [--no-wake]
      追加消息到本机频道日志；body 里 @<会话名> 会注入唤醒指针到对应活 Claude 会话
  ocs read <channel> --as <name> [--since <seq>] [--json] [--peek]
      从上次游标（或 --since）读新消息并推进游标；--peek 只读不推进
  ocs sessions
      列出本机活着的 Claude 原生会话（@ 目标就是这里的 name）
  ocs watch <channel> [--interval-ms <n>]
      跟踪频道新消息（轮询 tail，Ctrl+C 退出）
  ocs help

数据目录: ~/.ocs（可用 OCS_HOME 覆盖）
`;

async function cmdSend(parsed: Parsed): Promise<void> {
  const [channel, ...bodyParts] = parsed.positional;
  if (channel === undefined || bodyParts.length === 0) fail("usage: ocs send <channel> <body> --as <name>");
  const from = requireString(parsed, "as");
  const replyTo = parsed.flags.get("reply-to");
  const message = appendMessage({
    channel,
    from,
    body: bodyParts.join(" "),
    ...(typeof replyTo === "string" ? { reply_to: Number(replyTo) } : {}),
  });
  console.log(`sent #${channel} seq ${message.seq}`);

  if (parsed.flags.has("no-wake") || message.mentions.length === 0) return;
  // 自我唤醒防回环：ocs 通常在 Claude 会话里被调用，父进程 pid 即自身会话。
  const selection = selectWakeTargets(message.mentions, { selfPids: [process.ppid] });
  if (selection.targets.length === 0) {
    const hint = selection.excludedSelf.length > 0 ? "（@ 到了自己，已跳过）" : "";
    console.log(`wake: 没有匹配 @${message.mentions.join(" @")} 的活 Claude 会话${hint}`);
    return;
  }
  for (const outcome of await wakeSessions(selection.targets, {
    channel,
    seq: message.seq,
    from,
  })) {
    const target = `${outcome.session.name ?? "?"}(pid ${outcome.session.pid})`;
    if (outcome.result.ok) {
      // 上游铁律：ok 只代表帧进了收件箱，不代表已进对话（默认 hold）。措辞如实。
      console.log(`wake: 已投递收件箱 → ${target}`);
    } else {
      console.log(`wake: 失败 → ${target}: ${outcome.result.reason}`);
    }
  }
}

function cmdRead(parsed: Parsed): void {
  const [channel] = parsed.positional;
  if (channel === undefined) fail("usage: ocs read <channel> --as <name>");
  const consumer = requireString(parsed, "as");
  if (!NAME_RE.test(consumer)) fail(`invalid name: ${consumer}`);
  const sinceFlag = parsed.flags.get("since");
  const since = typeof sinceFlag === "string" ? Number(sinceFlag) : loadCursor(channel, consumer);
  if (!Number.isInteger(since) || since < 0) fail("--since must be a non-negative integer");
  const messages = readMessages(channel, { since });
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(messages, null, 2));
  } else if (messages.length === 0) {
    console.log(`#${channel}: 没有 seq > ${since} 的新消息`);
  } else {
    for (const m of messages) printMessage(m);
  }
  if (!parsed.flags.has("peek") && messages.length > 0) {
    saveCursor(channel, consumer, messages[messages.length - 1]!.seq);
  }
}

function cmdSessions(): void {
  const sessions = listNativeSessions();
  if (sessions.length === 0) {
    console.log("没有活着的 Claude 原生会话（或 ~/.claude/sessions 不可读）");
    return;
  }
  for (const s of sessions) {
    console.log(
      `${s.name ?? "(未命名)"}  pid=${s.pid}  status=${s.status ?? "?"}  sessionId=${s.sessionId ?? "?"}`,
    );
  }
}

async function cmdWatch(parsed: Parsed): Promise<void> {
  const [channel] = parsed.positional;
  if (channel === undefined) fail("usage: ocs watch <channel>");
  const intervalFlag = parsed.flags.get("interval-ms");
  const interval = typeof intervalFlag === "string" ? Number(intervalFlag) : 500;
  if (!Number.isInteger(interval) || interval < 50) fail("--interval-ms must be >= 50");
  let cursor = lastSeq(channel);
  console.log(`watching #${channel} from seq ${cursor} (Ctrl+C to stop)`);
  const logPath = channelLogPath(channel);
  let lastSize = -1;
  for (;;) {
    let size = -1;
    try {
      size = statSync(logPath).size;
    } catch {
      // 频道尚无消息
    }
    if (size !== lastSize) {
      lastSize = size;
      for (const m of readMessages(channel, { since: cursor })) {
        printMessage(m);
        cursor = m.seq;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const parsed = parseArgs(rest);
  switch (command) {
    case "send":
      await cmdSend(parsed);
      break;
    case "read":
      cmdRead(parsed);
      break;
    case "sessions":
      cmdSessions();
      break;
    case "watch":
      await cmdWatch(parsed);
      break;
    case "help":
    case undefined:
      console.log(HELP);
      break;
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

await main();
