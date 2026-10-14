import { startDeliveryObservation, type TrafficOutcome } from "./traffic.ts";
// 投递阶梯（消息此前已落盘，这里只负责唤醒）。
//
// 本来内联在 cli.ts 里、直接 console.log + 改退出码；局域网守护进程收到远端 DM 后要走
// 同一条阶梯，但它的「输出」是回给发送方的应答，不是自己的 stdout。所以阶梯只认一个
// sink：CLI 的 sink 打印并设退出码，守护进程的 sink 收集行、算出总体结果回传。
// 分支和措辞与原来逐字一致——两个入口共用一份，免得一边修了另一边漂。

import { resolveSessionSocketByPid, type NativeClaudeSession } from "./claude-inject.ts";
import { wakeAgy } from "./agy.ts";
import { agyMessages } from "./i18n-agy.ts";
import { detectLang } from "./i18n.ts";
import { codexActiveTurnId, deferCodexWakeIfBusy, loadDeferredCodexWake } from "./codex-defer.ts";
import { steerCodexTurn } from "./codex-steer.ts";
import { codexHosts, codexThreadLivePid, psTable, queueCodexThread } from "./codex-queue.ts";
import type { messages } from "./i18n.ts";
import { hermesTargetName, wakeHermesSession, type HermesWakeResult } from "./hermes.ts";
import { listPiSessions, wakePiSession } from "./pi-sessions.ts";
import {
  CODEX_THREAD_ID_ENV,
  findCodexCmuxSurface,
  wakeCmuxSurface,
  type ResolvedDmTarget,
} from "./roster.ts";
import { wakeCodexTask, wakeNote, wakeSessions, type WakeInput, type WakeNoteInput } from "./wake.ts";
import { wakeClaudeTracked, type NoticeSender, type TrackedWake } from "./wake-receipt.ts";

export type Catalog = ReturnType<typeof messages>;
export type StoredDeliveryFailure = "failed" | "unknown";

export interface DeliverySink {
  log(line: string): void;
  /** 已落盘但唤醒失败 / 结果未知。调用方据此设退出码或回传 outcome。 */
  fail(outcome: StoredDeliveryFailure): void;
  /**
   * 已落盘、没失败、但也没唤醒：目标不在线只停靠（parked），或 Codex 回合中并入积压（deferred）。
   * 退出码不变（0）；只给 `send/dm --json` 区分用，别的 sink 可以不实现。
   */
  skipped?(): void;
  pending?(state: "parked" | "deferred"): void;
}

/** Observe each target pipeline once, without changing its retries or result. */
export async function trackDelivery<T>(channel: string, seq: number, sink: DeliverySink,
  fn: (observed: DeliverySink) => Promise<T>, env: NodeJS.ProcessEnv = process.env): Promise<T> {
  const finish = startDeliveryObservation(channel, seq, env);
  let outcome: TrafficOutcome = "accepted";
  const observed: DeliverySink = {
    log: (line) => sink.log(line),
    fail: (state) => { if (state === "unknown" || outcome !== "unknown") outcome = state; sink.fail(state); },
    pending: (state) => { if (outcome !== "failed" && outcome !== "unknown") outcome = state; sink.pending?.(state); },
    skipped: () => { outcome = "none"; sink.skipped?.(); },
  };
  try { const result = await fn(observed); finish(outcome); return result; }
  catch (error) { finish("unknown"); throw error; }
}

/** 守护进程用：把阶梯输出收集起来，最后给出一个总体结果（unknown > failed > ok）。 */
export function collectingSink(): DeliverySink & { lines: string[]; outcome(): "ok" | StoredDeliveryFailure } {
  const lines: string[] = [];
  let worst: "ok" | StoredDeliveryFailure = "ok";
  return {
    lines,
    log: (line) => lines.push(line),
    fail: (outcome) => {
      if (outcome === "unknown" || worst === "ok") worst = outcome;
    },
    outcome: () => worst,
  };
}

/**
 * #30：Desktop 明确没有投递时，若同一个 task 仍运行在唯一可验证的 cmux Codex surface，
 * 用同一条已落盘消息的 channel/seq 唤醒它。unknown-outcome 绝不能走这里，避免重复投递。
 */
