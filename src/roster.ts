// 全机 agent 花名册与直发（dm）支撑：发现任意 agent、识别自己、派生 dm 频道。
//
// 目标体验：人只说自然语言，agent 自己跑 `ocs who` 发现同伴、`ocs dm` 搭话。
// 三个命名空间统一在这里：Claude 原生会话（UDS 可唤醒）、ChatGPT Desktop 任务
// （IPC 可唤醒）、cmux surface（可选加速器，探测到才列）。

import { spawnSync } from "node:child_process";
import { listNativeSessions, type NativeClaudeSession } from "./claude-inject.ts";
import { codexDesktopIpcAvailable } from "./codex-ipc.ts";
import { codexSessionsRoot, isCodexThreadId, listCodexSessions } from "./codex-sessions.ts";
import { findSelfClaudePid } from "./wake.ts";
import { CHANNEL_RE, NAME_RE } from "./store.ts";

export const OCS_NAME_ENV = "OCS_NAME";

/**
 * 识别「我是谁」：--as > $OCS_NAME > 进程祖先链上的 Claude 原生会话名。
 * agent 在自己的会话里跑 ocs 时三者兜底，人一个字都不用打。
 */
export function resolveSelfName(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[OCS_NAME_ENV];
  if (typeof explicit === "string" && NAME_RE.test(explicit)) return explicit;
  const pid = findSelfClaudePid(env);
  if (pid === null) return null;
  const session = listNativeSessions(env).find((s) => s.pid === pid);
  return session?.name ?? null;
}

/** dm 频道名：按参与者名字排序派生，双方各自算都得到同一个频道。 */
export function dmChannel(a: string, b: string): string {
  const clean = (name: string) => name.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  const [x, y] = [clean(a), clean(b)].sort();
  const channel = `dm--${x}--${y}`.slice(0, 64);
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
  | { kind: "claude"; name: string; pid: number; status: string | null; self: boolean }
  | { kind: "codex-task"; threadId: string; summary: string | null; cwd: string | null }
  | { kind: "cmux"; ref: string; title: string };

export interface Roster {
  entries: RosterEntry[];
  codexIpc: boolean;
  cmux: boolean;
}

export function buildRoster(env: NodeJS.ProcessEnv = process.env): Roster {
  const entries: RosterEntry[] = [];
  const selfPid = findSelfClaudePid(env);
  for (const s of listNativeSessions(env)) {
    if (s.name === null) continue;
    entries.push({ kind: "claude", name: s.name, pid: s.pid, status: s.status, self: s.pid === selfPid });
  }
  const codexIpc = codexDesktopIpcAvailable(env);
  for (const s of listCodexSessions(codexSessionsRoot(env), { limit: 10 })) {
    entries.push({ kind: "codex-task", threadId: s.threadId, summary: s.summary, cwd: s.cwd });
  }
  const cmux = cmuxAvailable();
  if (cmux) {
    for (const s of listCmuxSurfaces()) {
      entries.push({ kind: "cmux", ref: s.ref, title: s.title });
    }
  }
  return { entries, codexIpc, cmux };
}

export type DmTargetKind = "claude" | "codex-task" | "cmux";

export interface ResolvedDmTarget {
  kind: DmTargetKind;
  /** dm 频道派生用的对方名字。 */
  name: string;
  claude?: NativeClaudeSession;
  threadId?: string;
  cmuxRef?: string;
}

/** 把 dm 目标字符串解析到三个命名空间之一：surface:N → cmux；uuid → codex；否则 Claude 会话名。 */
export function resolveDmTarget(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedDmTarget | null {
  if (/^surface:\d+$/.test(target)) {
    return { kind: "cmux", name: target.replace(":", "-"), cmuxRef: target };
  }
  if (isCodexThreadId(target)) {
    return { kind: "codex-task", name: `codex-${target.slice(0, 8)}`, threadId: target };
  }
  const session = listNativeSessions(env).find((s) => s.name === target);
  if (session === undefined) return null;
  return { kind: "claude", name: target, claude: session };
}
