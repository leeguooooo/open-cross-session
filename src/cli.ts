#!/usr/bin/env bun
// ocs — open-cross-session CLI。
//
// 命令面刻意贴近上游 party CLI 的使用习惯，降低将来 `ocs upgrade` 迁到托管版的心智成本。
// 输出全部走 i18n 目录（英文 canonical，OCS_LANG/locale 选 zh）。

import { statSync } from "node:fs";
import { listNativeSessions } from "./claude-inject.ts";
import { enableCrossSessionInbound, readCrossSessionInbound } from "./claude-settings.ts";
import { codexDesktopIpcAvailable, codexDesktopIpcSocketPath } from "./codex-ipc.ts";
import { codexSessionsRoot, formatCodexSessionLine, listCodexSessions } from "./codex-sessions.ts";
import { detectLang, messages } from "./i18n.ts";
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

export const OCS_VERSION = "0.1.2";

const LANG = detectLang();
const M = messages(LANG);

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

/** 每命令的参数 schema（review #14）：缺值、未知 flag、多余 positional 都要报错，
 * 不许静默忽略——`--codex` 忘带值时假装发过唤醒是最坏的失败方式。 */
interface CommandSpec {
  value: readonly string[];
  bool: readonly string[];
  minPos: number;
  maxPos: number | null;
}

const NO_ARGS: CommandSpec = { value: [], bool: [], minPos: 0, maxPos: 0 };
const COMMAND_SPECS: Record<string, CommandSpec> = {
  send: { value: ["as", "reply-to", "codex", "codex-source"], bool: ["no-wake"], minPos: 2, maxPos: null },
  read: { value: ["as", "since"], bool: ["json", "peek"], minPos: 1, maxPos: 1 },
  sessions: NO_ARGS,
  "codex-sessions": { value: ["limit"], bool: [], minPos: 0, maxPos: 0 },
  watch: { value: ["interval-ms"], bool: [], minPos: 1, maxPos: 1 },
  doctor: { value: [], bool: ["fix"], minPos: 0, maxPos: 0 },
  upgrade: NO_ARGS,
  version: NO_ARGS,
  "--version": NO_ARGS,
  help: NO_ARGS,
};

function parseArgs(argv: string[], spec: CommandSpec): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      if (spec.value.includes(key)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith("--")) fail(M.failMissingValue(key));
        flags.set(key, next);
        i++;
      } else if (spec.bool.includes(key)) {
        flags.set(key, true);
      } else {
        fail(M.failUnknownFlag(key));
      }
    } else {
      positional.push(arg);
    }
  }
  if (spec.maxPos !== null && positional.length > spec.maxPos) {
    fail(M.failExtraArgs(positional.slice(spec.maxPos).join(" ")));
  }
  return { positional, flags };
}

function fail(message: string): never {
  console.error(`ocs: ${message}`);
  process.exit(1);
}

function requireString(parsed: Parsed, flag: string): string {
  const value = parsed.flags.get(flag);
  if (typeof value !== "string" || value === "") fail(M.failFlagRequired(flag));
  return value;
}

function printMessage(m: { seq: number; ts: string; from: string; body: string }): void {
  console.log(`#${m.seq} ${m.ts} <${m.from}> ${m.body}`);
}

async function cmdSend(parsed: Parsed): Promise<void> {
  const [channel, ...bodyParts] = parsed.positional;
  if (channel === undefined || bodyParts.length === 0) fail(M.failSendUsage);
  const from = requireString(parsed, "as");
  const replyTo = parsed.flags.get("reply-to");
  let replyToSeq: number | undefined;
  if (replyTo !== undefined) {
    replyToSeq = typeof replyTo === "string" ? Number(replyTo) : NaN;
    if (!Number.isInteger(replyToSeq) || replyToSeq < 1) fail(M.failReplyTo);
  }
  const message = appendMessage({
    channel,
    from,
    body: bodyParts.join(" "),
    ...(replyToSeq !== undefined ? { reply_to: replyToSeq } : {}),
  });
  console.log(M.sent(channel, message.seq));

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
      lang: LANG,
    });
    if (result.ok) {
      console.log(M.codexAccepted(result.targetThreadId, result.turnId));
    } else if (result.reason === "unknown-outcome") {
      // 上游铁律：帧已写出但结果未知——如实报告、绝不重放
      console.log(M.codexUnknownOutcome(result.detail ?? ""));
    } else {
      console.log(M.codexFailed(result.reason, result.detail ?? ""));
    }
  }

  if (claudeNames.length === 0) return;
  // 自我唤醒防回环：沿进程祖先链找本会话的 Claude pid（ppid 是中间 shell，不可用）。
  const selfPid = findSelfClaudePid();
  const selection = selectWakeTargets(claudeNames, {
    selfPids: selfPid === null ? [] : [selfPid],
  });
  if (selection.targets.length === 0) {
    const hint = selection.excludedSelf.length > 0 ? M.wakeSelfSkipped : "";
    console.log(`${M.wakeNoMatch(claudeNames.join(" @"))}${hint}`);
    return;
  }
  for (const outcome of await wakeSessions(selection.targets, {
    channel,
    seq: message.seq,
    from,
    lang: LANG,
  })) {
    const target = `${outcome.session.name ?? "?"}(pid ${outcome.session.pid})`;
    if (outcome.result.ok) {
      // 上游铁律：ok 只代表帧进了收件箱，不代表已进对话（默认 hold）。措辞如实。
      console.log(M.wakeDelivered(target));
    } else {
      console.log(M.wakeFailed(target, outcome.result.reason));
    }
  }
}