function tryCodexCmuxFallback(
  targetThreadId: string,
  reason: string,
  wakeInput: Omit<WakeNoteInput, "receiver">,
  M: Catalog,
  sink: DeliverySink,
): boolean {
  if (reason !== "unavailable" && reason !== "not-open" && reason !== "no-source") return false;
  const surface = findCodexCmuxSurface(targetThreadId);
  if (surface === null) return false;
  const result = wakeCmuxSurface(
    surface.ref,
    wakeNote({
      ...wakeInput,
      receiver: `codex-${targetThreadId.slice(0, 8)}`,
      implicitReceiver: true,
    }),
  );
  if (!result.ok) return false;
  sink.log(M.codexCmuxFallback(targetThreadId, reason, surface.ref));
  return true;
}

/**
 * codex 目标的统一投递阶梯:
 *   1. `codex queue --thread` —— 官方 CLI 表面，按 thread 精确寻址，终端 TUI / Desktop 通吃，
 *      不需要 cmux，也不需要目标被 renderer 认领。先用 rollout fd 证明目标活着才发
 *      （queue 对死会话照样 exit=0，见 codex-queue.ts 的送达语义）。
 *   2. ChatGPT Desktop IPC —— 私有协议（铁律 5），保留作降级。
 *   3. cmux 按键注入 —— 最后兜底。
 * unknown-outcome 在任一层都立即停止：帧可能已写出，绝不重放（铁律 5）。
 * 返回 false 表示三层都没投出去，调用方按「仅落盘」处理。
 *
 * 目标正在跑回合时不入宿主队列（#41，codex-defer.ts）：宿主会把每条唤醒排着队、回合结束后
 * 逐条开新回合。改为并入积压，回合结束后合成一条、已读的不发。`defer:false` 是等待器自己
 * 投合并唤醒时用的——那一条本来就是积压的出口，不能再并回积压里。
 */
export async function deliverToCodexTask(...args: Parameters<typeof deliverToCodexTaskImpl>) {
  const [target, input, catalog, sink, source, env = process.env, options] = args;
  return trackDelivery(input.channel, input.seq, sink,
    (observed) => deliverToCodexTaskImpl(target, input, catalog, observed, source, env, options), env);
}

