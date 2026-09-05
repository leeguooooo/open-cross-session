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

/** git 子进程没能给出答案（超时 / 起不来）——和「git 明确回答没有」是两回事。 */
class GitUnavailableError extends Error {}

function git(cwd: string, args: string[]): string | null {
  // 「git 明确说没有」（非零退出，例如没配 remote）返回 null，调用方据此换用
  // gitdir / cwd 作为锚点——这是身份定义的一部分，必须稳定。
  // 「git 没能回答」（超时、spawn 失败）绝不能也返回 null：那会让锚点 material
  // 从 git:<remote> 悄悄换成 gitdir:<path>，对同一个 workspace-key 算出另一个
  // 稳定身份并写进注册表；此后该别名永远「conflicts with saved state」、稳定
  // 频道被永久禁用。机器负载高时 1s 超时并不稀奇（#27 的负载放大就是这个）。
  // 所以：没能回答就重试一次并放宽超时；还不行就抛出，由 workspaceAnchor
  // 显式降级为「无锚点」，而不是编造一个不同的身份。
  for (const timeout of [1_000, 4_000]) {
    let result: ReturnType<typeof spawnSync>;
    try {
      result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout });
    } catch {
      continue;
    }
    if (result.error !== undefined || result.status === null) continue;
    if (result.status !== 0 || typeof result.stdout !== "string") return null;
    const value = result.stdout.trim();
    return value === "" ? null : value;
  }
  throw new GitUnavailableError(`git did not answer for ${cwd}`);
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
  let remoteRaw: string | null;
  let top: string | null;
  let commonRaw: string | null;
  try {
    remoteRaw = git(session.cwd, ["config", "--get", "remote.origin.url"]);
    const remoteKnown = remoteRaw !== null;
    // 有 remote 时 alias/material 已全部确定，不再额外启两个 git 进程。
    top = remoteKnown ? null : git(session.cwd, ["rev-parse", "--show-toplevel"]);
    commonRaw = remoteKnown ? null : git(session.cwd, ["rev-parse", "--git-common-dir"]);
  } catch (error) {
    if (!(error instanceof GitUnavailableError)) throw error;
    // 不缓存：下一次调用再问 git。返回 null 走的是既有的「无稳定身份」路径。
    return null;
  }
  const remote = remoteRaw === null ? null : normalizeRemote(remoteRaw);
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
      // 这里没有锁（本函数先于注册表锁执行）。首次创建时两个进程可以这样交错：
      // 我方 read() → ENOENT；对方 writeOnce(key) → read() → writeOnce(id)；
      // 我方 readId() → 存在。此时 key 并没有丢，只是刚被对方写好——再读一次
      // 就能拿到赢家的 key。真正的「key 丢了、id 还在」再读一次仍是 null，
      // 照旧抛错，降级语义不变。不加这一步，输家会抛错、被 cli 吞成 stdout
      // warning、退回会话级频道，一次首次并发 DM 就此分裂成两条历史。
      key = read();
      if (key === null) {
        throw new Error(`workspace key is missing but ${idPath} still exists; restore the original workspace-key`);
      }
    } else {
      const raw = randomBytes(32).toString("hex");
      writeOnce(path, raw);
      key = read();
    }
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