function cmdRead(parsed: Parsed): void {
  const [channel] = parsed.positional;
  if (channel === undefined) fail(M.failReadUsage);
  const consumer = requireString(parsed, "as");
  if (!NAME_RE.test(consumer)) fail(M.failName(consumer));
  const sinceFlag = parsed.flags.get("since");
  const since = typeof sinceFlag === "string" ? Number(sinceFlag) : loadCursor(channel, consumer);
  if (!Number.isInteger(since) || since < 0) fail(M.failSince);
  const found = readMessages(channel, { since });
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(found, null, 2));
  } else if (found.length === 0) {
    console.log(M.noNewMessages(channel, since));
  } else {
    for (const m of found) printMessage(m);
  }
  if (!parsed.flags.has("peek") && found.length > 0) {
    saveCursor(channel, consumer, found[found.length - 1]!.seq);
  }
}

function cmdSessions(): void {
  const sessions = listNativeSessions();
  if (sessions.length === 0) {
    console.log(M.noClaudeSessions);
    return;
  }
  for (const s of sessions) {
    console.log(
      `${s.name ?? "(unnamed)"}  pid=${s.pid}  status=${s.status ?? "?"}  sessionId=${s.sessionId ?? "?"}`,
    );
  }
}

function cmdCodexSessions(parsed: Parsed): void {
  const limitFlag = parsed.flags.get("limit");
  const limit = typeof limitFlag === "string" ? Number(limitFlag) : 20;
  if (!Number.isInteger(limit) || limit < 1) fail(M.failLimit);
  const sessions = listCodexSessions(codexSessionsRoot(), { limit });
  if (sessions.length === 0) {
    console.log(M.noCodexRollouts);
    return;
  }
  for (const s of sessions) console.log(formatCodexSessionLine(s));
}

function cmdDoctor(parsed: Parsed): void {
  const ok = (s: string) => console.log(`  ✅ ${s}`);
  const warn = (s: string) => console.log(`  ⚠️  ${s}`);
  const bad = (s: string) => console.log(`  ❌ ${s}`);

  console.log(M.doctorClaude);
  const claude = listNativeSessions();
  if (claude.length > 0) ok(M.doctorClaudeSessions(claude.length));
  else warn(M.doctorNoClaudeSessions);
  const inbound = readCrossSessionInbound();
  if (inbound === "accept") {
    ok(M.doctorInboundAccept);
  } else if (parsed.flags.has("fix")) {
    const result = enableCrossSessionInbound();
    if ("error" in result) {
      bad(M.doctorInboundFixFailed(result.error));
    } else if (result.changed) {
      ok(M.doctorInboundFixed(result.backupPath));
    } else {
      ok(M.doctorInboundAccept);
    }
  } else {
    bad(M.doctorInboundBad(JSON.stringify(inbound ?? "hold(default)")));
  }

  console.log(M.doctorCodex);
  if (codexDesktopIpcAvailable()) {
    ok(M.doctorIpcOk(codexDesktopIpcSocketPath()));
  } else {
    warn(M.doctorIpcMissing(codexDesktopIpcSocketPath()));
  }
  const codex = listCodexSessions(codexSessionsRoot(), { limit: 3 });
  if (codex.length >= 2) ok(M.doctorRollouts(codex.length));
  else if (codex.length === 1) warn(M.doctorOneRollout);
  else warn(M.doctorNoRollouts);

  console.log(M.doctorAccel);
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const cmuxPing = spawnSync("cmux", ["ping"], { encoding: "utf8", timeout: 2000 });
  if (cmuxPing.status === 0) {
    ok(M.doctorCmuxOk);
  } else {
    console.log(`  ｰ  ${M.doctorCmuxMissing}`);
  }

  console.log(M.doctorData);
  try {
    statSync(ocsHome());
    ok(M.doctorDataExists(ocsHome()));
  } catch {
    ok(M.doctorDataAuto(ocsHome()));
  }
}

async function cmdWatch(parsed: Parsed): Promise<void> {
  const [channel] = parsed.positional;
  if (channel === undefined) fail(M.failWatchUsage);
  const intervalFlag = parsed.flags.get("interval-ms");
  const interval = typeof intervalFlag === "string" ? Number(intervalFlag) : 500;
  if (!Number.isInteger(interval) || interval < 50) fail(M.failInterval);
  let cursor = lastSeq(channel);
  console.log(M.watching(channel, cursor));
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
  const spec = command !== undefined ? COMMAND_SPECS[command] : undefined;
  if (command !== undefined && spec === undefined) {
    fail(`${M.unknownCommand(command)}\n\n${M.help}`);
  }
  const parsed = parseArgs(rest, spec ?? NO_ARGS);
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
      cmdDoctor(parsed);
      break;
    case "upgrade":
      console.log(M.upgrade);
      break;
    case "watch":
      await cmdWatch(parsed);
      break;
    case "version":
    case "--version":
      console.log(`ocs ${OCS_VERSION}`);
      break;
    case "help":
    case undefined:
      console.log(M.help);
      break;
  }
}

if (import.meta.main) await main();