async function deliverToCodexTaskImpl(
  targetThreadId: string,
  wakeInput: Omit<WakeNoteInput, "receiver">,
  M: Catalog,
  sink: DeliverySink,
  sourceThreadId?: string,
  env: NodeJS.ProcessEnv = process.env,
  options: { defer?: boolean } = {},
): Promise<boolean> {
  // 自我唤醒防回环：Claude（findSelfClaudePid）和 Pi（piWakeSelfSkipped）两条路都有，
  // codex 一直缺——以前 Desktop IPC 前置条件多不易触发，`codex queue` 又快又稳之后
  // 一个 @ 到自己的会话会把自己反复唤醒。
  const selfThreadId = env[CODEX_THREAD_ID_ENV];
  if (typeof selfThreadId === "string" && selfThreadId.toLowerCase() === targetThreadId.toLowerCase()) {
    sink.log(M.codexWakeSelfSkipped(targetThreadId));
    sink.skipped?.();
    return true;
  }
  const ps = psTable(env);
  const livePid = codexThreadLivePid(targetThreadId, env, ps);
  // 载体按宿主选，不是一律 queue：
  //   * Desktop 托管的 task —— 先走 Desktop IPC。两条路都能送达并触发新 turn，但 IPC 在
  //     rollout 里留的是 `send_message_to_thread` + `<codex_delegation><source_thread_id>`
  //     原生来源信封，queue 留下的是普通 `UserMessage`——会把别的 agent 发来的消息呈现成
  //     「用户自己敲的」。跨会话内容必须看得出是数据而不是用户指令（Claude 侧用原生
  //     "Message from X" 包装是同一个理由），所以 Desktop 上不拿来源换便利。
  //   * 其它宿主（终端 TUI）—— IPC 根本够不着，queue 是唯一的路。
  const desktopHosted = livePid !== null && codexHosts([livePid], env, ps).get(livePid)?.app === "ChatGPT";
  // 目标正在跑回合（#41）：宿主会把排队的唤醒留到回合结束后逐条开新回合。先试着插进当前
  // 回合（守护进程 turn/steer，终端 TUI 实测可用）；插不进就并入积压，回合结束后合成一条。
  // Desktop 托管的不 steer：守护进程的 steer 留下的是普通用户消息，丢了 IPC 的原生来源信封（铁律 10）。
  if (livePid !== null && options.defer !== false && wakeInput.rawNote === undefined) {
    const activeTurn = codexActiveTurnId(targetThreadId, env);
    const backlog = loadDeferredCodexWake(targetThreadId, wakeInput.channel, env) !== null;
    if (activeTurn !== null && activeTurn !== "" && !backlog && !desktopHosted) {
      const steered = await steerCodexTurn({
        threadId: targetThreadId,
        expectedTurnId: activeTurn,
        prompt: wakeNote({
          ...wakeInput,
          receiver: `codex-${targetThreadId.slice(0, 8)}`,
          implicitReceiver: true,
        }),
        env,
      });
      if (steered.ok) {
        sink.log(M.codexSteered(targetThreadId, steered.turnId));
        return true;
      }
      if (steered.reason === "unknown-outcome") {
        sink.log(M.codexUnknownOutcome(steered.detail ?? ""));
        sink.fail("unknown");
        return true; // 帧可能已经插进回合，绝不重放
      }
      sink.log(M.codexSteerSkipped(targetThreadId, steered.reason, steered.detail ?? ""));
    }
    const deferred = deferCodexWakeIfBusy({
      threadId: targetThreadId,
      wakeInput,
      ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
      env,
    });
    if (deferred.deferred) {
      sink.log(M.codexWakeDeferred(targetThreadId, deferred.pending));
      sink.pending?.("deferred");
      return true;
    }
  }
  if (livePid !== null && !desktopHosted) {
    const queued = queueCodexThread({
      threadId: targetThreadId,
      livePid,
      prompt: wakeNote({
        ...wakeInput,
        receiver: `codex-${targetThreadId.slice(0, 8)}`,
        implicitReceiver: true,
      }),
    });
    if (queued.ok) {
      sink.log(M.codexQueued(queued.threadId, queued.pid, queued.messageId));
      return true;
    }
    if (queued.reason === "unknown-outcome") {
      sink.log(M.codexUnknownOutcome(queued.detail ?? ""));
      sink.fail("unknown");
      return true; // 已上报，不再往下投，避免重复送达
    }
    sink.log(M.codexQueueSkipped(targetThreadId, queued.reason, queued.detail ?? ""));
  }
  const result = await wakeCodexTask({
    targetThreadId,
    ...(sourceThreadId !== undefined ? { sourceThreadId } : {}),
    ...wakeInput,
  });
  if (result.ok) {
    sink.log(M.codexAccepted(result.targetThreadId, result.turnId));
    return true;
  }
  if (result.reason === "unknown-outcome") {
    sink.log(M.codexUnknownOutcome(result.detail ?? ""));
    sink.fail("unknown");
    return true;
  }
  if (tryCodexCmuxFallback(targetThreadId, result.reason, wakeInput, M, sink)) {
    // cmux 只复用同一 channel/seq 做唤醒，没有再次落盘。
    return true;
  }
  // Desktop 托管但 IPC 投不进（没被 renderer 认领等）时，queue 仍是可用的最后一级：
  // 丢掉原生来源信封总好过完全投不到——正文里本来就带着 `[ocs wake] X mentioned you`。
  if (desktopHosted && livePid !== null) {
    const queued = queueCodexThread({
      threadId: targetThreadId,
      livePid,
      prompt: wakeNote({
        ...wakeInput,
        receiver: `codex-${targetThreadId.slice(0, 8)}`,
        implicitReceiver: true,
      }),
    });
    if (queued.ok) {
      sink.log(M.codexQueued(queued.threadId, queued.pid, queued.messageId));
      return true;
    }
    if (queued.reason === "unknown-outcome") {
      sink.log(M.codexUnknownOutcome(queued.detail ?? ""));
      sink.fail("unknown");
      return true;
    }
  }
  sink.log(M.codexFailed(result.reason, result.detail ?? ""));
  sink.fail("failed");
  return false;
}

