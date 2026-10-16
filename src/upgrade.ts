// 二进制自升级：查 GitHub 最新 release → 比版本 → 跑 install.sh。
//
// 之前 `ocs upgrade` 只打印一段迁移到托管版 Agent Party 的文案，不做任何升级；
// 用户装了 0.4.1 之后 0.4.2 发了也不知道，doctor 也不提醒。这里补齐两件事：
//   1. `ocs upgrade`：真的升级（复用 install.sh，它已做 sha256 校验 + 冒烟 + 原子替换）
//   2. `ocs doctor`：二进制落后于最新 release 时给一条 warn
//
// 网络和 installer 都留了环境变量注入口，测试用本地假服务器和假脚本跑通全路径，
// 绝不在测试里碰真 GitHub。doctor 的检查用 OCS_UPGRADE_CHECK=0 可整体关掉，
// 离线/CI 环境不受影响。
import { spawnSync } from "node:child_process";
import { spawnDetached } from "./detach.ts";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const OCS_REPO = "leeguooooo/open-cross-session";
export const OCS_INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${OCS_REPO}/main/install.sh`;
export const OCS_INSTALL_PS1_URL = `https://raw.githubusercontent.com/${OCS_REPO}/main/install.ps1`;
export const OCS_LATEST_RELEASE_URL = `https://api.github.com/repos/${OCS_REPO}/releases/latest`;

/** 覆盖最新 release 的查询地址（测试指向本地假服务器）。 */
export const OCS_UPGRADE_LATEST_URL_ENV = "OCS_UPGRADE_LATEST_URL";
/** 覆盖 installer：给一个本地脚本路径，用 `sh <path>` 跑，替代 `curl … | sh`。 */
export const OCS_UPGRADE_INSTALLER_ENV = "OCS_UPGRADE_INSTALLER";
/** 设为 "0" 时 doctor 跳过版本检查（离线、CI、测试）。 */
export const OCS_UPGRADE_CHECK_ENV = "OCS_UPGRADE_CHECK";

const LATEST_TIMEOUT_MS = 3000;

export type Version = readonly [number, number, number];

