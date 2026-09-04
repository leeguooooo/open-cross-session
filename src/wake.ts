// 唤醒：把「频道有新消息」连同正文注入目标 Claude 会话（docs/wake-protocol.md §1）。
//
// 载荷从 v0.3.0 起带正文：正文是 cross-session-message 包装**里面的数据**，包装标签本身
// 已把它标成跨会话内容（接收端按「Message from X」呈现，不当指令）；4096 字节的正文
// 上限把注入帧钉在可控范围（超过只内联前 512 字节 + 总字节数 + 读线程命令），整条 note
// 恒 ≤5120 字节。这与 Claude Code 内置 SendMessage 的「正文直达」对齐——过去只投一条
// 「去跑 ocs read」的指针，收件方要多跑一跳才拿到正文，回复命令还得手拼。
// 送达语义同上游：ok:true 只代表帧进了收件箱 socket，接收端 crossSessionInbound
// 默认 hold（5 分钟无人 Deliver 即丢）。`ocs doctor` 负责引导用户把它设为 accept。

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { claudeWorkspaceTargetMatches } from "./claude-address.ts";
import {
  injectChannelMessage,
  listNativeSessions,
  resolveSessionSocketByPid,
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
import { messages } from "./i18n.ts";
import { piSessionIdFromTarget } from "./pi-sessions.ts";

/** 正文 UTF-8 字节数在此以内逐字内联（协议 §1）。 */
export const WAKE_BODY_INLINE_MAX_BYTES = 4096;
/** 超限时内联的前缀字节数（在字符边界截断）。 */
export const WAKE_BODY_PREVIEW_BYTES = 512;
/** 骨架（note 去掉正文）预算；超预算按降级阶梯先砍 ago 再砍 sender。 */
export const WAKE_SKELETON_MAX_BYTES = 1024;
/** 整条 note 上限 = 正文 4096 + 骨架 1024。 */
export const WAKE_NOTE_MAX_BYTES = WAKE_BODY_INLINE_MAX_BYTES + WAKE_SKELETON_MAX_BYTES;

export type WakeLang = "en" | "zh";

export interface WakeNoteInput {
  channel: string;
  seq: number;
  /** 发送者（频道里的 from）。 */
  from: string;
  /** 消息正文，逐字（≤4096B）或前 512B 内联。 */
  body: string;
  /** 唤醒时已知的目标名；只有不能自动识别身份的载体才会把它填进 `--as`。 */
  receiver: string;
  /** DM 到 Claude 会话时的可读回复目标；在对端可自动识别自身身份时才设置。 */
  dmReplyTarget?: string;
  /** 目标 harness 会给 ocs 提供自身身份；Reply/Thread 不需要再写 --as。 */
  implicitReceiver?: boolean;
  replyTo?: number;
  /** 可选的相对时间（"2m ago"）；ocs 的唤醒紧随 send，调用方一般不传。 */
  ago?: string;
  lang?: WakeLang;
}

/** 在 UTF-8 字节边界截断：不切开多字节字符（含代理对——UTF-8 里是一个 4 字节序列）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--; // 退过 continuation 字节
  return buf.subarray(0, end).toString("utf8");
}

export function wakeReplyCommand(
  channel: string,
  receiver: string,
  seq: number,
  implicitReceiver = false,
): string {
  return `ocs send ${channel} "<your reply>"${implicitReceiver ? "" : ` --as ${receiver}`} --reply-to ${seq}`;
}

export function wakeDmReplyCommand(target: string): string {
  return `ocs dm ${target} "<your reply>"`;
}

export function wakeReadCommand(channel: string, receiver: string, implicitReceiver = false): string {
  return `ocs read ${channel}${implicitReceiver ? "" : ` --as ${receiver}`}`;
}

/**
 * 唤醒 note（协议 §1 骨架，行序固定）：
 *
 *   [ocs wake] <sender> mentioned you in #<channel> (seq <N>[, reply to seq <M>][, <ago>])
 *   <空行>
 *   <body>
 *   <空行>
 *   Reply: ocs dm <sender> "<your reply>"                              (Claude DM)
 *          ocs send <channel> "<your reply>" [--as <receiver>] --reply-to <N> (其它)
 *   Thread: ocs read <channel> [--as <receiver>]
 *
 * 正文 >4096B 时 body 换成前 512B + `… (<total> bytes total; full text: <read command>)`。
 * 骨架超 1024B 时先砍 ago、再砍 sender；Reply:/Thread: 永不砍。
 */
export function wakeNote(input: WakeNoteInput): string {
  const M = messages(input.lang ?? "en");
  const dmReply = input.dmReplyTarget !== undefined;
  const implicitReceiver = dmReply || input.implicitReceiver === true;
  const read = wakeReadCommand(input.channel, input.receiver, implicitReceiver);
  const reply = dmReply
    ? wakeDmReplyCommand(input.dmReplyTarget!)
    : wakeReplyCommand(input.channel, input.receiver, input.seq, implicitReceiver);
  const total = Buffer.byteLength(input.body, "utf8");
  const bodyPart = total <= WAKE_BODY_INLINE_MAX_BYTES
    ? input.body
    : `${truncateUtf8(input.body, WAKE_BODY_PREVIEW_BYTES)}\n… (${total} bytes total; full text: ${read})`;
  const tail = `\n\n${M.wakeNoteReply(reply)}\n${M.wakeNoteThread(read)}`;
  const ladder: Array<{ sender: string | null; ago?: string }> = [
    { sender: input.from, ...(input.ago !== undefined ? { ago: input.ago } : {}) },
    { sender: input.from },
    { sender: null },
  ];
  for (const step of ladder) {
    const header = M.wakeNoteHeader({
      sender: step.sender,
      channel: input.channel,
      seq: input.seq,
      ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
      ...(step.ago !== undefined ? { ago: step.ago } : {}),
    });
    const note = `${header}\n\n${bodyPart}${tail}`;
    const skeleton = Buffer.byteLength(note, "utf8") - Buffer.byteLength(bodyPart, "utf8");
    if (skeleton <= WAKE_SKELETON_MAX_BYTES) return note;
  }
  // channel/名字都有 64 字符上限，走到这里只可能是编程错误（或畸形的会话名）。
  throw new Error(`wake note skeleton exceeds ${WAKE_SKELETON_MAX_BYTES} bytes`);
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
  piTargets: string[];
} {
  const claudeNames: string[] = [];
  const codexThreads: string[] = [];
  const piTargets: string[] = [];
  for (const mention of mentions) {
    if (isCodexThreadId(mention)) codexThreads.push(mention);
    else if (piSessionIdFromTarget(mention) !== null) piTargets.push(mention);
    else claudeNames.push(mention);
  }
  return { claudeNames, codexThreads, piTargets };
}

/**
 * 取父 pid。Linux 优先读 `/proc/<pid>/stat`（ppid 是最后一个 `)` 之后的第 2 个字段——comm 里
 * 可能有空格和括号，不能从头按空格切）；没有 /proc 再退到 `ps -o ppid=`。`ps` 不存在
 * （精简容器）或失败时返回 null——不许炸：`spawnSync` 在 ENOENT 时 stdout 是 null，
 * 直接 `.trim()` 会把整条命令打成 TypeError（Linux CI 现场）。
 */
export function parentPidOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = stat.lastIndexOf(")");
    if (close !== -1) {
      const fields = stat.slice(close + 1).trim().split(/\s+/);
      const ppid = Number(fields[1]);
      if (Number.isInteger(ppid) && ppid >= 0) return ppid;
    }
  } catch {
    // 无 /proc（macOS）或读不到——退到 ps
  }
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  try {
    const out = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" });
    if (out.error !== undefined || out.status !== 0 || typeof out.stdout !== "string") return null;
    const ppid = Number(out.stdout.trim());
    return Number.isInteger(ppid) && ppid >= 0 ? ppid : null;
  } catch {
    return null;
  }
}