/**
 * 把一次 Claude 唤醒的第一阶段结果说清楚（docs/wake-protocol.md §6）。
 * - plain：回执不可用，措辞和 0.6 逐字一致（「delivered to inbox」只代表帧进了收件箱）。
 * - accepted：回执通道开着，窗口内没报扣留/拒绝——仍然不是已读。
 * - held / refused / dropped / denied / expired：消息已落盘但没进对话 → 退出码 2。
 * - unknown：helper 没给结果，帧可能已写出 → 退出码 3，绝不重放。
 */
export function reportTrackedWake(
  label: string,
  wake: TrackedWake,
  M: Catalog,
  sink: DeliverySink,
  options: { followUp: boolean },
): void {
  if (wake.kind === "plain") {
    sink.log(M.wakeDelivered(label));
    return;
  }
  if (wake.kind === "failed") {
    sink.log(M.wakeFailed(label, wake.detail === undefined ? wake.reason : `${wake.reason} (${wake.detail})`));
    sink.fail("failed");
    return;
  }
  if (wake.kind === "unknown") {
    sink.log(M.wakeHelperUnknown(label, wake.detail));
    sink.fail("unknown");
    return;
  }
  if (wake.status === "accepted") {
    sink.log(M.wakeAccepted(label));
    return;
  }
  if (wake.status === "delivered") {
    sink.log(M.wakeConfirmed(label));
    return;
  }
  if (wake.status === "held") sink.log(M.wakeHeld(label, options.followUp));
  else sink.log(M.wakeNotDelivered(label, wake.status, wake.reason ?? ""));
  sink.fail("failed");
}

/** 会话环境变量：通知发给「派出 helper 的那个会话」自己，不能让自我唤醒防回环把它吞掉。 */
const SELF_ENV_KEYS = [
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CODEX_THREAD_ID",
  "OCS_NAME",
  "OCS_PI_SESSION_ID",
  "HERMES_SESSION_ID",
  "HERMES_SESSION_SOURCE",
];

/** Hermes 投递结果 → 一行输出 + 失败分级（unknown 绝不重发）。 */
function reportHermesWake(label: string, result: HermesWakeResult, M: Catalog, sink: DeliverySink): void {
  if (result.ok) {
    sink.log(result.delivery === "started" ? M.hermesWakeStarted(label) : M.hermesWakeQueued(label));
  } else if (result.reason === "unknown-outcome") {
    sink.log(M.hermesWakeUnknownOutcome(label, result.detail ?? ""));
    sink.fail("unknown");
  } else {
    sink.log(M.hermesWakeFailed(label, result.reason, result.detail ?? ""));
    sink.fail("failed");
  }
}

/**
 * 把一条 ocs 自己生成的通知（投递回执通知）按发送方的 harness 投回去。走的是同一套载体，
 * 但**故意不带回执**：Claude 分支直接 wakeSessions（不派 helper、帧里没有 `from`），
 * 否则一条被扣下的通知会再生出一条通知，永无止境。
 */
