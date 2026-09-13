// ocs 自管的会话名（`ocs rename`）：一个人记得住的名字 → 一个宿主会话身份。
//
// 模型照 Docker：每个会话有不变的短 id（claude-/codex-/pi-<8hex>），外加至多一个 ocs 名字，
// 两者都能寻址。名字被别的身份占着时拒绝（Docker 的 "name already in use"），只有 --force
// 才接管——不猜对方死没死：Codex 判活要 lsof，Desktop 托管的 task 甚至没有 fd 持有者。
//
// 落盘：~/.ocs/names/<小写名>.json。文件名小写是因为 macOS 默认大小写不敏感，
// `Leo` 和 `leo` 在磁盘上本来就是同一个文件；读侧同样按小写查，展示保留原拼写。

import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NativeClaudeSession } from "./claude-inject.ts";
import { isCodexThreadId } from "./codex-sessions.ts";
import { isPiSessionId } from "./pi-sessions.ts";
import { NAME_RE, ocsHome } from "./store.ts";

export type NamedKind = "claude" | "codex" | "pi";

/**
 * Claude 以 sessionId 为主键，另记进程（pid + procStart）：`/clear` 会换 sessionId 但还是
 * 同一个窗口，名字应该跟着窗口走；procStart 防 pid 复用，缺失时不做进程兜底。
 */
export type OcsNameEntry =
  | { v: 1; name: string; kind: "claude"; id: string; pid: number; procStart: string | null }
  | { v: 1; name: string; kind: "codex" | "pi"; id: string };

/** 这些形状是 ocs 自己的地址语法，给了名字就会遮蔽真实会话。 */
const RESERVED_RE = /^(?:claude|codex|pi)-[0-9a-f]{8}$/i;

export function isReservedOcsName(name: string): boolean {
  return RESERVED_RE.test(name) ||
    isCodexThreadId(name) ||
    (name.toLowerCase().startsWith("pi-") && isPiSessionId(name.slice(3)));
}

const SHORT_ID_RE = /^[0-9a-f]{8}/i;

/** Claude 会话的不变短 id；sessionId 不是 hex 开头时没有短 id。 */
export function claudeShortId(sessionId: string | null): string | null {
  return sessionId !== null && SHORT_ID_RE.test(sessionId) ? `claude-${sessionId.slice(0, 8).toLowerCase()}` : null;
}

/** 展示用短 id：Claude 无 hex sessionId 时退回 `pid N`。 */
export function ownerShortId(owner: NameOwner): string {
  if (owner.kind === "claude") return claudeShortId(owner.session.sessionId) ?? `pid ${owner.session.pid}`;
  return `${owner.kind}-${owner.id.slice(0, 8).toLowerCase()}`;
}

export function entryShortId(entry: OcsNameEntry): string {
  if (entry.kind === "claude") return claudeShortId(entry.id) ?? `pid ${entry.pid}`;
  return `${entry.kind}-${entry.id.slice(0, 8).toLowerCase()}`;
}

function namesDir(env: NodeJS.ProcessEnv): string {
  return join(ocsHome(env), "names");
}

function entryPath(name: string, env: NodeJS.ProcessEnv): string {
  return join(namesDir(env), `${name.toLowerCase()}.json`);
}

function parseEntry(value: unknown, key: string): OcsNameEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const e = value as Record<string, unknown>;
  if (e.v !== 1 || typeof e.name !== "string" || !NAME_RE.test(e.name) || e.name.toLowerCase() !== key) return null;
  if (typeof e.id !== "string" || e.id === "") return null;
  const keys = Object.keys(e).sort().join(",");
  if (e.kind === "claude") {
    if (keys !== "id,kind,name,pid,procStart,v") return null;
    if (typeof e.pid !== "number" || !Number.isInteger(e.pid) || e.pid <= 0) return null;
    if (e.procStart !== null && typeof e.procStart !== "string") return null;
    return e as unknown as OcsNameEntry;
  }
  if (keys !== "id,kind,name,v") return null;
  if (e.kind === "codex" && isCodexThreadId(e.id)) return e as unknown as OcsNameEntry;
  if (e.kind === "pi" && isPiSessionId(e.id)) return e as unknown as OcsNameEntry;
  return null;
}

function readEntryFile(path: string, key: string): OcsNameEntry | null {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    return parseEntry(JSON.parse(readFileSync(path, "utf8")) as unknown, key);
  } catch {
    return null;
  }
}

