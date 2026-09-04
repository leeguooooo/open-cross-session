// 全机 agent 花名册与直发（dm）支撑：发现任意 agent、识别自己、派生 dm 频道。
//
// 目标体验：人只说自然语言，agent 自己跑 `ocs who` 发现同伴、`ocs dm` 搭话。
// 四个命名空间统一在这里：Claude 原生会话（UDS 可唤醒）、ChatGPT Desktop 任务
// （IPC 可唤醒）、Pi 会话（扩展 UDS 可唤醒）、cmux surface（可选加速器，探测到才列）。

import { spawnSync } from "node:child_process";
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
import { codexSessionsRoot, isCodexThreadId, listCodexSessions } from "./codex-sessions.ts";
import {
  isPiSessionId,
  listPiSessions,
  OCS_PI_SESSION_ID_ENV,
  piSessionIdFromTarget,
  piTargetName,
  type PiSessionRegistration,
} from "./pi-sessions.ts";
import { findSelfClaudePid } from "./wake.ts";
import {
  knownClaudeWorkspaceIdentities,
  type VerifiedWorkspaceIdentity,
  verifiedClaudeWorkspaceIdentity,
} from "./workspace-registry.ts";
import { channelLogPath, ocsHome, readMessages, CHANNEL_RE, NAME_RE } from "./store.ts";

export const OCS_NAME_ENV = "OCS_NAME";
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
 * 识别「我是谁」：--as > $OCS_NAME > Pi 扩展 session id > 进程祖先链上的 Claude 原生会话名。
 * agent 在自己的会话里跑 ocs 时自动识别，人一个字都不用打。
 */
export function resolveSelfName(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[OCS_NAME_ENV];
  if (typeof explicit === "string" && NAME_RE.test(explicit)) return explicit;
  const piSessionId = env[OCS_PI_SESSION_ID_ENV];
  if (typeof piSessionId === "string" && isPiSessionId(piSessionId)) return piTargetName(piSessionId);
  const pid = findSelfClaudePid(env);
  if (pid === null) return null;
  const session = listNativeSessions(env).find((s) => s.pid === pid);
  return session?.name ?? null;
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
      workspaceAlias?: string;
      workspaceWarning?: string;
      pid: number;
      status: string | null;
      self: boolean;
    }
  | { kind: "codex-task"; threadId: string; summary: string | null; cwd: string | null }
  | {
      kind: "pi";
      target: string;
      sessionId: string;
      name: string | null;
      pid: number;
      cwd: string;
      self: boolean;
    }
  | { kind: "cmux"; ref: string; title: string };

export interface Roster {
  entries: RosterEntry[];
  codexIpc: boolean;
  cmux: boolean;
  home: string;
}

export function buildRoster(env: NodeJS.ProcessEnv = process.env): Roster {
  const entries: RosterEntry[] = [];
  const selfPid = findSelfClaudePid(env);
  const nativeSessions = listNativeSessions(env).filter((session) => session.name !== null);
  for (const s of nativeSessions) {
    if (s.name === null) continue;
    const rawAlias = claudeWorkspaceAlias(s);
    const alias = uniqueClaudeWorkspaceAlias(s, nativeSessions);
    let workspaceWarning: string | undefined;
    if (rawAlias !== null && alias === null) {
      workspaceWarning =
        `workspace alias ${rawAlias} is shared or collides with a live exact name; using session-scoped DM`;
    } else {
      workspaceWarning = safeVerifiedWorkspaceIdentity(s, nativeSessions, env).warning;
    }
    entries.push({
      kind: "claude",
      name: s.name,
      ...(alias !== null && alias !== s.name ? { workspaceAlias: alias } : {}),
      ...(workspaceWarning === undefined ? {} : { workspaceWarning }),
      pid: s.pid,
      status: s.status,
      self: s.pid === selfPid,
    });
  }
  const codexIpc = codexDesktopIpcAvailable(env);
  for (const s of listCodexSessions(codexSessionsRoot(env), { limit: 10 })) {
    entries.push({ kind: "codex-task", threadId: s.threadId, summary: s.summary, cwd: s.cwd });
  }
  const selfPiSessionId = env[OCS_PI_SESSION_ID_ENV]?.toLowerCase();
  for (const s of listPiSessions(env)) {
    entries.push({
      kind: "pi",
      target: s.target,
      sessionId: s.session_id,
      name: s.name,
      pid: s.pid,
      cwd: s.cwd,
      self: selfPiSessionId === s.session_id,
    });
  }
  const cmux = cmuxAvailable();
  if (cmux) {
    for (const s of listCmuxSurfaces()) {
      entries.push({ kind: "cmux", ref: s.ref, title: s.title });
    }
  }
  return { entries, codexIpc, cmux, home: ocsHome(env) };
}

export type DmTargetKind = "claude" | "codex-task" | "pi" | "cmux";

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
  threadId?: string;
  piSession?: PiSessionRegistration;
  piSessionId?: string;
  cmuxRef?: string;
}

/** 发送方的注入式身份串（与 ResolvedDmTarget.identity 同一命名空间规则）。 */
export function selfIdentity(from: string): string {
  const piSessionId = piSessionIdFromTarget(from);
  if (piSessionId !== null) return `pi:${piSessionId}`;
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
  if (/^surface:\d+$/.test(target)) {
    return { kind: "cmux", name: target.replace(":", "-"), identity: `cmux:${target}`, cmuxRef: target };
  }
  if (isCodexThreadId(target)) {
    return {
      kind: "codex-task",
      name: `codex-${target.slice(0, 8)}`,
      identity: `codex:${target.toLowerCase()}`,
      threadId: target,
    };
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
  if (!NAME_RE.test(target)) return null;
  const sessions = listNativeSessions(env).filter((session) => session.name !== null);
  const session = sessions.find((candidate) => candidate.name === target);
  if (session !== undefined) {
    const workspaceAlias = uniqueClaudeWorkspaceAlias(session, sessions);
    const workspace = safeVerifiedWorkspaceIdentity(session, sessions, env);
    return {
      kind: "claude",
      name: target,
      identity: `name:${target}`,
      claude: session,
      ...(workspaceAlias === null ? {} : { workspaceAlias }),
      ...(workspace.identity === null ? {} : { workspaceIdentity: workspace.identity }),
      ...(workspace.warning === undefined ? {} : { workspaceWarning: workspace.warning }),
    };
  }
  const aliasMatches = sessions.filter((candidate) => claudeWorkspaceTargetMatches(candidate, target));
  if (aliasMatches.length === 1) {
    const matched = aliasMatches[0]!;
    const alias = claudeWorkspaceAlias(matched)!;
    const workspace = safeVerifiedWorkspaceIdentity(matched, sessions, env);
    return {
      kind: "claude",
      name: matched.name!,
      identity: `name:${matched.name!}`,
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