export async function deliverNotice(
  target: NoticeSender,
  note: string,
  context: { channel: string; seq: number; lang: "en" | "zh" },
  M: Catalog,
  sink: DeliverySink,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const input: WakeInput = { ...context, from: "ocs", body: note, rawNote: note };
  if (target.kind === "claude") {
    const resolved = resolveSessionSocketByPid(target.pid, { expectSessionId: target.sessionId, env });
    if (!resolved.ok) {
      sink.log(M.wakeFailed(target.name, "sender session is gone"));
      sink.fail("failed");
      return;
    }
    const [outcome] = await wakeSessions([resolved.session], { ...input, env });
    if (outcome!.result.ok) sink.log(M.wakeDelivered(target.name));
    else {
      sink.log(M.wakeFailed(target.name, outcome!.result.reason));
      sink.fail("failed");
    }
    return;
  }
  const clean: NodeJS.ProcessEnv = { ...env };
  for (const key of SELF_ENV_KEYS) delete clean[key];
  if (target.kind === "codex") {
    await deliverToCodexTask(target.threadId, input, M, sink, undefined, clean);
    return;
  }
  if (target.kind === "hermes") {
    reportHermesWake(hermesTargetName(target.sessionKey), await wakeHermesSession(target.sessionKey, note, { env: clean }), M, sink);
    return;
  }
  const session = listPiSessions(clean).find((candidate) => candidate.session_id.toLowerCase() === target.sessionId.toLowerCase());
  if (session === undefined) {
    sink.log(M.piWakeUnavailable(target.sessionId));
    sink.fail("failed");
    return;
  }
  const result = await wakePiSession(session, note);
  if (result.ok) sink.log(M.piWakeAccepted(session.target));
  else {
    sink.log(M.piWakeFailed(session.target, result.reason, result.detail ?? ""));
    sink.fail(result.reason === "unknown-outcome" ? "unknown" : "failed");
  }
}

export interface DmDeliveryInput {
  resolved: ResolvedDmTarget;
  /** 用户敲的目标串（提示文案用）。 */
  target: string;
  channel: string;
  /** 本条消息在频道里是不是第一条（停靠文案区分新旧频道）。 */
  firstMessage: boolean;
  /** 有稳定工作区 pair 时停靠文案不同（重启后仍会被 inbox 认出来）。 */
  stableChannel: boolean;
  wakeInput: Omit<WakeNoteInput, "receiver">;
  /** Claude DM 的 Reply 行目标；null 时用频道 send --reply-to 形式。 */
  dmReplyTarget: string | null;
  /** Pi / cmux / codex 的 Reply 行目标（远端 DM 需要 `x@peer`，本地 DM 不传）。 */
  anyReplyTarget?: string;
  /**
   * Claude 目标走带回执的唤醒（docs/wake-protocol.md §6）。不传＝旧的无回执路径。
   * sender：终态没送达时通知谁（null 不通知）。followUp：措辞里能不能承诺「没送达会通知你」——
   * 没有可通知的发送方会话（裸 shell、远端发送方）时必须是 false，终态只进频道日志。
   */
  receipts?: { sender: NoticeSender | null; followUp: boolean };
  env?: NodeJS.ProcessEnv;
}

/**
 * 一条已落盘 DM 按目标种类唤醒。返回被唤醒的 Claude 会话（调用方据此挂 idle 订阅），
 * 其它种类返回 null。
 */
export async function deliverDm(input: DmDeliveryInput, M: Catalog, sink: DeliverySink) {
  return trackDelivery(input.channel, input.wakeInput.seq, sink,
    (observed) => deliverDmImpl(input, M, observed), input.env ?? process.env);
}

