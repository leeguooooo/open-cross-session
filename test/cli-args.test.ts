import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();
// 冷启动 CLI 子进程可达数秒，负载下会撞上 bun 默认的 5s 单测预算（实测 5006.96ms
// 超时红）。与 cli-e2e.test.ts 同样给 spawn CLI 的用例 60s。
const T = 60_000;

// review #14 回归：缺值/未知 flag/多余参数必须报错退出，不许静默吞掉。
function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const home = tempDir("ocs-cli-");
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: {
      ...process.env, CODEX_HOME: join(home, "codex"), OCS_HOME: home, OCS_LANG: "en", OCS_UPGRADE_CHECK: "0",
      CODEX_THREAD_ID: "", OCS_NAME: "", OCS_PI_SESSION_ID: "", HERMES_SESSION_ID: "",
      OCS_CLAUDE_NATIVE_SESSIONS_DIR: join(home, "claude-sessions"),
    },
  });
  return {
    code: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
}

describe("命令级参数 schema", () => {
  test("shell 中 --as 放在 dm 前后都只存一条相同消息，JSON 契约不变", () => {
    const suffix = runCli(["dm", "offline-peer", "hello", "--as", "human", "--no-wake", "--json"]);
    const prefix = runCli(["--as", "human", "dm", "offline-peer", "hello", "--no-wake", "--json"]);
    expect(prefix.code).toBe(0);
    expect(suffix.code).toBe(0);
    const result = JSON.parse(prefix.stdout);
    expect(result).toEqual(JSON.parse(suffix.stdout));
    expect(result).toMatchObject({ stored: true, seq: 1, wake: "skipped" });
    expect(prefix.stderr).toBe("");
  }, T);

  test("前置 --as 不绕过命令 schema，缺值与缺命令均报清楚", () => {
    expect(runCli(["--as", "human", "who"]).stderr).toContain("unknown flag: --as");
    expect(runCli(["--as"]).stderr).toContain("--as requires a value");
    expect(runCli(["--as", "--json", "dm", "peer", "hello"]).stderr).toContain("--as requires a value");
    expect(runCli(["--as", "human"]).stderr).toContain("missing command after --as");
    const bad = runCli(["--as", "human", "dm", "peer", "hello", "--sneaky", "--json"]);
    expect(bad.code).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ stored: false, exit: 1, error: "unknown flag: --sneaky" });
  }, T);

  test("普通 shell 缺身份时给出修正方式并确认未发送", () => {
    const r = runCli(["dm", "offline-peer", "hello", "--json"]);
    expect(r.code).toBe(1);
    const result = JSON.parse(r.stdout);
    expect(result).toMatchObject({ stored: false, exit: 1 });
    expect(result.error).toContain("no message was stored or sent");
    expect(result.error).toContain("append --as human to the same command");
    expect(result.error).toContain("ocs doctor");
  }, T);

  test("单短横线或排版长横线的 as 提示正确拼写，不误作消息发送", () => {
    for (const flag of ["-as", "–as", "—as"]) {
      const prefix = runCli([flag, "human", "dm", "peer", "hello"]);
      expect(prefix.code).toBe(1);
      expect(prefix.stderr).toContain("write --as with two ASCII hyphens");
      const suffix = runCli(["dm", "peer", "hello", flag, "human", "--json"]);
      expect(suffix.code).toBe(1);
      expect(JSON.parse(suffix.stdout)).toMatchObject({ stored: false, exit: 1 });
      expect(JSON.parse(suffix.stdout).error).toContain("write --as with two ASCII hyphens");
    }
  }, T);

  test("--codex 缺值：报错退出，绝不打印 stored", () => {
    const r = runCli(["send", "chat", "hello", "--as", "a", "--codex"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--codex requires a value");
    expect(r.stdout).not.toContain("stored");
  }, T);

  test("未知 flag 报错", () => {
    const r = runCli(["read", "chat", "--as", "a", "--sneaky"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag: --sneaky");
  }, T);

  test("read 多余 positional 报错", () => {
    const r = runCli(["read", "chat", "extra", "--as", "a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unexpected extra arguments");
  }, T);

  test("合法 send 正常走通", () => {
    const r = runCli(["send", "chat", "hello world", "--as", "a", "--no-wake"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("stored #chat seq 1");
  }, T);

  test("常见的 --help 与 who --json 都是有效命令", () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("ocs who [--verbose | --json]");

    const who = runCli(["who", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toHaveProperty("entries");
  }, T);

  test("doctor --fix 修复各宿主 skill、Pi 扩展、OpenCode 插件和数据目录权限", () => {
    const root = tempDir("ocs-doctor-fix-");
    const home = join(root, "home");
    const dataHome = join(root, "ocs-home");
    const piAgentDir = join(root, "pi-agent");
    const settings = join(root, "claude-settings.json");
    const sharedSkill = join(root, "shared-old-skill.md");
    const claudeSkill = join(home, ".claude", "skills", "ocs", "SKILL.md");
    mkdirSync(home);
    mkdirSync(dataHome, { mode: 0o755 });
    chmodSync(dataHome, 0o755);
    mkdirSync(join(home, ".claude", "skills", "ocs"), { recursive: true });
    writeFileSync(sharedSkill, "old shared cache\n");
    symlinkSync(sharedSkill, claudeSkill);
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), "doctor", "--fix"], {
      env: {
        ...process.env,
        HOME: home,
        CODEX_HOME: join(root, "codex"),
        OCS_HOME: dataHome,
        OCS_CLAUDE_SETTINGS_PATH: settings,
        PI_CODING_AGENT_DIR: piAgentDir,
        OCS_LANG: "en",
        OCS_UPGRADE_CHECK: "0",
      },
    });
    const stdout = proc.stdout.toString();
    expect({ code: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toHaveProperty("crossSessionInbound", "accept");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(sharedSkill, "utf8")).toBe("old shared cache\n");
    expect(existsSync(join(home, ".codex", "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".grok", "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(piAgentDir, "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(piAgentDir, "extensions", "ocs.ts"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".config", "opencode", "plugins", "ocs.js"))).toBe(true);
    expect(statSync(dataHome).mode & 0o777).toBe(0o700);
    expect(stdout).toContain("updated the ocs skill for Claude, Codex, Pi, OpenCode, and Grok");
    expect(stdout).toContain("direct-wake extension installed");
    expect(stdout).toContain("owner-only permissions");
  }, T);
});
