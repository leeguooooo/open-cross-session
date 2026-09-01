import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { dmChannel, resolveDmTarget, resolveSelfName, OCS_NAME_ENV } from "../src/roster.ts";

const THREAD = "aaaaaaaa-1111-2222-3333-444444444444";

function sessionsFixture(): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ocs-roster-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "sess-1",
      name: "worker-a",
      status: "idle",
      messagingSocketPath: join(dir, "inbox.sock"),
    }),
  );
  return { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir };
}

describe("dmChannel", () => {
  test("双方各自派生得到同一频道；大小写/非法字符归一", () => {
    expect(dmChannel("Alice.9b", "bob")).toBe(dmChannel("bob", "Alice.9b"));
    expect(dmChannel("Alice.9b", "bob")).toBe("dm--alice-9b--bob");
  });
});

describe("resolveDmTarget", () => {
  test("surface:N → cmux；uuid → codex；会话名 → claude；未知 → null", () => {
    const env = sessionsFixture();
    expect(resolveDmTarget("surface:33", env)).toMatchObject({ kind: "cmux", cmuxRef: "surface:33" });
    expect(resolveDmTarget(THREAD, env)).toMatchObject({ kind: "codex-task", threadId: THREAD });
    expect(resolveDmTarget("worker-a", env)).toMatchObject({ kind: "claude", name: "worker-a" });
    expect(resolveDmTarget("ghost", env)).toBeNull();
  });
});

describe("resolveSelfName", () => {
  test("OCS_NAME 显式覆盖优先", () => {
    expect(resolveSelfName({ [OCS_NAME_ENV]: "me-42" })).toBe("me-42");
  });
});