/** Claude Code（2.1.258 实测）给 Bash 子进程的环境变量：会话 id 与本会话收件箱 socket。 */
export const CLAUDE_SESSION_ID_ENV = "CLAUDE_CODE_SESSION_ID";
export const CLAUDE_MESSAGING_SOCKET_ENV = "CLAUDE_CODE_MESSAGING_SOCKET";

/**
 * 零 spawn 的自身识别：从 `CLAUDE_CODE_MESSAGING_SOCKET` 文件名取 pid，读 sessions/<pid>.json，
 * 要求 **sessionId、messagingSocketPath 都与环境变量一致且 pid 活**才算认出自己。任一不符
 * （继承来的陈旧环境、/clear 后换了会话、pid 被复用）返回 null，交给祖先链兜底。
 */
export function selfPidFromEnv(env: NodeJS.ProcessEnv = process.env): number | null {
  const sessionId = env[CLAUDE_SESSION_ID_ENV];
  const sock = env[CLAUDE_MESSAGING_SOCKET_ENV];
  if (typeof sessionId !== "string" || sessionId === "" || typeof sock !== "string" || sock === "") return null;
  const match = /(\d+)\.sock$/.exec(basename(sock));
  if (match === null) return null;
  const pid = Number(match[1]);
  const resolved = resolveSessionSocketByPid(pid, { expectSessionId: sessionId, env }); // 含 pid 活 + sessionId 比对
  if (!resolved.ok) return null;
  if (resolved.session.messagingSocketPath !== sock) return null;
  return pid;
}

