import { listOpenCodeSessions, selfOpenCodeSessionId, opencodeTargetName, opencodeSessionIdFromTarget, openCodeShortId, type OpenCodeSessionRegistration } from "./opencode.ts";
// 全机 agent 花名册与直发（dm）支撑：发现任意 agent、识别自己、派生 dm 频道。
//
// 目标体验：人只说自然语言，agent 自己跑 `ocs who` 发现同伴、`ocs dm` 搭话。
// 四个命名空间统一在这里：Claude 原生会话（UDS 可唤醒）、ChatGPT Desktop 任务
// （IPC 可唤醒）、Pi 会话（扩展 UDS 可唤醒）、Hermes 会话（宿主 WebSocket 排队投递）、
// cmux surface（可选加速器，探测到才列）。

import { spawnSync } from "node:child_process";
import { findAgyWorker } from "./agy.ts";
import { grokSessionIdFromTarget, grokTargetName, selfGrokSessionId, type GrokSession } from "./grok.ts";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  claudeWorkspaceAlias,
  claudeWorkspaceTargetMatches,
  uniqueClaudeWorkspaceAlias,
  uniqueClaudeWorkspaceIdentity,
} from "./claude-address.ts";
import { listNativeSessions, type NativeClaudeSession } from "./claude-inject.ts";
import { codexDesktopIpcAvailable } from "./codex-ipc.ts";
import { codexHosts, codexQueueAvailable, codexThreadLivePids, psTable } from "./codex-queue.ts";
import {
  codexSessionsRoot,
  isCodexThreadId,
  listCodexRolloutFiles,
  listCodexSessions,
} from "./codex-sessions.ts";
import {
  isPiSessionId,
  listPiSessions,
  OCS_PI_SESSION_ID_ENV,
  piSessionIdFromTarget,
  piTargetName,
  type PiSessionRegistration,
} from "./pi-sessions.ts";
import {
  hermesIdentity,
  hermesSessionKeyFromTarget,
  hermesTargetName,
  selfHermesSessionKey,
  type HermesSession,
} from "./hermes.ts";
import { findSelfClaudePid } from "./wake.ts";
import {
  knownClaudeWorkspaceIdentities,
  type VerifiedWorkspaceIdentity,
  verifiedClaudeWorkspaceIdentity,
} from "./workspace-registry.ts";
import { channelLogPath, ocsHome, readMessages, CHANNEL_RE, NAME_RE } from "./store.ts";
import {
  claudeEntryMatches,
  claudeShortId,
  listOcsNames,
  ocsNameFor,
  readOcsName,
  type NameOwner,
  type OcsNameEntry,
} from "./names.ts";

export const OCS_NAME_ENV = "OCS_NAME";
export const CODEX_THREAD_ID_ENV = "CODEX_THREAD_ID";
const CODEX_SHORT_TARGET_RE = /^codex-([0-9a-f]{8})$/i;
const CODEX_FULL_TARGET_PREFIX_RE = /^codex-/i;
const PI_SHORT_TARGET_RE = /^pi-([0-9a-f]{8})$/i;
const CLAUDE_SHORT_TARGET_RE = /^claude-([0-9a-f]{8})$/i;
export {
  claudeWorkspaceAlias,
  uniqueClaudeWorkspaceAlias,
  uniqueClaudeWorkspaceIdentity,
} from "./claude-address.ts";

function safeVerifiedWorkspaceIdentity(
  session: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv,
): VerifiedWorkspaceIdentity {
  try {
    return verifiedClaudeWorkspaceIdentity(session, sessions, env);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      identity: null,
      warning:
        `${detail}; session-scoped DM remains available. ` +
        "Restore the original workspace-key to recover continuity; if it is gone, start new identity state and use --inherit for old history.",
    };
  }
}

/**
 * 识别「我是谁」：--as > $OCS_NAME > Pi session id > Claude 原生会话 > Codex thread id > Hermes 会话。
 * Hermes 排最后：它把 HERMES_SESSION_ID 注入每条终端命令，在 Hermes 里开的 Claude/Codex 也会继承。
 * agent 在自己的会话里跑 ocs 时自动识别，人一个字都不用打。
 */
/** Keep valid legacy sender names; free-form desktop titles need a wire-safe ID. */
export function claudeSenderName(session: Pick<NativeClaudeSession, "name" | "sessionId">): string | null {
  if (session.name !== null && NAME_RE.test(session.name)) return session.name;
  return claudeShortId(session.sessionId);
}
export function resolveSelfName(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[OCS_NAME_ENV];
  if (typeof explicit === "string" && NAME_RE.test(explicit)) return explicit;
  const grokId = selfGrokSessionId(env);
  if (grokId !== null) return grokTargetName(grokId);
  const piSessionId = env[OCS_PI_SESSION_ID_ENV];
  if (typeof piSessionId === "string" && isPiSessionId(piSessionId)) return piTargetName(piSessionId);
  const pid = findSelfClaudePid(env);
  if (pid !== null) {
    const session = listNativeSessions(env).find((s) => s.pid === pid);
    // A detected Claude session must not borrow a different harness's inherited
    // identity when neither its display name nor session ID is addressable.
    if (session !== undefined) return claudeSenderName(session);
  }
  const codexThreadId = env[CODEX_THREAD_ID_ENV];
  if (typeof codexThreadId === "string" && isCodexThreadId(codexThreadId)) return codexThreadId.toLowerCase();
  const ocId = selfOpenCodeSessionId(env);
  if (ocId !== null) return opencodeTargetName(ocId);
  const hermesKey = selfHermesSessionKey(env);
  return hermesKey === null ? null : hermesTargetName(hermesKey);
}

