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

// review #14 回归：缺值/未知 flag/多余参数必须报错退出，不许静默吞掉。
function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const home = tempDir("ocs-cli-");
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, CODEX_HOME: join(home, "codex"), OCS_HOME: home, OCS_LANG: "en" },
  });
  return {
    code: proc.exitCode,
    stderr: proc.stderr.toString(),
    stdout: proc.stdout.toString(),
  };
}

describe("命令级参数 schema", () => {
  test("--codex 缺值：报错退出，绝不打印 sent", () => {
    const r = runCli(["send", "chat", "hello", "--as", "a", "--codex"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--codex requires a value");
    expect(r.stdout).not.toContain("sent");
  });

  test("未知 flag 报错", () => {
    const r = runCli(["read", "chat", "--as", "a", "--sneaky"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag: --sneaky");
  });

  test("read 多余 positional 报错", () => {
    const r = runCli(["read", "chat", "extra", "--as", "a"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unexpected extra arguments");
  });

  test("合法 send 正常走通", () => {
    const r = runCli(["send", "chat", "hello world", "--as", "a", "--no-wake"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("sent #chat seq 1");
  });

  test("常见的 --help 与 who --json 都是有效命令", () => {
    const help = runCli(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("ocs who [--verbose | --json]");

    const who = runCli(["who", "--json"]);
    expect(who.code).toBe(0);
    expect(JSON.parse(who.stdout)).toHaveProperty("entries");
  });

  test("doctor --fix 一次修复三端 skill、Pi 扩展和数据目录权限", () => {
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
      },
    });
    const stdout = proc.stdout.toString();
    expect({ code: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toHaveProperty("crossSessionInbound", "accept");
    expect(existsSync(claudeSkill)).toBe(true);
    expect(lstatSync(claudeSkill).isSymbolicLink()).toBe(false);
    expect(readFileSync(sharedSkill, "utf8")).toBe("old shared cache\n");
    expect(existsSync(join(home, ".codex", "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(piAgentDir, "skills", "ocs", "SKILL.md"))).toBe(true);
    expect(existsSync(join(piAgentDir, "extensions", "ocs.ts"))).toBe(true);
    expect(statSync(dataHome).mode & 0o777).toBe(0o700);
    expect(stdout).toContain("updated the ocs skill for Claude, Codex, and Pi");
    expect(stdout).toContain("direct-wake extension installed");
    expect(stdout).toContain("owner-only permissions");
  });
});
