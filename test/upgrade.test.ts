import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { OCS_VERSION } from "../src/cli.ts";
import {
  checkUpgrade,
  compareVersions,
  OCS_UPGRADE_CHECK_ENV,
  OCS_UPGRADE_INSTALLER_ENV,
  OCS_UPGRADE_LATEST_URL_ENV,
  parseVersion,
  updateNoticeDisabled,
} from "../src/upgrade.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
// spawn CLI 冷启动可达数秒，负载下会撞 bun 默认 5s（与 cli-e2e.test.ts 同款预算）。
const T = 60_000;

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** 本地假 GitHub：按需返回 tag_name / 状态码，并记录被查询次数。 */
function fakeGithub(reply: { tag?: string; status?: number }): { url: string; hits: () => number } {
  let hits = 0;
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch() {
      hits++;
      if (reply.status !== undefined && reply.status !== 200) return new Response("nope", { status: reply.status });
      return Response.json(reply.tag === undefined ? { junk: true } : { tag_name: reply.tag });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/latest`, hits: () => hits };
}

/** 假 installer：写一个 marker 文件然后按指定码退出，证明它被（或没被）调用。 */
function fakeInstaller(exitCode = 0): { path: string; marker: string } {
  const dir = tempDir("ocs-upgrade-");
  const marker = join(dir, "installed.marker");
  const path = join(dir, "install.sh");
  writeFileSync(path, `#!/bin/sh\necho fake-installer-ran\ntouch "${marker}"\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return { path, marker };
}

function bump(v: string, by: number): string {
  const [a, b, c] = parseVersion(v)!;
  return `${a}.${b}.${c + by}`;
}

async function runCli(args: string[], extraEnv: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, OCS_HOME: tempDir("ocs-upgrade-home-"), OCS_LANG: "en", ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("版本解析与比较", () => {
  test("接受 v 前缀与裸三段，拒绝其他", () => {
    expect(parseVersion("v0.4.3")).toEqual([0, 4, 3]);
    expect(parseVersion("0.4.3")).toEqual([0, 4, 3]);
    expect(parseVersion("0.4")).toBeNull();
    expect(parseVersion("0.4.3-rc1")).toBeNull();
    expect(parseVersion("latest")).toBeNull();
  });

  test("逐段数值比较，不是字符串比较", () => {
    expect(compareVersions([0, 4, 3], [0, 4, 10])).toBe(-1);
    expect(compareVersions([0, 10, 0], [0, 9, 9])).toBe(1);
    expect(compareVersions([1, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe("checkUpgrade（本地假 GitHub）", () => {
  test("落后 / 一致 / 领先 三态", async () => {
    const behind = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    expect(await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: behind.url }))
      .toMatchObject({ status: "behind", latest: `v${bump(OCS_VERSION, 1)}` });
    const same = fakeGithub({ tag: `v${OCS_VERSION}` });
    expect(await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: same.url }))
      .toMatchObject({ status: "current" });
    const ahead = fakeGithub({ tag: "v0.0.1" });
    expect(await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: ahead.url }))
      .toMatchObject({ status: "ahead" });
  });

  test("HTTP 错误 / 载荷不对 / 连不上 都归 unknown，绝不抛", async () => {
    const http = fakeGithub({ status: 403 });
    expect(await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: http.url }))
      .toMatchObject({ status: "unknown", error: "HTTP 403" });
    const junk = fakeGithub({});
    expect((await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: junk.url })).status).toBe("unknown");
    const dead = await checkUpgrade(OCS_VERSION, { [OCS_UPGRADE_LATEST_URL_ENV]: "http://127.0.0.1:1/latest" });
    expect(dead.status).toBe("unknown");
  });
});