export function readOcsName(name: string, env: NodeJS.ProcessEnv = process.env): OcsNameEntry | null {
  if (!NAME_RE.test(name)) return null;
  return readEntryFile(entryPath(name, env), name.toLowerCase());
}

export function listOcsNames(env: NodeJS.ProcessEnv = process.env): OcsNameEntry[] {
  let files: string[];
  try {
    files = readdirSync(namesDir(env));
  } catch {
    return [];
  }
  const out: OcsNameEntry[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const entry = readEntryFile(join(namesDir(env), file), file.slice(0, -".json".length));
    if (entry !== null) out.push(entry);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 名字条目是否指向这个活 Claude 会话：sessionId 相同，或 /clear 后同一进程。 */
export function claudeEntryMatches(entry: OcsNameEntry, session: NativeClaudeSession): boolean {
  if (entry.kind !== "claude") return false;
  if (session.sessionId !== null && entry.id === session.sessionId) return true;
  return entry.procStart !== null && entry.pid === session.pid && entry.procStart === session.procStart;
}

export type NameOwner =
  | { kind: "claude"; session: NativeClaudeSession }
  | { kind: "codex"; id: string }
  | { kind: "pi"; id: string };

function entryMatchesOwner(entry: OcsNameEntry, owner: NameOwner): boolean {
  if (owner.kind === "claude") return claudeEntryMatches(entry, owner.session);
  return entry.kind === owner.kind && entry.id === owner.id.toLowerCase();
}

/** 某身份当前的 ocs 名字（setOcsName 保证一身份至多一个；多个时取字典序第一个）。 */
export function ocsNameFor(owner: NameOwner, names: readonly OcsNameEntry[]): OcsNameEntry | null {
  return names.find((entry) => entryMatchesOwner(entry, owner)) ?? null;
}

function entryFor(name: string, owner: NameOwner): OcsNameEntry {
  if (owner.kind !== "claude") return { v: 1, name, kind: owner.kind, id: owner.id.toLowerCase() };
  if (owner.session.sessionId === null) throw new Error("claude session has no sessionId");
  return {
    v: 1,
    name,
    kind: "claude",
    id: owner.session.sessionId,
    pid: owner.session.pid,
    procStart: owner.session.procStart,
  };
}

export type SetNameResult =
  | { ok: true; entry: OcsNameEntry; replaced: string[] }
  | { ok: false; reason: "invalid" | "reserved" }
  | { ok: false; reason: "taken"; owner: OcsNameEntry | null };

/**
 * 认领名字：先 link（原子、已存在即 EEXIST），抢不到时只有同一身份或 --force 才覆盖
 * （原子 rename）。成功后删掉该身份的其它旧名字——一个会话只有一个名字。
 */
export function setOcsName(
  name: string,
  owner: NameOwner,
  options: { force?: boolean; env?: NodeJS.ProcessEnv } = {},
): SetNameResult {
  const env = options.env ?? process.env;
  if (!NAME_RE.test(name)) return { ok: false, reason: "invalid" };
  if (isReservedOcsName(name)) return { ok: false, reason: "reserved" };
  const entry = entryFor(name, owner);
  const dir = namesDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(name, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
  try {
    try {
      linkSync(tmp, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readEntryFile(path, name.toLowerCase());
      const mine = existing !== null && entryMatchesOwner(existing, owner);
      if (!mine && options.force !== true) return { ok: false, reason: "taken", owner: existing };
      renameSync(tmp, path);
    }
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 已被 rename 走或已清理
    }
  }
  const replaced: string[] = [];
  for (const other of listOcsNames(env)) {
    if (other.name.toLowerCase() === name.toLowerCase() || !entryMatchesOwner(other, owner)) continue;
    try {
      unlinkSync(entryPath(other.name, env));
      replaced.push(other.name);
    } catch {
      // 并发删除；不影响新名字
    }
  }
  return { ok: true, entry, replaced };
}

/** 删掉该身份的全部名字，返回删掉的名字。 */
export function clearOcsNames(owner: NameOwner, env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const entry of listOcsNames(env)) {
    if (!entryMatchesOwner(entry, owner)) continue;
    try {
      unlinkSync(entryPath(entry.name, env));
      removed.push(entry.name);
    } catch {
      // 并发删除
    }
  }
  return removed;
}