async function deliverDmImpl(
  input: DmDeliveryInput,
  M: Catalog,
  sink: DeliverySink,
): Promise<NativeClaudeSession | null> {
  const { resolved, target, channel } = input;
  const env = input.env ?? process.env;
  const anyReply = input.anyReplyTarget === undefined ? {} : { dmReplyTarget: input.anyReplyTarget };
  if (resolved.kind === "agy") {
    const A = agyMessages(input.wakeInput.lang ?? detectLang(env));
    if (resolved.ambiguousNameTargets !== undefined) {
      sink.log(A.failed("ambiguous", resolved.ambiguousNameTargets.join(", ")));
      sink.fail("failed");
      return null;
    }
    if (env.OCS_NAME === "agy" || input.wakeInput.from === "agy") {
      sink.log(A.self);
      sink.skipped?.();
      return null;
    }
    const result = await wakeAgy({
      channel: input.channel,
      seq: input.wakeInput.seq,
      note: wakeNote({ ...input.wakeInput, ...anyReply, receiver: "agy", implicitReceiver: true }),
      ...(input.anyReplyTarget === undefined ? {} : { replyTarget: input.anyReplyTarget }),
    }, env);
    if (result.ok) sink.log(A.queued(result.job));
    else {
      sink.log(A.failed(result.reason, result.detail ?? ""));
      sink.fail(result.reason === "unknown-outcome" ? "unknown" : "failed");
    }
    return null;
  }
  if (resolved.kind === "claude") {
    if (resolved.claude === undefined) {
      // 目标此刻不在线：一次性会话名重启后不会主动读这条频道，文案不许暗示会自动送达。
      sink.log(
        !input.stableChannel
          ? (input.firstMessage ? M.dmParkedNew(target, channel) : M.dmParked(target, channel))
          : M.dmParkedStable(target, channel),
      );
      sink.pending?.("parked");
      return null;
    }
    const claudeInput: WakeInput = {
      ...input.wakeInput,
      ...(input.dmReplyTarget !== null ? { dmReplyTarget: input.dmReplyTarget } : {}),
      env,
    };
    const label = `${resolved.claude.name ?? "?"}(pid ${resolved.claude.pid})`;
    if (input.receipts !== undefined) {
      const wake = await wakeClaudeTracked(resolved.claude, claudeInput, { sender: input.receipts.sender, env });
      reportTrackedWake(label, wake, M, sink, { followUp: input.receipts.followUp });
      return resolved.claude;
    }
    const [outcome] = await wakeSessions([resolved.claude], claudeInput);
    if (outcome!.result.ok) sink.log(M.wakeDelivered(label));
    else {
      const failure = outcome!.result;
      sink.log(M.wakeFailed(label, failure.detail === undefined ? failure.reason : `${failure.reason} (${failure.detail})`));
      sink.fail("failed");
    }
    return resolved.claude;
  }
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) {
    await deliverToCodexTaskImpl(resolved.threadId, { ...input.wakeInput, ...anyReply }, M, sink, undefined, env);
    return null;
  }
  if (resolved.kind === "pi" && resolved.piSessionId !== undefined) {
    if (resolved.piSession === undefined) {
      sink.log(M.dmPiParked(target, channel));
      sink.pending?.("parked");
      return null;
    }
    const result = await wakePiSession(
      resolved.piSession,
      wakeNote({ ...input.wakeInput, ...anyReply, receiver: resolved.name, implicitReceiver: true }),
    );
    if (result.ok) sink.log(M.piWakeAccepted(resolved.name));
    else if (result.reason === "unknown-outcome") {
      sink.log(M.piWakeUnknownOutcome(resolved.name, result.detail ?? ""));
      sink.fail("unknown");
    } else {
      sink.log(M.piWakeFailed(resolved.name, result.reason, result.detail ?? ""));
      sink.fail("failed");
    }
    return null;
  }
  if (resolved.kind === "hermes" && resolved.hermesSessionKey !== undefined) {
    // 不在线（宿主没开、会话没打开）→ wakeHermesSession 报 unavailable / not-open：消息已在频道里。
    const result = await wakeHermesSession(
      resolved.hermesSessionKey,
      wakeNote({ ...input.wakeInput, ...anyReply, receiver: resolved.name, implicitReceiver: true }),
      { env },
    );
    reportHermesWake(resolved.name, result, M, sink);
    return null;
  }
  if (resolved.kind === "cmux" && resolved.cmuxRef !== undefined) {
    // cmux surface 没有 ocs 名字：Reply:/Thread: 的 --as 用 dm 同款派生名 surface-N。
    const result = wakeCmuxSurface(
      resolved.cmuxRef,
      wakeNote({ ...input.wakeInput, ...anyReply, receiver: resolved.name }),
    );
    if (result.ok) sink.log(M.dmCmuxWoken(result.ref));
    else if (result.reason === "busy") {
      sink.log(M.dmCmuxBusy(resolved.cmuxRef));
      sink.fail("failed");
    } else {
      sink.log(M.dmCmuxFailed(resolved.cmuxRef, result.detail ?? result.reason));
      sink.fail("failed");
    }
  }
  return null;
}