/**
 * dm 频道名：按参与者完整命名空间身份排序 + 哈希派生，双方各自算都得到同一个频道。
 * 频道名里掺 40 位 hex（160-bit 截断 sha256，git 同级强度）的身份对哈希：slug 只为可读性，唯一性完全由哈希保证——
 * 否则清洗（大小写折叠、`.`→`-`）、64 字符截断、分隔符歧义（`a--b`+`c` 与
 * `a`+`b--c` 同串）都会把不同名字对合并进同一频道，停靠的私信就可能被
 * 无关身份读走（review 发现）。更短的截断（如 32 位）生日界太低且可被蓄意碾磨出碰撞，160 位不可行。
 */
export function dmChannel(a: string, b: string): string {
  // 入参必须是全长命名空间身份（name/codex/cmux/workspace），不许传截断别名。
  const [x, y] = [a, b].sort() as [string, string];
  const hash = createHash("sha256").update(`${x}\u0000${y}`).digest("hex").slice(0, 40);
  const clean = (name: string) => {
    const readable = /^workspace:[0-9a-f]{64}$/.test(name)
      ? "workspace"
      : name.replace(/^name:|^codex:|^cmux:/, "");
    return readable.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  };
  const slug = `${clean(x)}--${clean(y)}`.slice(0, 64 - (3 + 40 + 2));
  const channel = `dm-${hash}--${slug}`;
  if (!CHANNEL_RE.test(channel)) throw new Error(`cannot derive dm channel from: ${a}, ${b}`);
  return channel;
}

// ───────────────────────── cmux（可选加速器，绝不必装） ─────────────────────────

export interface CmuxSurface {
  ref: string;
  title: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cmuxAvailable(): boolean {
  try {
    return spawnSync("cmux", ["ping"], { encoding: "utf8", timeout: 2000 }).status === 0;
  } catch {
    return false;
  }
}

const SURFACE_RE = /surface (surface:\d+) \[terminal\] "((?:[^"\\]|\\.)*)"/;

export function listCmuxSurfaces(): CmuxSurface[] {
  let out: string;
  try {
    const proc = spawnSync("cmux", ["tree", "--all"], { encoding: "utf8", timeout: 5000 });
    if (proc.status !== 0) return [];
    out = proc.stdout;
  } catch {
    return [];
  }
  const surfaces: CmuxSurface[] = [];
  for (const line of out.split("\n")) {
    const match = SURFACE_RE.exec(line);
    if (match) surfaces.push({ ref: match[1]!, title: match[2]! });
  }
  return surfaces;
}

/**
 * 从 `cmux top --all --processes --json` 里只取仍有前台 Codex 进程的 terminal surface。
 * 自动降级绝不能只信可能陈旧/可伪造的标题，否则 Codex 退出后会把唤醒正文敲进 shell。
 */
export function parseActiveCodexCmuxSurfaces(value: unknown): CmuxSurface[] {
  const surfaces: CmuxSurface[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!record(node)) return;
    if (
      node.kind === "surface" &&
      typeof node.ref === "string" && /^surface:\d+$/.test(node.ref) &&
      typeof node.title === "string" &&
      Array.isArray(node.processes) &&
      node.processes.some((process) =>
        record(process) && process.kind === "process" && process.name === "codex"
      )
    ) {
      if (!seen.has(node.ref)) {
        seen.add(node.ref);
        surfaces.push({ ref: node.ref, title: node.title });
      }
      return;
    }
    for (const child of Object.values(node)) visit(child);
  };
  visit(value);
  return surfaces;
}