/**
 * 本进程所属的 Claude 会话 pid。顺序（docs/wake-protocol.md §4）：
 * 1. 环境变量（selfPidFromEnv）——零 spawn；
 * 2. 沿进程祖先链找（`~/.claude/sessions/<pid>.json` 存在即命中）。ocs 通常经由 Claude 的
 *    Bash 工具调用，`process.ppid` 是中间 shell 而非 Claude 本体——拿它做自我排除形同虚设
 *    （真机验证过：自 @ 自己会真的注入回环）。父 pid 查询 Linux 走 /proc、否则 ps；
 *    两者都没有＝当作「不在 Claude 会话里」，绝不抛异常。
 * `deps.parentPid` 可注入（测试数 spawn 次数）。
 */
export function findSelfClaudePid(
  env: NodeJS.ProcessEnv = process.env,
  maxHops = 10,
  deps: { parentPid?: (pid: number) => number | null } = {},
): number | null {
  const fromEnv = selfPidFromEnv(env);
  if (fromEnv !== null) return fromEnv;
  const parentPid = deps.parentPid ?? parentPidOf;
  const alive = new Set(listNativeSessions(env).map((s) => s.pid));
  let pid = process.pid;
  for (let hop = 0; hop < maxHops; hop++) {
    const parent = parentPid(pid);
    if (parent === null || parent <= 1) return null;
    if (alive.has(parent)) return parent;
    pid = parent;
  }
  return null;
}

/**
 * 目标选择：精确名优先；精确名不在线时，唯一工作区别名也可寻址。
 * - 排除 selfPids（发送方自己所在的会话，由 findSelfClaudePid 沿祖先链找到）。
 * - 排除 selfNames（发送者的 from 名——`--as` 指定或自动识别的那个）。#3 现场：正文里
 *   写「回复时 @我」把自己也叫醒了；按名字再排一次，祖先链识别失手时也不回环。
 * - 同名多会话不消歧、全部命中（本地个人场景下同名即同人多开，都该被叫醒）。
 */
export function selectWakeTargets(
  mentions: readonly string[],
  options: { selfPids?: readonly number[]; selfNames?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): WakeTargetSelection {
  const selfPids = new Set(options.selfPids ?? []);
  const selfNames = new Set(options.selfNames ?? []);
  const wanted = new Set(mentions);
  const sessions = listNativeSessions(options.env).filter((session) => session.name !== null);
  const selectedPids = new Set<number>();
  for (const mention of wanted) {
    const exact = sessions.filter((session) => session.name === mention);
    if (exact.length > 0) {
      for (const session of exact) selectedPids.add(session.pid);
      continue;
    }
    const aliases = sessions.filter((session) => claudeWorkspaceTargetMatches(session, mention));
    if (aliases.length === 1) selectedPids.add(aliases[0]!.pid);
  }
  const targets: NativeClaudeSession[] = [];
  const excludedSelf: number[] = [];
  for (const session of sessions) {
    if (session.name === null || !selectedPids.has(session.pid)) continue;
    if (selfPids.has(session.pid) || selfNames.has(session.name)) {
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

/** 三条唤醒载体共用的输入：频道指针 + 正文 + reply_to。receiver 按目标逐个填。 */
export interface WakeInput {
  channel: string;
  seq: number;
  from: string;
  body: string;
  replyTo?: number;
  dmReplyTarget?: string;
  lang?: WakeLang;
  env?: NodeJS.ProcessEnv;
}

export async function wakeSessions(
  targets: readonly NativeClaudeSession[],
  input: WakeInput,
): Promise<WakeOutcome[]> {
  const outcomes: WakeOutcome[] = [];
  for (const session of targets) {
    const receiver = session.name ?? `pid-${session.pid}`;
    const result = await injectChannelMessage({
      name: receiver,
      pid: session.pid,
      sessionId: session.sessionId,
      body: wakeNote({ ...input, receiver, implicitReceiver: true }),
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
export async function wakeCodexTask(input: WakeInput & {
  targetThreadId: string;
  sourceThreadId?: string;
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
    // Codex 任务没有 ocs 名字：Reply:/Thread: 里的 --as 用 dm 同款派生名 codex-<8hex>。
    const prompt = wakeNote({
      ...input,
      receiver: input.targetThreadId,
      implicitReceiver: true,
    });
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
