// Claude 原生会话名是一次性地址；这里提供工作区别名和持久 DM 身份。
// Git 工作区按远程地址归一，非 Git 目录按启动 cwd 归一；原始值只进本机 HMAC。

import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import {
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import type { NativeClaudeSession } from "./claude-inject.ts";
import { NAME_RE, ocsHome } from "./store.ts";

interface WorkspaceAnchor {
  alias: string;
  material: string;
}

const anchorCache = new Map<string, WorkspaceAnchor | null>();
const keyCache = new Map<string, Buffer>();

/** 仅供同进程测试模拟重启；CLI 每次运行本来就是新进程。 */
export function resetClaudeAddressCachesForTest(): void {
  anchorCache.clear();
  keyCache.clear();
}

function git(cwd: string, args: string[]): string | null {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: 1_000 });
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const value = result.stdout.trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

function normalizeRemote(raw: string): string {
  const trimmed = raw.trim().replace(/\.git\/?$/i, "").replace(/\/$/, "");
  const scp = /^(?:[^@\s]+@)?([^:\s/]+):(.+)$/.exec(trimmed);
  if (scp !== null && !trimmed.includes("://") && !/^[A-Za-z]:[\\/]/.test(trimmed)) {
    const host = scp[1]!.toLowerCase();
    const path = scp[2]!.replace(/^\/+/, "");
    return `${host}/${host === "github.com" ? path.toLowerCase() : path}`;
  }
  try {
    const url = new URL(trimmed);
    url.username = "";
    url.password = "";
    url.hash = "";
    url.search = "";
    const hostname = url.hostname.toLowerCase();
    const pathname = hostname === "github.com" ? url.pathname.toLowerCase() : url.pathname;
    return `${url.host.toLowerCase()}${pathname}`.replace(/\.git\/?$/i, "").replace(/\/$/, "");
  } catch {
    return trimmed;
  }
}

function remoteAlias(remote: string): string | null {
  const candidate = remote.split(/[/:\\]/).filter(Boolean).at(-1)?.replace(/\.git$/i, "") ?? "";
  return NAME_RE.test(candidate) ? candidate : null;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function workspaceAnchor(session: NativeClaudeSession): WorkspaceAnchor | null {
  if (typeof session.cwd !== "string" || !isAbsolute(session.cwd)) return null;
  const cached = anchorCache.get(session.cwd);
  if (cached !== undefined) return cached;
  const remoteRaw = git(session.cwd, ["config", "--get", "remote.origin.url"]);
  const remote = remoteRaw === null ? null : normalizeRemote(remoteRaw);
  const top = git(session.cwd, ["rev-parse", "--show-toplevel"]);
  const commonRaw = git(session.cwd, ["rev-parse", "--git-common-dir"]);
  const common = commonRaw === null
    ? null
    : canonicalPath(isAbsolute(commonRaw) ? commonRaw : resolve(session.cwd, commonRaw));
  const repoAlias = common === null
    ? null
    : basename(common) === ".git" ? basename(dirname(common)) : basename(common);
  const fallbackAlias = repoAlias ?? basename(top ?? session.cwd);
  const alias = remote === null ? fallbackAlias : remoteAlias(remote) ?? fallbackAlias;
  const material = remote !== null
    ? `git:${remote}`
    : common !== null
      ? `gitdir:${common}`
      : `cwd:${canonicalPath(session.cwd)}`;
  const anchor = NAME_RE.test(alias) ? { alias, material } : null;
  anchorCache.set(session.cwd, anchor);
  return anchor;
}

function workspaceKey(env: NodeJS.ProcessEnv): Buffer {
  const home = ocsHome(env);
  const cached = keyCache.get(home);
  if (cached !== undefined) return cached;
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = join(home, "workspace-key");
  const idPath = join(home, "workspace-key-id");
  const readId = (): string | null => {
    try {
      const stat = lstatSync(idPath);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 128 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) throw new Error(`untrusted workspace key id: ${idPath}`);
      const value = readFileSync(idPath, "utf8").trim();
      if (!/^[0-9a-f]{16}$/.test(value)) throw new Error(`invalid workspace key id: ${idPath}`);
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const writeOnce = (target: string, value: string): void => {
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, value, { flag: "wx", mode: 0o600 });
    try {
      linkSync(tmp, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // 已清理
      }
    }
  };
  const read = (): Buffer | null => {
    try {
      const stat = lstatSync(path);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > 256 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      ) throw new Error(`untrusted workspace key: ${path}`);
      const raw = readFileSync(path, "utf8").trim();
      return /^[0-9a-f]{64}$/.test(raw) ? Buffer.from(raw, "hex") : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  let key = read();
  if (key === null) {
    if (readId() !== null) {
      throw new Error(`workspace key is missing but ${idPath} still exists; restore the original workspace-key`);
    }
    const raw = randomBytes(32).toString("hex");
    writeOnce(path, raw);
    key = read();
  }
  if (key === null) throw new Error(`invalid workspace key: ${path}`);
  const expectedId = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const existingId = readId();
  if (existingId === null) writeOnce(idPath, expectedId);
  else if (existingId !== expectedId) {
    throw new Error(`workspace key does not match ${idPath}; restore the original workspace-key`);
  }
  keyCache.set(home, key);
  return key;
}

export function claudeWorkspaceAlias(session: NativeClaudeSession): string | null {
  return workspaceAnchor(session)?.alias ?? null;
}

/**
 * 一个可放进 Reply 行的别名必须同时满足：只有这一个活会话使用该工作区别名，
 * 且没有另一个活会话把别名本身当作精确原生名。否则 `ocs dm <alias>` 会先命中那个精确名。
 */
export function uniqueClaudeWorkspaceAlias(
  self: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
): string | null {
  const alias = claudeWorkspaceAlias(self);
  if (alias === null) return null;
  const workspaceOwners = sessions.filter((session) => claudeWorkspaceAlias(session) === alias);
  if (workspaceOwners.length !== 1 || workspaceOwners[0]!.pid !== self.pid) return null;
  const exactNameCollision = sessions.some((session) => session.pid !== self.pid && session.name === alias);
  return exactNameCollision ? null : alias;
}

/**
 * DM 频道派生用的稳定工作区身份。仓库远程 / cwd 只进本机密钥的 HMAC，
 * 返回值与频道 slug 都不携带别名、绝对路径或远程地址。
 */
export function uniqueClaudeWorkspaceIdentity(
  self: NativeClaudeSession,
  sessions: readonly NativeClaudeSession[],
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const alias = uniqueClaudeWorkspaceAlias(self, sessions);
  const anchor = workspaceAnchor(self);
  if (alias === null || anchor === null) return null;
  const digest = createHmac("sha256", workspaceKey(env)).update(anchor.material).digest("hex");
  return `workspace:${digest}`;
}

/** 只按完整工作区别名匹配；不猜测 `*-<suffix>`，避免把人工命名投给别人。 */
export function claudeWorkspaceTargetMatches(session: NativeClaudeSession, target: string): boolean {
  const alias = claudeWorkspaceAlias(session);
  return alias !== null && target === alias;
}