function listActiveCodexCmuxSurfaces(): CmuxSurface[] {
  try {
    const proc = spawnSync("cmux", ["top", "--all", "--processes", "--json"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (proc.status !== 0) return [];
    return parseActiveCodexCmuxSurfaces(JSON.parse(proc.stdout) as unknown);
  } catch {
    return [];
  }
}

/**
 * #30：给 Desktop 未认领的 Codex task 找唯一的活 cmux TUI 兜底。
 * cmux 自动标题以 `codex-<8hex>[-suffix]` 收尾；多命中或非活 Codex surface 都 fail closed。
 */
export function findCodexCmuxSurface(
  threadId: string,
  surfaces?: readonly CmuxSurface[],
): CmuxSurface | null {
  if (!isCodexThreadId(threadId)) return null;
  const prefix = threadId.slice(0, 8).toLowerCase();
  const suffix = new RegExp(`(?:^|[^a-z0-9])codex-${prefix}(?:-[0-9a-f]+)?$`, "i");
  const matches = (surfaces ?? listActiveCodexCmuxSurfaces())
    .filter(({ title }) => suffix.test(title.trim()));
  return matches.length === 1 ? matches[0]! : null;
}

export type CmuxWakeResult =
  | { ok: true; ref: string }
  | { ok: false; reason: "unavailable" | "busy" | "failed"; detail?: string };

/**
 * 经 cmux 唤醒一个终端 TUI（按 surface 寻址，不是全局键盘）。
 * 忙碌（正在跑一轮）时不打扰——消息已在频道里，对方空下来自己会读；
 * 往正在工作的 TUI 敲回车有打断风险，宁可不唤。
 */
export function wakeCmuxSurface(ref: string, note: string): CmuxWakeResult {
  if (!cmuxAvailable()) return { ok: false, reason: "unavailable" };
  try {
    const screen = spawnSync("cmux", ["read-screen", "--surface", ref, "--lines", "8"], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (screen.status !== 0) {
      return { ok: false, reason: "failed", detail: screen.stderr.trim() || "read-screen failed" };
    }
    if (screen.stdout.includes("to interrupt")) return { ok: false, reason: "busy" };
    const send = spawnSync("cmux", ["send", "--surface", ref, note], { encoding: "utf8", timeout: 5000 });
    if (send.status !== 0) {
      return { ok: false, reason: "failed", detail: send.stderr.trim() || "send failed" };
    }
    const enter = spawnSync("cmux", ["send-key", "--surface", ref, "enter"], { encoding: "utf8", timeout: 5000 });
    if (enter.status !== 0) {
      return { ok: false, reason: "failed", detail: enter.stderr.trim() || "send-key failed" };
    }
    return { ok: true, ref };
  } catch (error) {
    return { ok: false, reason: "failed", detail: String(error) };
  }
}

// ───────────────────────── 统一花名册 ─────────────────────────

export type RosterEntry =
  | {
      kind: "claude";
      name: string;
      /** 不变短 id `claude-<sessionId 前 8 hex>`；sessionId 缺失或非 hex 时没有。 */
      id?: string;
      /** `ocs rename` 起的名字。 */
      ocsName?: string;
      workspaceAlias?: string;
      workspaceWarning?: string;
      pid: number;
      status: string | null;
      cwd: string | null;
      self: boolean;
    }
  | {
      kind: "codex-task";
      target: string;
      threadId: string;
      ocsName?: string;
      summary: string | null;
      cwd: string | null;
      self: boolean;
      /** 持有该 thread rollout fd 的进程；非 null 即证明会话在跑（`codex queue` 可达）。 */
      livePid: number | null;
      /** 活会话的控制终端（`ttys002`）；Desktop 托管等无 tty 的为 null。 */
      tty: string | null;
      /** 活会话的宿主应用（Terminal / iTerm2 / ChatGPT …）；查不到为 null。 */
      hostApp: string | null;
    }
  | {
      kind: "pi";
      /** 可直接交给 `ocs dm` 的唯一短地址。 */
      target: string;
      sessionId: string;
      name: string | null;
      ocsName?: string;
      pid: number;
      cwd: string;
      self: boolean;
    }
  | {
      kind: "hermes";
      /** `hermes-<session key>`：可直接交给 `ocs dm`。 */
      target: string;
      sessionKey: string;
      title: string | null;
      ocsName?: string;
      /** Hermes 自己的状态词：idle / working / starting / waiting。 */
      status: string | null;
      self: boolean;
    }
  | { kind: "opencode"; target: string; shortId: string; sessionId: string; name: string | null; pid: number; cwd: string; self: boolean; ocsName?: string }
  | { kind: "grok"; target: string; sessionId: string; cwd: string; title: string | null; status: string; self: boolean; ocsName?: string }
  | { kind: "agy"; target: "agy"; pid: number; cwd: string; status: string; self: boolean; ocsName: "agy" }
  | { kind: "cmux"; ref: string; title: string };

export interface Roster {
  entries: RosterEntry[];
  codexIpc: boolean;
  /** `codex queue` 可用性；false 时终端里的 codex 只能靠 Desktop IPC / cmux 够。 */
  codexQueue: boolean;
  cmux: boolean;
  home: string;
}

/**
 * `hermes`：调用方先 await `listHermesSessions()` 拿到的活会话（要连 WebSocket，这里是同步的）。
 * 不传就不列 Hermes。
 */
export function buildRoster(env: NodeJS.ProcessEnv = process.env, hermes: readonly HermesSession[] = [], grok: readonly GrokSession[] = []): Roster {
  const entries: RosterEntry[] = [];
  const agy = findAgyWorker(env);
  if (agy !== null) entries.push({ kind: "agy", target: "agy", pid: agy.pid, cwd: agy.cwd, status: agy.status, self: env.OCS_NAME === "agy", ocsName: "agy" });
  const selfPid = findSelfClaudePid(env);
  const nativeSessions = listNativeSessions(env).filter((session) => session.name !== null);
  const names = listOcsNames(env);
  for (const s of nativeSessions) {
    if (s.name === null) continue;
    const rawAlias = claudeWorkspaceAlias(s);
    const alias = shadowFreeWorkspaceAlias(s, nativeSessions, names);
    let workspaceWarning: string | undefined;
    if (rawAlias !== null && alias === null) {
      workspaceWarning =
        `workspace alias ${rawAlias} is shared or collides with a live exact name or ocs name; using session-scoped DM`;
    } else {
      workspaceWarning = safeVerifiedWorkspaceIdentity(s, nativeSessions, env).warning;
    }
    const id = claudeShortId(s.sessionId);
    const ocsName = ocsNameFor({ kind: "claude", session: s }, names)?.name;
    entries.push({
      kind: "claude",
      name: s.name,
      ...(id === null ? {} : { id }),
      ...(ocsName === undefined ? {} : { ocsName }),
      ...(alias !== null && alias !== s.name ? { workspaceAlias: alias } : {}),
      ...(workspaceWarning === undefined ? {} : { workspaceWarning }),
      pid: s.pid,
      status: s.status,
      cwd: s.cwd ?? null,
      self: s.pid === selfPid,
    });
  }
  const codexIpc = codexDesktopIpcAvailable(env);
  const selfCodexThreadId = isCodexThreadId(env[CODEX_THREAD_ID_ENV] ?? "")
    ? env[CODEX_THREAD_ID_ENV]!.toLowerCase()
    : null;
  const root = codexSessionsRoot(env);
  const files = listCodexRolloutFiles(root);
  const ps = psTable(env);
  // Check every rollout for liveness before limiting historical Desktop candidates.
  // Long-running threads can be days older than the ten newest, already-exited tasks.
  const codexLive = codexThreadLivePids(files.map((file) => file.threadId), env, ps);
  const candidateIds = new Set([...files.slice(0, 10).map((file) => file.threadId), ...codexLive.keys()]);
  const codexSessions = listCodexSessions(root, { limit: candidateIds.size, threadIds: candidateIds });
  // 宿主（tty + GUI 应用）只对活会话有意义，一次 ps 全解出来。
  const codexHostByPid = codexHosts([...new Set(codexLive.values())], env, ps);
  for (const s of codexSessions) {
    const livePid = codexLive.get(s.threadId) ?? null;
    const host = livePid === null ? undefined : codexHostByPid.get(livePid);
    const ocsName = ocsNameFor({ kind: "codex", id: s.threadId }, names)?.name;
    entries.push({
      kind: "codex-task",
      target: `codex-${s.threadId.slice(0, 8)}`,
      threadId: s.threadId,
      ...(ocsName === undefined ? {} : { ocsName }),
      summary: s.summary,
      cwd: s.cwd,
      self: s.threadId === selfCodexThreadId,
      livePid,
      tty: host?.tty ?? null,
      hostApp: host?.app ?? null,
    });
  }
  const selfPiSessionId = env[OCS_PI_SESSION_ID_ENV]?.toLowerCase();
  for (const s of listPiSessions(env)) {
    const ocsName = ocsNameFor({ kind: "pi", id: s.session_id }, names)?.name;
    entries.push({
      kind: "pi",
      target: `pi-${s.session_id.slice(0, 8)}`,
      sessionId: s.session_id,
      name: s.name,
      ...(ocsName === undefined ? {} : { ocsName }),
      pid: s.pid,
      cwd: s.cwd,
      self: selfPiSessionId === s.session_id,
    });
  }
  const openCodeOwner = selfNameOwner(env);
  for (const session of listOpenCodeSessions(env)) {
    const ocsName = ocsNameFor({ kind: "opencode", id: session.session_id }, names)?.name;
    entries.push({ kind: "opencode", target: opencodeTargetName(session.session_id), shortId: openCodeShortId(session.session_id), sessionId: session.session_id,
      name: session.name, pid: session.pid, cwd: session.cwd, self: openCodeOwner?.kind === "opencode" && openCodeOwner.id === session.session_id,
      ...(ocsName === undefined ? {} : { ocsName }) });
  }
  const selfHermesKey = selfHermesSessionKey(env);
  for (const s of hermes) {
    const ocsName = ocsNameFor({ kind: "hermes", id: s.key }, names)?.name;
    entries.push({
      kind: "hermes",
      target: hermesTargetName(s.key),
      sessionKey: s.key,
      title: s.title,
      ...(ocsName === undefined ? {} : { ocsName }),
      status: s.status,
      self: selfHermesKey === s.key,
    });
  }
  for (const s of grok) {
    const ocsName = ocsNameFor({ kind: "grok", id: s.id }, names)?.name;
    entries.push({ kind: "grok", target: grokTargetName(s.id), sessionId: s.id, cwd: s.cwd, title: s.title, status: s.status,
      self: selfGrokSessionId(env) === s.id, ...(ocsName === undefined ? {} : { ocsName }) });
  }
  const cmux = cmuxAvailable();
  if (cmux) {
    for (const s of listCmuxSurfaces()) {
      entries.push({ kind: "cmux", ref: s.ref, title: s.title });
    }
  }
  return { entries, codexIpc, codexQueue: codexQueueAvailable(env), cmux, home: ocsHome(env) };
}

export type DmTargetKind = "opencode" | "claude" | "codex-task" | "pi" | "hermes" | "grok" | "agy" | "cmux";

export interface ResolvedDmTarget {
  kind: DmTargetKind;
  /** 展示/slug 用短名。⚠️ 只做可读性，绝不参与频道派生。 */
  name: string;
  /**
   * 频道派生用的注入式身份串：`name:<全名>` / `codex:<完整thread id>` /
   * `cmux:<surface ref>`。workspace 身份单独放在 workspaceIdentity。冒号不在 NAME_RE
   * 字符集里，各命名空间互不可能
   * 拼出同一串；且恒为全长——哈希再强，喂截断别名照样碰撞（review 发现：
   * codex 别名只含 thread id 前 8 hex）。
   */
  identity: string;
  claude?: NativeClaudeSession;
  /** 请求使用了工作区别名。 */
  workspaceAlias?: string;
  /** 活会话或本机持久索引给出的稳定工作区身份。 */
  workspaceIdentity?: string;
  /** 持久身份与本机索引冲突时的可执行诊断。 */
  workspaceWarning?: string;
  /** 同一别名对应多个活会话时列出候选；调用方必须拒绝发送。 */
  ambiguousClaudeTargets?: string[];
  /** 同一 Pi session id 被多个活进程打开时，必须显式消歧，绝不任选一个。 */
  ambiguousPiTargets?: string[];
  /** `codex-<8hex>` 命中多个本地 rollout 时必须拒绝任选。 */
  ambiguousCodexTargets?: string[];
  /** ocs 名字与活会话精确名撞车、或 `claude-<8hex>` 多命中：拒绝任选。 */
  ambiguousNameTargets?: string[];
  /** 经 ocs 名字或 `claude-<8hex>` 短 id 解析到的（调用方据此提示解析结果）。 */
  via?: "ocs-name" | "short-id";
  threadId?: string;
  piSession?: PiSessionRegistration;
  piSessionId?: string;
  /** Hermes 会话的持久 id。在不在线只有投递时连宿主才知道（解析是同步的）。 */
  hermesSessionKey?: string;
  grokSessionId?: string;
  openCodeSessionId?: string;
  openCodeSession?: OpenCodeSessionRegistration;
  cmuxRef?: string;
}

/**
 * Claude 会话的会话级 DM 身份（#36）：有 hex sessionId 就按它（跨重启/改名不变，
 * cmux restore 也保留），否则才退回会随自动名字变化的 `name:<名字>`。
 */
export function claudeSessionIdentity(session: Pick<NativeClaudeSession, "name" | "sessionId">): string {
  const id = session.sessionId;
  if (id !== null && /^[0-9a-f]{8}/i.test(id)) return `claude:${id.toLowerCase()}`;
  return `name:${session.name!}`;
}

/** 发送方的注入式身份串（与 ResolvedDmTarget.identity 同一命名空间规则）。 */
export function selfIdentity(from: string): string {
  const ocId = opencodeSessionIdFromTarget(from);
  if (ocId !== null) return `opencode:${ocId}`;
  const grokId = grokSessionIdFromTarget(from);
  if (grokId !== null) return `grok:${grokId}`;
  const piSessionId = piSessionIdFromTarget(from);
  if (piSessionId !== null) return `pi:${piSessionId}`;
  const hermesKey = hermesSessionKeyFromTarget(from);
  if (hermesKey !== null) return hermesIdentity(hermesKey);
  if (isCodexThreadId(from)) return `codex:${from.toLowerCase()}`;
  return `name:${from}`;
}

/**
 * 反向 dm 的会话收敛（review 发现：跨载体反向 dm 会派生到另一个频道）。
 * 正向 dm 到 codex/cmux 目标时频道按载体身份派生；对方回 dm 时用的是自己的
 * *名字*身份，反向派生必然得到另一个频道。收敛依据是已落盘的参与状态：
 * 被唤醒方按指针 `ocs read <channel> --as <me>` 会留下游标文件——反向 dm 前
 * 先找「我有游标、且目标以 from 名义发过言」的 dm 频道，命中即续用同一频道。
 * 多个命中取日志最近活跃的（同一对人之间的会话，错档不越权）。
 */
export function findDmReplyChannel(
  from: string,
  targetName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let files: string[];
  try {
    files = readdirSync(join(ocsHome(env), "cursors"));
  } catch {
    return null;
  }
  const suffix = `.${from}.json`;
  const candidates: Array<{ channel: string; mtime: number }> = [];
  for (const file of files) {
    if (!file.endsWith(suffix)) continue;
    const channel = file.slice(0, -suffix.length);
    if (!channel.startsWith("dm-") || !CHANNEL_RE.test(channel)) continue;
    let fromTarget = false;
    try {
      fromTarget = readMessages(channel, { env }).some((m) => m.from === targetName);
    } catch {
      continue;
    }
    if (!fromTarget) continue;
    let mtime = 0;
    try {
      mtime = statSync(channelLogPath(channel, env)).mtimeMs;
    } catch {
      // 日志刚被清理；跳过
      continue;
    }
    candidates.push({ channel, mtime });
  }
  candidates.sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.channel ?? null;
}

function claudeTarget(
  session: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv,
): ResolvedDmTarget {
  const workspaceAlias = uniqueClaudeWorkspaceAlias(session, sessions);
  const workspace = safeVerifiedWorkspaceIdentity(session, sessions, env);
  return {
    kind: "claude",
    name: session.name!,
    identity: claudeSessionIdentity(session),
    claude: session,
    ...(workspaceAlias === null ? {} : { workspaceAlias }),
    ...(workspace.identity === null ? {} : { workspaceIdentity: workspace.identity }),
    ...(workspace.warning === undefined ? {} : { workspaceWarning: workspace.warning }),
  };
}

/** ocs 名字 → 底层会话。Claude 离线时仍返回名字身份，由调用方按「未唤醒、仅落盘」处理。 */
function resolveNamedTarget(
  named: OcsNameEntry,
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv,
): ResolvedDmTarget {
  if (named.kind === "codex") return { ...resolveDmTarget(named.id, env)!, via: "ocs-name" };
  if (named.kind === "pi") return { ...resolveDmTarget(piTargetName(named.id), env)!, via: "ocs-name" };
  if (named.kind === "hermes") return { ...resolveDmTarget(hermesTargetName(named.id), env)!, via: "ocs-name" };
  if (named.kind === "opencode") return { ...resolveDmTarget(opencodeTargetName(named.id), env)!, via: "ocs-name" };
  if (named.kind === "grok") return { ...resolveDmTarget(grokTargetName(named.id), env)!, via: "ocs-name" };
  const live = sessions.find((candidate) => claudeEntryMatches(named, candidate));
  if (live !== undefined) return { ...claudeTarget(live, sessions, env), via: "ocs-name" };
  return {
    kind: "claude",
    name: named.name,
    identity: /^[0-9a-f]{8}/i.test(named.id) ? `claude:${named.id.toLowerCase()}` : `name:${named.name}`,
    via: "ocs-name",
  };
}

/**
 * 工作区别名只在没被别的身份的 ocs 名字遮蔽时才能对外宣告：解析顺序里 ocs 名字在前，
 * 被遮蔽的别名写进 Reply 行或 `ocs who`，别人照抄就会投给名字的主人。
 */
export function shadowFreeWorkspaceAlias(
  session: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
  names: readonly OcsNameEntry[],
): string | null {
  const alias = uniqueClaudeWorkspaceAlias(session, sessions);
  if (alias === null) return null;
  const owner = names.find((entry) => entry.name.toLowerCase() === alias.toLowerCase());
  return owner === undefined || claudeEntryMatches(owner, session) ? alias : null;
}

/** 当前进程所在的宿主会话（`ocs rename` 的对象）。顺序同 resolveSelfName，但不看 OCS_NAME。 */
export function selfNameOwner(env: NodeJS.ProcessEnv = process.env): NameOwner | null {
  const grokId = selfGrokSessionId(env);
  if (grokId !== null) return { kind: "grok", id: grokId };
  const piSessionId = env[OCS_PI_SESSION_ID_ENV];
  if (typeof piSessionId === "string" && isPiSessionId(piSessionId)) {
    return { kind: "pi", id: piSessionId.toLowerCase() };
  }
  const pid = findSelfClaudePid(env);
  if (pid !== null) {
    const session = listNativeSessions(env).find((candidate) => candidate.pid === pid);
    if (session !== undefined && session.sessionId !== null) return { kind: "claude", session };
  }
  const codexThreadId = env[CODEX_THREAD_ID_ENV];
  if (typeof codexThreadId === "string" && isCodexThreadId(codexThreadId)) {
    return { kind: "codex", id: codexThreadId.toLowerCase() };
  }
  const ocId = selfOpenCodeSessionId(env);
  if (ocId !== null) return { kind: "opencode", id: ocId };
  const hermesKey = selfHermesSessionKey(env);
  return hermesKey === null ? null : { kind: "hermes", id: hermesKey };
}

/**
 * @mention 的归一：ocs 名字与各家短 id 换成唤醒分流认得的地址（Codex 完整 thread id、
 * `pi-<完整 id>`、Claude 原生会话名）。活会话精确名、无法唯一解析的一律原样返回，
 * 交给既有的「没有匹配」报告。
 */
export function canonicalWakeAddress(address: string, env: NodeJS.ProcessEnv = process.env): string {
  if (
    !NAME_RE.test(address) ||
    isCodexThreadId(address) ||
    piSessionIdFromTarget(address) !== null ||
    hermesSessionKeyFromTarget(address) !== null
  ) return address;
  const shortId = CLAUDE_SHORT_TARGET_RE.test(address) ||
    CODEX_SHORT_TARGET_RE.test(address) ||
    PI_SHORT_TARGET_RE.test(address) || /^oc-[0-9a-f]{8}$/.test(address);
  // 只在确实可能改写时才走完整解析：普通名字的解析会顺带写工作区索引。
  if (!shortId && readOcsName(address, env) === null) return address;
  const resolved = resolveDmTarget(address, env);
  if (
    resolved === null ||
    resolved.ambiguousNameTargets !== undefined ||
    resolved.ambiguousCodexTargets !== undefined ||
    resolved.ambiguousPiTargets !== undefined
  ) return address;
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) return resolved.threadId;
  if (resolved.kind === "pi" && resolved.piSessionId !== undefined) return piTargetName(resolved.piSessionId);
  if (resolved.kind === "hermes" && resolved.hermesSessionKey !== undefined) return hermesTargetName(resolved.hermesSessionKey);
  if (resolved.kind === "opencode" && resolved.openCodeSessionId !== undefined) return opencodeTargetName(resolved.openCodeSessionId);
  if (resolved.kind === "grok" && resolved.grokSessionId !== undefined) return grokTargetName(resolved.grokSessionId);
  if (resolved.kind === "claude" && resolved.claude?.name) return resolved.claude.name;
  return address;
}

/**
 * 把 dm 目标字符串解析到四个命名空间之一：surface:N → cmux；uuid → codex；
 * pi-<uuid> → Pi；否则 Claude 会话名。名字合法但当前无活会话时**不报错**——返回无 session 的
 * claude 目标，调用方把消息停靠进频道（离线投递=持久化的承诺靠这里兑现），
 * 只有格式非法才返回 null。
 */
export function resolveDmTarget(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDmTarget | null {
  const ocId = opencodeSessionIdFromTarget(target);
  const ocShort = /^oc-[0-9a-f]{8}$/.test(target);
  if (ocId !== null || ocShort) {
    const matches = listOpenCodeSessions(env).filter((session) => ocId !== null ? session.session_id === ocId : openCodeShortId(session.session_id) === target);
    if (matches.length > 1) return { kind: "opencode", name: target, identity: `name:${target}`,
      ambiguousNameTargets: matches.map((s) => `${s.target}(pid ${s.pid}, cwd ${s.cwd})`) };
    const id = ocId ?? matches[0]?.session_id;
    if (id === undefined) return null;
    return { kind: "opencode", name: opencodeTargetName(id), identity: `opencode:${id}`, openCodeSessionId: id,
      ...(matches[0] === undefined ? {} : { openCodeSession: matches[0] }) };
  }
  const grokId = grokSessionIdFromTarget(target);
  if (grokId !== null) return { kind: "grok", name: grokTargetName(grokId), identity: `grok:${grokId}`, grokSessionId: grokId };
  if (target.toLowerCase() === "agy") {
    const named = readOcsName("agy", env);
    const collision = listNativeSessions(env).find((session) => session.name?.toLowerCase() === "agy");
    return { kind: "agy", name: "agy", identity: "name:agy",
      ...(named === null && collision === undefined ? {} : { ambiguousNameTargets: [
        "agy (Antigravity CLI receiver)",
        named === null ? `agy (Claude session ${collision?.sessionId ?? "unknown"})` : `agy (${named.kind} ${named.id})`,
      ] }),
    };
  }
  if (/^surface:\d+$/.test(target)) {
    return { kind: "cmux", name: target.replace(":", "-"), identity: `cmux:${target}`, cmuxRef: target };
  }
  // #62: `codex-<full uuid>` is the same thread as the bare UUID. Treating it as a
  // plain name derived a `name:` identity the thread could never claim from `ocs inbox`.
  const codexThreadId = target.replace(CODEX_FULL_TARGET_PREFIX_RE, "");
  if (isCodexThreadId(codexThreadId)) {
    return {
      kind: "codex-task",
      name: `codex-${codexThreadId.slice(0, 8).toLowerCase()}`,
      identity: `codex:${codexThreadId.toLowerCase()}`,
      threadId: codexThreadId.toLowerCase(),
    };
  }
  const codexShort = CODEX_SHORT_TARGET_RE.exec(target);
  if (codexShort !== null) {
    const prefix = codexShort[1]!.toLowerCase();
    // 只扫固定布局下的文件名，不读每份 rollout 的 512 KiB 头部。
    const matches = listCodexRolloutFiles(codexSessionsRoot(env))
      .filter((session) => session.threadId.startsWith(prefix));
    if (matches.length === 1) {
      const threadId = matches[0]!.threadId;
      return {
        kind: "codex-task",
        name: `codex-${prefix}`,
        identity: `codex:${threadId}`,
        threadId,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "codex-task",
        name: `codex-${prefix}`,
        identity: `codex:${prefix}`,
        ambiguousCodexTargets: matches.map((session) => session.threadId),
      };
    }
  }
  const piShort = PI_SHORT_TARGET_RE.exec(target);
  if (piShort !== null) {
    const prefix = piShort[1]!.toLowerCase();
    const matches = listPiSessions(env).filter((session) => session.session_id.startsWith(prefix));
    if (matches.length === 1) {
      const session = matches[0]!;
      return {
        kind: "pi",
        name: session.target,
        identity: `pi:${session.session_id}`,
        piSessionId: session.session_id,
        piSession: session,
      };
    }
    if (matches.length > 1) {
      return {
        kind: "pi",
        name: target,
        identity: `pi:${prefix}`,
        ambiguousPiTargets: matches.map((session) =>
          `${session.target}(pid ${session.pid}, cwd ${session.cwd})`
        ),
      };
    }
  }
  const piSessionId = piSessionIdFromTarget(target);
  if (piSessionId !== null) {
    const matches = listPiSessions(env).filter((session) => session.session_id === piSessionId);
    if (matches.length > 1) {
      return {
        kind: "pi",
        name: piTargetName(piSessionId),
        identity: `pi:${piSessionId}`,
        piSessionId,
        ambiguousPiTargets: matches.map((session) =>
          `${session.target}(pid ${session.pid}, cwd ${session.cwd})`
        ),
      };
    }
    return {
      kind: "pi",
      name: piTargetName(piSessionId),
      identity: `pi:${piSessionId}`,
      piSessionId,
      ...(matches[0] === undefined ? {} : { piSession: matches[0] }),
    };
  }
  const hermesKey = hermesSessionKeyFromTarget(target);
  if (hermesKey !== null) {
    return { kind: "hermes", name: hermesTargetName(hermesKey), identity: hermesIdentity(hermesKey), hermesSessionKey: hermesKey };
  }
  if (!NAME_RE.test(target)) return null;
  const sessions = listNativeSessions(env).filter((session) => session.name !== null);
  const session = sessions.find((candidate) => candidate.name === target);
  // 顺序：活会话精确名 > ocs 名字 > claude-<8hex> > 工作区别名。精确名与 ocs 名字指向
  // 不同会话时不许任选——哪个赢都可能把私信投给另一个人。
  const named = readOcsName(target, env);
  if (named !== null) {
    const viaName = resolveNamedTarget(named, sessions, env);
    if (session !== undefined && viaName.claude?.pid !== session.pid) {
      return {
        kind: "claude",
        name: target,
        identity: `name:${target}`,
        ambiguousNameTargets: [
          `${session.name!}(live session, pid ${session.pid})`,
          `${named.name}(ocs name → ${named.kind} ${named.id})`,
        ],
      };
    }
    if (session === undefined) return viaName;
  }
  if (session !== undefined) return claudeTarget(session, sessions, env);
  const claudeShort = CLAUDE_SHORT_TARGET_RE.exec(target);
  if (claudeShort !== null) {
    const prefix = claudeShort[1]!.toLowerCase();
    const matches = sessions.filter((candidate) => candidate.sessionId?.toLowerCase().startsWith(prefix) === true);
    if (matches.length === 1) return { ...claudeTarget(matches[0]!, sessions, env), via: "short-id" };
    if (matches.length > 1) {
      return {
        kind: "claude",
        name: target,
        identity: `name:${target}`,
        ambiguousNameTargets: matches.map((candidate) => `${candidate.name!}(pid ${candidate.pid})`),
      };
    }
  }
  const aliasMatches = sessions.filter((candidate) => claudeWorkspaceTargetMatches(candidate, target));
  if (aliasMatches.length === 1) {
    const matched = aliasMatches[0]!;
    const alias = claudeWorkspaceAlias(matched)!;
    const workspace = safeVerifiedWorkspaceIdentity(matched, sessions, env);
    return {
      kind: "claude",
      name: matched.name!,
      identity: claudeSessionIdentity(matched),
      claude: matched,
      workspaceAlias: alias,
      ...(workspace.identity === null ? {} : { workspaceIdentity: workspace.identity }),
      ...(workspace.warning === undefined ? {} : { workspaceWarning: workspace.warning }),
    };
  }
  if (aliasMatches.length > 1) {
    return {
      kind: "claude",
      name: target,
      identity: `name:${target}`,
      workspaceAlias: claudeWorkspaceAlias(aliasMatches[0]!) ?? target,
      ambiguousClaudeTargets: aliasMatches
        .map((candidate) => `${candidate.name!}(pid ${candidate.pid}, cwd ${candidate.cwd ?? "?"})`)
        .sort(),
    };
  }
  const knownWorkspaces = knownClaudeWorkspaceIdentities(target, env);
  if (knownWorkspaces.length === 1) {
    return {
      kind: "claude",
      name: target,
      identity: `name:${target}`,
      workspaceAlias: target,
      workspaceIdentity: knownWorkspaces[0]!,
    };
  }
  if (knownWorkspaces.length > 1) {
    return {
      kind: "claude",
      name: target,
      identity: `name:${target}`,
      workspaceAlias: target,
      ambiguousClaudeTargets: knownWorkspaces.map((identity) => `saved workspace ${identity.slice(10, 22)}`),
    };
  }
  return {
    kind: "claude",
    name: target,
    identity: `name:${target}`,
  };
}
