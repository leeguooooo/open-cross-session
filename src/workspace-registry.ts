// 本机工作区别名到加盐稳定身份的持久索引。
// 只落 alias + HMAC，不写 cwd / Git remote；多个身份共用别名时读侧必须判歧义。

import { randomUUID } from "node:crypto";
import { linkSync, lstatSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeWorkspaceAlias,
  uniqueClaudeWorkspaceIdentity,
} from "./claude-address.ts";
import type { NativeClaudeSession } from "./claude-inject.ts";
import { acquireLock, NAME_RE, ocsHome } from "./store.ts";

interface WorkspaceRegistryEntry {
  v: 1;
  alias: string;
  identity: string;
}

const IDENTITY_RE = /^workspace:([0-9a-f]{64})$/;

function registryDir(env?: NodeJS.ProcessEnv): string {
  return join(ocsHome(env), "workspace-addresses");
}

function entryPath(entry: WorkspaceRegistryEntry, env?: NodeJS.ProcessEnv): string {
  const digest = IDENTITY_RE.exec(entry.identity)?.[1];
  if (!NAME_RE.test(entry.alias) || digest === undefined) throw new Error("invalid workspace registry entry");
  return join(registryDir(env), `${entry.alias}.${digest}.json`);
}

function writeEntry(entry: WorkspaceRegistryEntry, env?: NodeJS.ProcessEnv): void {
  const dir = registryDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = entryPath(entry, env);
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry), { flag: "wx", mode: 0o600 });
  try {
    linkSync(tmp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // 已清理
    }
  }
}

function readEntry(path: string, alias: string): WorkspaceRegistryEntry | null {
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4 * 1024 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const entry = value as Record<string, unknown>;
    if (
      Object.keys(entry).sort().join(",") !== "alias,identity,v" ||
      entry.v !== 1 ||
      entry.alias !== alias ||
      typeof entry.identity !== "string" ||
      !IDENTITY_RE.test(entry.identity)
    ) return null;
    return entry as unknown as WorkspaceRegistryEntry;
  } catch {
    return null;
  }
}

/** 离线时只有一个持久身份才能继续用别名；多个则返回全部候选供拒绝信息展示。 */
export function knownClaudeWorkspaceIdentities(
  alias: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (!NAME_RE.test(alias)) return [];
  let files: string[];
  try {
    files = readdirSync(registryDir(env));
  } catch {
    return [];
  }
  const prefix = `${alias}.`;
  const identities = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(prefix) || !file.endsWith(".json")) continue;
    const entry = readEntry(join(registryDir(env), file), alias);
    if (entry !== null) identities.add(entry.identity);
  }
  return [...identities].sort();
}

export interface VerifiedWorkspaceIdentity {
  identity: string | null;
  warning?: string;
}

/**
 * 把当前工作区身份与持久索引对账。别名下已有不同身份时禁用稳定频道，
 * 避免 workspace-key / OCS_HOME / 远程地址变化后静默开新历史。
 */
export function verifiedClaudeWorkspaceIdentity(
  session: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv = process.env,
): VerifiedWorkspaceIdentity {
  const alias = claudeWorkspaceAlias(session);
  const identity = uniqueClaudeWorkspaceIdentity(session, sessions, env);
  if (alias === null || identity === null) return { identity: null };
  const dir = registryDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const unlock = acquireLock(join(dir, `.${alias}.lock`), env);
  try {
    const known = knownClaudeWorkspaceIdentities(alias, env);
    if (known.length === 0) writeEntry({ v: 1, alias, identity }, env);
    const after = known.length === 0 ? knownClaudeWorkspaceIdentities(alias, env) : known;
    if (after.length === 1 && after[0] === identity) return { identity };
    return {
      identity: null,
      warning:
        `workspace identity for ${alias} conflicts with saved state under ${ocsHome(env)}; ` +
        "restore the original workspace-key/OCS_HOME or use an exact session name",
    };
  } finally {
    unlock();
  }
}

/** 机会性记住当前可唯一寻址的活 Claude 工作区。 */
export function rememberClaudeWorkspaces(
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv = process.env,
): void {
  for (const session of sessions) verifiedClaudeWorkspaceIdentity(session, sessions, env);
}
