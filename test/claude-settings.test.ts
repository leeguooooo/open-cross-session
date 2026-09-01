import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_SETTINGS_PATH_ENV,
  enableCrossSessionInbound,
  readCrossSessionInbound,
} from "../src/claude-settings.ts";

function fixture(content?: string): { env: NodeJS.ProcessEnv; path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "ocs-settings-"));
  const path = join(dir, "settings.json");
  if (content !== undefined) writeFileSync(path, content);
  return { env: { [CLAUDE_SETTINGS_PATH_ENV]: path }, path, dir };
}

describe("enableCrossSessionInbound", () => {
  test("已有 settings：只改一键、其余原样保留、写前备份", () => {
    const f = fixture(JSON.stringify({ model: "opus", hooks: { Stop: [] }, crossSessionInbound: "hold" }));
    const result = enableCrossSessionInbound(f.env);
    expect(result.changed).toBe(true);
    const written = JSON.parse(readFileSync(f.path, "utf8")) as Record<string, unknown>;
    expect(written.crossSessionInbound).toBe("accept");
    expect(written.model).toBe("opus");
    expect(written.hooks).toEqual({ Stop: [] });
    const backups = readdirSync(f.dir).filter((n) => n.includes(".ocs-backup-"));
    expect(backups.length).toBe(1);
    expect(JSON.parse(readFileSync(join(f.dir, backups[0]!), "utf8")).crossSessionInbound).toBe("hold");
  });

  test("已是 accept：不动文件、不留备份", () => {
    const f = fixture(JSON.stringify({ crossSessionInbound: "accept" }));
    const result = enableCrossSessionInbound(f.env);
    expect(result.changed).toBe(false);
    expect(readdirSync(f.dir).filter((n) => n.includes(".ocs-backup-"))).toEqual([]);
  });

  test("文件不存在：创建只含该键的文件", () => {
    const f = fixture();
    const result = enableCrossSessionInbound(f.env);
    expect(result.changed).toBe(true);
    expect(readCrossSessionInbound(f.env)).toBe("accept");
  });

  test("settings 解析失败：拒绝改写，原文件一字不动", () => {
    const f = fixture("{broken json");
    const result = enableCrossSessionInbound(f.env);
    expect("error" in result && result.error).toContain("拒绝改写");
    expect(readFileSync(f.path, "utf8")).toBe("{broken json");
  });
});