describe("ocs upgrade（端到端，假 GitHub + 假 installer）", () => {
  test("落后时跑 installer，成功退出码 0，并附跨机器提示", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const inst = fakeInstaller(0);
    const r = await runCli(["upgrade"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: gh.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst.path,
    });
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
    expect(existsSync(inst.marker)).toBe(true);
    expect(r.stdout).toContain(`v${bump(OCS_VERSION, 1)}`);
    expect(r.stdout).toContain("`ocs lan`");
    expect(r.stdout).not.toContain("--party");
  }, T);

  test("installer 失败时透传其退出码", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const inst = fakeInstaller(3);
    const r = await runCli(["upgrade"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: gh.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst.path,
    });
    expect(r.code).toBe(3);
    expect(existsSync(inst.marker)).toBe(true);
  }, T);

  test("已是最新时不碰 installer", async () => {
    const gh = fakeGithub({ tag: `v${OCS_VERSION}` });
    const inst = fakeInstaller(0);
    const r = await runCli(["upgrade"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: gh.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst.path,
    });
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
    expect(existsSync(inst.marker)).toBe(false);
    expect(r.stdout).toContain(OCS_VERSION);
  }, T);

  test("--check 只报告不安装（use-family 统一格式）；查不到最新版时退出码 2 且不安装", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const inst = fakeInstaller(0);
    const check = await runCli(["upgrade", "--check"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: gh.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst.path,
    });
    expect(check.code).toBe(0);
    expect(existsSync(inst.marker)).toBe(false);
    expect(check.stdout).toBe(`ocs ${OCS_VERSION} -> ${bump(OCS_VERSION, 1)}\n`);
    const same = fakeGithub({ tag: `v${OCS_VERSION}` });
    expect((await runCli(["upgrade", "--check"], { [OCS_UPGRADE_LATEST_URL_ENV]: same.url })).stdout)
      .toBe(`ocs ${OCS_VERSION} is up to date\n`);

    const down = fakeGithub({ status: 500 });
    const inst2 = fakeInstaller(0);
    const r = await runCli(["upgrade"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: down.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst2.path,
    });
    expect(r.code).toBe(2);
    expect(existsSync(inst2.marker)).toBe(false);
    expect(r.stderr).toContain("HTTP 500");
  }, T);

  test("--json：name/current/latest/update_available/skills，查不到时退出码 2", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const ok = await runCli(["upgrade", "--json"], { [OCS_UPGRADE_LATEST_URL_ENV]: gh.url, HOME: tempDir("ocs-upgrade-json-") });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      name: "ocs",
      current: OCS_VERSION,
      latest: bump(OCS_VERSION, 1),
      update_available: true,
      skills: [],
    });
    const down = fakeGithub({ status: 500 });
    const bad = await runCli(["upgrade", "--json"], { [OCS_UPGRADE_LATEST_URL_ENV]: down.url });
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)).toMatchObject({ name: "ocs", latest: null, update_available: false });
  }, T);

  test("--party（已下线的旧入口）只打印 ocs lan 指引，不联网不安装，不再引向 Agent Party 站点", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const inst = fakeInstaller(0);
    const r = await runCli(["upgrade", "--party"], {
      [OCS_UPGRADE_LATEST_URL_ENV]: gh.url,
      [OCS_UPGRADE_INSTALLER_ENV]: inst.path,
    });
    expect({ code: r.code, stderr: r.stderr }).toEqual({ code: 0, stderr: "" });
    expect(r.stdout).toContain("--addr");
    expect(r.stdout).not.toContain("agentparty.leeguoo.com");
    expect(gh.hits()).toBe(0);
    expect(existsSync(inst.marker)).toBe(false);
  }, T);
});

describe("ocs doctor 的版本检查", () => {
  test("落后时 warn 并指向 ocs upgrade；OCS_UPGRADE_CHECK=0 时跳过且不联网", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const behind = await runCli(["doctor"], { [OCS_UPGRADE_LATEST_URL_ENV]: gh.url });
    expect(behind.stderr).toBe("");
    expect(behind.stdout).toContain(`v${bump(OCS_VERSION, 1)}`);
    expect(behind.stdout).toContain("ocs upgrade");
    expect(gh.hits()).toBe(1);

    const gh2 = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    const skipped = await runCli(["doctor"], { [OCS_UPGRADE_LATEST_URL_ENV]: gh2.url, [OCS_UPGRADE_CHECK_ENV]: "0" });
    expect(skipped.stderr).toBe("");
    expect(skipped.stdout).not.toContain(`v${bump(OCS_VERSION, 1)}`);
    expect(gh2.hits()).toBe(0);
  }, T);
});

