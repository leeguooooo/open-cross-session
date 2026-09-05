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

export const OCS_REPO = "leeguooooo/open-cross-session";
export const OCS_INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${OCS_REPO}/main/install.sh`;
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
  const argv = typeof local === "string" && local !== ""
    ? ["sh", local]
    : ["sh", "-c", `curl -fsSL ${OCS_INSTALL_SCRIPT_URL} | sh`];
  const proc = spawnSync(argv[0]!, argv.slice(1), { stdio: "inherit", env });
  return { code: proc.status, command: argv.join(" ") };
}
