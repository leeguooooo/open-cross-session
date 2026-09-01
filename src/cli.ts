#!/usr/bin/env bun
// ocs — open-cross-session CLI（M1：send / read / sessions / watch）。
//
// 命令面刻意贴近上游 party CLI 的使用习惯，降低将来 `ocs upgrade` 迁到托管版的心智成本。

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listNativeSessions } from "./claude-inject.ts";
import { codexDesktopIpcAvailable, codexDesktopIpcSocketPath } from "./codex-ipc.ts";
import { codexSessionsRoot, formatCodexSessionLine, listCodexSessions } from "./codex-sessions.ts";
import {
  appendMessage,
  channelLogPath,
  lastSeq,
  loadCursor,
  ocsHome,
  readMessages,
  saveCursor,
  NAME_RE,
} from "./store.ts";
import {
  findSelfClaudePid,
  selectWakeTargets,
  splitWakeMentions,
  wakeCodexTask,
  wakeSessions,
} from "./wake.ts";

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
           [--codex <thread-id>] [--codex-source <thread-id>]
      追加消息到本机频道日志；body 里 @<会话名> 会注入唤醒指针到对应活 Claude 会话；
      --codex 额外把唤醒指针投进指定 ChatGPT Desktop task（原生跨任务通信）
  ocs read <channel> --as <name> [--since <seq>] [--json] [--peek]
      从上次游标（或 --since）读新消息并推进游标；--peek 只读不推进
  ocs sessions
      列出本机活着的 Claude 原生会话（@ 目标就是这里的 name）
  ocs codex-sessions [--limit <n>]
      列出本机 Codex rollout 任务（--codex 的 thread-id 从这里拿）
  ocs watch <channel> [--interval-ms <n>]
      跟踪频道新消息（轮询 tail，Ctrl+C 退出）
  ocs doctor
      体检：Claude 会话面 / crossSessionInbound 直投设置 / ChatGPT Desktop IPC / 数据目录
  ocs upgrade
      单机玩到头了？迁移到托管版 Agent Party（跨机器、跨组织频道）
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

  if (parsed.flags.has("no-wake")) return;

  // @ 分流：uuid 形状的 mention 视为 codex thread id，其余按 Claude 会话名。
  const { claudeNames, codexThreads } = splitWakeMentions(message.mentions);

  // Codex 侧：--codex <thread-id> 或 @<thread-id>，走 ChatGPT Desktop 原生跨任务通信
  const codexFlag = parsed.flags.get("codex");
  const codexTargets = [
    ...(typeof codexFlag === "string" ? [codexFlag] : []),
    ...codexThreads.filter((t) => t !== codexFlag),
  ];
  const codexSource = parsed.flags.get("codex-source");
  for (const target of codexTargets) {
    const result = await wakeCodexTask({
      targetThreadId: target,
      ...(typeof codexSource === "string" ? { sourceThreadId: codexSource } : {}),
      channel,
      seq: message.seq,
      from,
    });
    if (result.ok) {
      console.log(`wake(codex): turn 已接受 → task ${result.targetThreadId}（turnId ${result.turnId}）`);
    } else if (result.reason === "unknown-outcome") {
      // 上游铁律：帧已写出但结果未知——如实报告、绝不重放
      console.log(`wake(codex): 结果未知（帧已写出，勿重发）: ${result.detail ?? ""}`);
    } else {
      console.log(`wake(codex): 失败（${result.reason}）${result.detail ? `: ${result.detail}` : ""}`);
    }
  }

  if (claudeNames.length === 0) return;
  // 自我唤醒防回环：沿进程祖先链找本会话的 Claude pid（ppid 是中间 shell，不可用）。
  const selfPid = findSelfClaudePid();
  const selection = selectWakeTargets(claudeNames, {
    selfPids: selfPid === null ? [] : [selfPid],
  });
  if (selection.targets.length === 0) {
    const hint = selection.excludedSelf.length > 0 ? "（@ 到了自己，已跳过）" : "";
    console.log(`wake: 没有匹配 @${claudeNames.join(" @")} 的活 Claude 会话${hint}`);
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

function cmdCodexSessions(parsed: Parsed): void {
  const limitFlag = parsed.flags.get("limit");
  const limit = typeof limitFlag === "string" ? Number(limitFlag) : 20;
  if (!Number.isInteger(limit) || limit < 1) fail("--limit must be a positive integer");
  const sessions = listCodexSessions(codexSessionsRoot(), { limit });
  if (sessions.length === 0) {
    console.log("没有找到 Codex rollout（~/.codex/sessions 为空或不可读）");
    return;
  }
  for (const s of sessions) console.log(formatCodexSessionLine(s));
}

function readClaudeSettingValue(key: string): unknown {
  try {
    const settings = JSON.parse(
      readFileSync(join(homedir(), ".claude", "settings.json"), "utf8"),
    ) as Record<string, unknown>;
    return settings[key];
  } catch {
    return undefined;
  }
}

function cmdDoctor(): void {
  const ok = (s: string) => console.log(`  ✅ ${s}`);
  const warn = (s: string) => console.log(`  ⚠️  ${s}`);
  const bad = (s: string) => console.log(`  ❌ ${s}`);

  console.log("Claude 侧");
  const claude = listNativeSessions();
  if (claude.length > 0) ok(`${claude.length} 个活着的 Claude 原生会话可作唤醒目标`);
  else warn("没有活着的 Claude 原生会话（开一个交互式 Claude Code 再试）");
  const inbound = readClaudeSettingValue("crossSessionInbound");
  if (inbound === "accept") {
    ok("crossSessionInbound = accept（注入直投，真送达）");
  } else {
    bad(
      `crossSessionInbound = ${JSON.stringify(inbound ?? "hold(默认)")} — 注入会进待审队列，` +
        "5 分钟无人 Deliver 即静默丢弃。修复：在 ~/.claude/settings.json 顶层加 " +
        '"crossSessionInbound": "accept"',
    );
  }

  console.log("Codex / ChatGPT Desktop 侧");
  if (codexDesktopIpcAvailable()) {
    ok(`Desktop IPC 可用（${codexDesktopIpcSocketPath()}）`);
  } else {
    warn(`Desktop IPC 不可用（${codexDesktopIpcSocketPath()} 缺失或权限不对）——ChatGPT Desktop 开着吗？`);
  }
  const codex = listCodexSessions(codexSessionsRoot(), { limit: 3 });
  if (codex.length >= 2) ok(`${codex.length}+ 个 Codex rollout（IPC 唤醒需要成对任务，满足）`);
  else if (codex.length === 1) warn("只有 1 个 Codex rollout——原生 IPC 唤醒需要同 renderer 下的第二个任务作 source");
  else warn("没有 Codex rollout（跑过 codex 吗？）");

  console.log("数据目录");
  try {
    statSync(ocsHome());
    ok(`${ocsHome()} 存在`);
  } catch {
    ok(`${ocsHome()} 首次 send 时自动创建`);
  }
}

function cmdUpgrade(): void {
  console.log(`单机版到托管版 Agent Party（跨机器、跨组织频道，同一套使用习惯）：

  1. 安装:  curl -fsSL https://agentparty.leeguoo.com/install.sh | sh
  2. 建频道: 打开 https://agentparty.leeguoo.com 创建频道，拿到 party join 片段
  3. 迁历史: ocs read <channel> --as migrator --peek --json 导出后用 party send 回放（可选）

本地 ocs 与托管 party 可以并存：本机小事走 ocs，跨机协作走 party。`);
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
    case "codex-sessions":
      cmdCodexSessions(parsed);
      break;
    case "doctor":
      cmdDoctor();
      break;
    case "upgrade":
      cmdUpgrade();
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