describe("每日新版本提示（use-family 升级约定 §2）", () => {
  const notice = (latest: string) => `ocs ${latest} is available (you have ${OCS_VERSION}). Upgrade: ocs upgrade\n`;

  function cacheEnv(entry: { checked_at: number; latest: string | null } | null) {
    const cache = tempDir("ocs-update-cache-");
    if (entry !== null) {
      const { mkdirSync } = require("node:fs") as typeof import("node:fs");
      mkdirSync(join(cache, "ocs"), { recursive: true });
      writeFileSync(join(cache, "ocs", "update-check.json"), JSON.stringify(entry));
    }
    // 显式打开检查（preload 里默认关着），CI 变量也清掉
    return { XDG_CACHE_HOME: cache, OCS_NO_UPDATE_CHECK: "", USE_NO_UPDATE_CHECK: "", CI: "" };
  }

  test("缓存新鲜且更新：每次调用都提示，包含帮助和版本，stdout 不受影响", async () => {
    const env = cacheEnv({ checked_at: Math.floor(Date.now() / 1000), latest: bump(OCS_VERSION, 1) });
    const r = await runCli(["read", "some-channel", "--as", "tester", "--peek"], env);
    expect(r.stderr).toBe(notice(bump(OCS_VERSION, 1)));
    expect(r.stdout).not.toContain("is available");
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 1)}` });
    for (const args of [["read", "some-channel", "--as", "tester", "--peek"], [], ["help"], ["--help"],
      ["version"], ["--version"], ["upgrade", "--check"]]) {
      const result = await runCli(args, { ...env, [OCS_UPGRADE_LATEST_URL_ENV]: gh.url });
      expect(result.stderr).toBe(notice(bump(OCS_VERSION, 1)));
      expect(result.stdout).not.toContain("is available");
    }
    const json = await runCli(["upgrade", "--json"], { ...env, [OCS_UPGRADE_LATEST_URL_ENV]: gh.url });
    expect(json.stderr).toBe(notice(bump(OCS_VERSION, 1)));
    expect(JSON.parse(json.stdout)).toMatchObject({ update_available: true });
    for (const disabled of [{ CI: "true" }, { OCS_NO_UPDATE_CHECK: "1" }, { USE_NO_UPDATE_CHECK: "1" }]) {
      expect((await runCli(["read", "c", "--as", "t", "--peek"], { ...env, ...disabled })).stderr).toBe("");
    }
  }, T);

  test("internal helpers remain quiet and opt-out still applies to all commands", () => {
    for (const command of ["_update-check", "_lan-daemon", "_claude-wake"]) {
      expect(updateNoticeDisabled({}, command)).toBe(true);
    }
    for (const command of [undefined, "help", "version", "upgrade", "dm"]) {
      expect(updateNoticeDisabled({}, command)).toBe(false);
      expect(updateNoticeDisabled({ OCS_UPGRADE_CHECK: "0" }, command)).toBe(true);
    }
  });

  test("缓存过期：前台不等，后台 _update-check 查一次写回缓存（失败也写 checked_at）", async () => {
    const gh = fakeGithub({ tag: `v${bump(OCS_VERSION, 2)}` });
    const env = { ...cacheEnv({ checked_at: 0, latest: null }), [OCS_UPGRADE_LATEST_URL_ENV]: gh.url };
    const r = await runCli(["read", "c", "--as", "t", "--peek"], env);
    expect(r.stderr).toBe("");
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const path = join(env.XDG_CACHE_HOME, "ocs", "update-check.json");
    const deadline = Date.now() + 8000;
    let cached: { checked_at: number; latest: string | null } = { checked_at: 0, latest: null };
    while (Date.now() < deadline) {
      cached = JSON.parse(readFileSync(path, "utf8"));
      if (cached.latest !== null) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(cached.latest).toBe(bump(OCS_VERSION, 2));
    expect(Date.now() / 1000 - cached.checked_at).toBeLessThan(60);
    expect(gh.hits()).toBe(1);
    // 下一次调用用缓存提示，不再联网
    expect((await runCli(["read", "c", "--as", "t", "--peek"], env)).stderr).toBe(notice(bump(OCS_VERSION, 2)));
    expect(gh.hits()).toBe(1);
  }, T);
});
