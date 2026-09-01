import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// review #14 回归：缺值/未知 flag/多余参数必须报错退出，不许静默吞掉。
function runCli(args: string[]): { code: number; stderr: string; stdout: string } {
  const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
    env: { ...process.env, OCS_HOME: mkdtempSync(join(tmpdir(), "ocs-cli-")), OCS_LANG: "en" },
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
});