/** "v0.4.3" / "0.4.3" → [0,4,3]；非法返回 null。 */
export function parseVersion(raw: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function compareVersions(a: Version, b: Version): -1 | 0 | 1 {
  for (let i = 0; i < 3; i++) {
    if (a[i]! < b[i]!) return -1;
    if (a[i]! > b[i]!) return 1;
  }
  return 0;
}

export type UpgradeCheck =
  | { status: "current" | "behind" | "ahead"; current: string; latest: string }
  | { status: "unknown"; current: string; error: string };

function latestReleaseUrl(env: NodeJS.ProcessEnv): string {
  const override = env[OCS_UPGRADE_LATEST_URL_ENV];
  return typeof override === "string" && override !== "" ? override : OCS_LATEST_RELEASE_URL;
}

/** 查最新 release 的 tag。任何失败（离线、限流、格式不对）都归 unknown，绝不抛。 */
export async function fetchLatestVersion(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = LATEST_TIMEOUT_MS,
): Promise<{ tag: string } | { error: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(latestReleaseUrl(env), {
      signal: controller.signal,
      // GitHub API 无 UA 会 403。
      headers: { "user-agent": "ocs-upgrade", accept: "application/vnd.github+json" },
    });
    if (!response.ok) return { error: `HTTP ${response.status}` };
    const body = (await response.json()) as unknown;
    const tag = typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>).tag_name
      : undefined;
    if (typeof tag !== "string" || parseVersion(tag) === null) {
      return { error: `unexpected release payload (tag_name=${JSON.stringify(tag)})` };
    }
    return { tag };
  } catch (error) {
    const e = error as { name?: string; message?: string };
    return { error: e.name === "AbortError" ? `timed out after ${timeoutMs}ms` : String(e.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function checkUpgrade(
  current: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<UpgradeCheck> {
  const cur = parseVersion(current);
  if (cur === null) return { status: "unknown", current, error: `current version is not semver: ${current}` };
  const latest = await fetchLatestVersion(env);
  if ("error" in latest) return { status: "unknown", current, error: latest.error };
  const lat = parseVersion(latest.tag)!;
  const order = compareVersions(cur, lat);
  return { status: order < 0 ? "behind" : order > 0 ? "ahead" : "current", current, latest: latest.tag };
}

export function upgradeCheckEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[OCS_UPGRADE_CHECK_ENV] !== "0";
}

/**
 * 跑 installer。默认 `curl -fsSL <install.sh> | sh`；OCS_UPGRADE_INSTALLER 指向本地脚本时
 * 改跑 `sh <path>`（测试用）。stdio 直通终端，用户能看到下载/校验/替换的每一步。
 * 返回 installer 的退出码；起不来返回 null。
 */
export function runInstaller(env: NodeJS.ProcessEnv = process.env): { code: number | null; command: string } {
  const local = env[OCS_UPGRADE_INSTALLER_ENV];
  // Windows 没有 sh/curl 管道：走 install.ps1（同样 sha256 校验、冒烟、改名替换）。
  const argv = typeof local === "string" && local !== ""
    ? ["sh", local]
    : process.platform === "win32"
      ? ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", `irm ${OCS_INSTALL_PS1_URL} | iex`]
      : ["sh", "-c", `curl -fsSL ${OCS_INSTALL_SCRIPT_URL} | sh`];
  const proc = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", env });
  return { code: proc.status, command: argv.join(" ") };
}

// ───────────────────── use-family 升级约定（leeguooooo/plugins docs/upgrade.md）─────────────────────

export const OCS_NAME = "ocs";
export const PLUGIN_ID = "ocs@leeguooooo-plugins";
const DAY_MS = 24 * 60 * 60 * 1000;
export const UPDATE_CHECK_COMMAND = "_update-check";

export interface SkillChannel {
  channel: "claude-plugin" | "git-checkout" | "copied" | "installer";
  path: string;
  update: string;
}

function gitRoot(dir: string): string | null {
  const out = spawnSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], { encoding: "utf8", windowsHide: true });
  return out.status === 0 && typeof out.stdout === "string" && out.stdout.trim() !== "" ? out.stdout.trim() : null;
}

/** 约定 §3：找出这台机器上每一份 ocs skill 以及它该怎么刷新。 */
export function detectSkillChannels(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): SkillChannel[] {
  const found: SkillChannel[] = [];
  const plugins = join(home, ".claude", "plugins", "installed_plugins.json");
  try {
    if (readFileSync(plugins, "utf8").includes(`"${PLUGIN_ID}`)) {
      found.push({ channel: "claude-plugin", path: plugins, update: `claude plugin update ${PLUGIN_ID}` });
    }
  } catch {
    // 没装 Claude Code 插件
  }
  const managed = new Set([join(home, ".claude", "skills", "ocs"), join(home, ".codex", "skills", "ocs"), join(env.GROK_HOME || join(home, ".grok"), "skills", "ocs")]);
  for (const dir of [join(home, ".agents", "skills", "ocs"), ...managed]) {
    if (!existsSync(join(dir, "SKILL.md"))) continue;
    let real = dir;
    try {
      real = realpathSync(dir);
    } catch {
      // 断链：当作不存在
      continue;
    }
    const root = gitRoot(real);
    if (root !== null) found.push({ channel: "git-checkout", path: dir, update: `git -C ${root} pull --ff-only` });
    else if (managed.has(dir)) found.push({ channel: "installer", path: dir, update: "ocs skill install" });
    else found.push({ channel: "copied", path: dir, update: "npx skills update ocs" });
  }
  return found;
}

/** 升级后刷新：插件走 claude CLI、git 检出 pull、installer 那份 install 脚本已经重写过、copied 只提示。 */
export function refreshSkills(channels: readonly SkillChannel[]): string[] {
  const lines: string[] = [];
  for (const skill of channels) {
    if (skill.channel === "claude-plugin") {
      const out = spawnSync("claude", ["plugin", "update", PLUGIN_ID], { encoding: "utf8", windowsHide: true });
      lines.push(out.error === undefined && out.status === 0
        ? `skill (claude-plugin): updated — restart Claude Code or /reload-plugins`
        : `skill (claude-plugin): run \`${skill.update}\``);
    } else if (skill.channel === "git-checkout") {
      const root = skill.update.split(" ")[2]!;
      const out = spawnSync("git", ["-C", root, "pull", "-q", "--ff-only"], { encoding: "utf8", windowsHide: true });
      lines.push(out.status === 0
        ? `skill (git-checkout ${skill.path}): updated`
        : `skill (git-checkout ${skill.path}): not updated (${(out.stderr ?? "").trim() || "local changes?"})`);
    } else if (skill.channel === "copied") {
      lines.push(`skill (copied ${skill.path}): run \`${skill.update}\``);
    } else {
      lines.push(`skill (${skill.path}): refreshed by the installer`);
    }
  }
  return lines;
}

function updateCachePath(env: NodeJS.ProcessEnv): string {
  const base = typeof env.XDG_CACHE_HOME === "string" && env.XDG_CACHE_HOME !== ""
    ? env.XDG_CACHE_HOME
    : join(homedir(), ".cache");
  return join(base, OCS_NAME, "update-check.json");
}

/** 约定 §2 的跳过条件，外加 ocs 既有的 OCS_UPGRADE_CHECK=0。 */
export function updateNoticeDisabled(env: NodeJS.ProcessEnv, command: string | undefined): boolean {
  if (env.CI || env.OCS_NO_UPDATE_CHECK || env.USE_NO_UPDATE_CHECK || env[OCS_UPGRADE_CHECK_ENV] === "0") return true;
  return command === undefined || command.startsWith("_") ||
    ["upgrade", "version", "--version", "help", "--help"].includes(command);
}

function readUpdateCache(env: NodeJS.ProcessEnv): { checked_at: number; latest: string | null } | null {
  try {
    const raw = JSON.parse(readFileSync(updateCachePath(env), "utf8")) as { checked_at?: unknown; latest?: unknown };
    if (typeof raw.checked_at !== "number") return null;
    return { checked_at: raw.checked_at, latest: typeof raw.latest === "string" ? raw.latest : null };
  } catch {
    return null;
  }
}

/**
 * 每次调用：缓存里的最新版比自己新就往 stderr 打一行（stdout 可能是别人要解析的 JSON）。
 * 缓存超过 24 小时或没有：派一个脱离终端的 `ocs _update-check` 去查，本次不等它——ocs 被 agent
 * 高频调用（send / dm / read），前台绝不为版本检查多等一毫秒。
 */
export function maybeUpdateNotice(
  current: string,
  command: string | undefined,
  selfCommand: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): void {
  if (updateNoticeDisabled(env, command)) return;
  const cache = readUpdateCache(env);
  if (cache?.latest != null) {
    const cur = parseVersion(current);
    const lat = parseVersion(cache.latest);
    if (cur !== null && lat !== null && compareVersions(cur, lat) < 0) {
      process.stderr.write(`ocs ${lat.join(".")} is available (you have ${current}). Upgrade: ocs upgrade\n`);
    }
  }
  if (cache !== null && now - cache.checked_at * 1000 < DAY_MS) return;
  try {
    // 先占位写 checked_at：同一天里并发的几十次调用只会派出一个查询进程。
    writeUpdateCache(env, now, cache?.latest ?? null);
    const [cmd, ...args] = selfCommand;
    const child = spawnDetached(cmd!, [...args, UPDATE_CHECK_COMMAND], { stdio: "ignore", env, windowsHide: true });
    child.unref();
  } catch {
    // 查不了就算了：约定要求静默
  }
}

function writeUpdateCache(env: NodeJS.ProcessEnv, now: number, latest: string | null): void {
  const path = updateCachePath(env);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ checked_at: Math.floor(now / 1000), latest })}\n`);
}

/** `ocs _update-check`：2 秒超时查一次，成败都写 checked_at（离线机器不被每次调用重试）。 */
export async function runUpdateCheck(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const latest = await fetchLatestVersion(env, 2000);
  const previous = readUpdateCache(env)?.latest ?? null;
  writeUpdateCache(env, Date.now(), "tag" in latest ? latest.tag.replace(/^v/, "") : previous);
}
