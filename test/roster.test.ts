import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import {
  dmChannel,
  resolveDmTarget,
  resolveSelfName,
  selfIdentity,
  OCS_NAME_ENV,
} from "../src/roster.ts";

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
  test("双方各自派生得到同一频道，且格式合法", () => {
    const channel = dmChannel("Alice.9b", "bob");
    expect(channel).toBe(dmChannel("bob", "Alice.9b"));
    expect(channel).toMatch(/^dm-[0-9a-f]{40}--/);
    expect(channel.length).toBeLessThanOrEqual(64);
  });

  test("不同名字对绝不合并进同一频道（review 回归：清洗/截断/分隔符歧义）", () => {
    // 分隔符歧义：(a--b, c) vs (a, b--c)
    expect(dmChannel("a--b", "c")).not.toBe(dmChannel("a", "b--c"));
    // 清洗折叠：大小写、点号
    expect(dmChannel("Alice", "bob")).not.toBe(dmChannel("alice", "bob"));
    expect(dmChannel("a.b", "c")).not.toBe(dmChannel("a-b", "c"));
    // 截断：64 字符内共享前缀的长名字对
    const long1 = "x".repeat(60) + "1";
    const long2 = "x".repeat(60) + "2";
    expect(dmChannel(long1, "peer")).not.toBe(dmChannel(long2, "peer"));
  });

  test("身份串全长且带命名空间：别名截断/跨空间同形不再碰撞（review 回归）", () => {
    const env = sessionsFixture();
    const me = selfIdentity("me");
    // 共享 8-hex 前缀的两个 codex thread：别名同为 codex-aaaaaaaa，身份串不同
    const t1 = resolveDmTarget("aaaaaaaa-1111-2222-3333-444444444444", env)!;
    const t2 = resolveDmTarget("aaaaaaaa-9999-8888-7777-666666666666", env)!;
    expect(t1.name).toBe(t2.name);
    expect(dmChannel(me, t1.identity)).not.toBe(dmChannel(me, t2.identity));
    // 跨命名空间同形：叫 surface-33 的 Claude 会话 vs cmux 的 surface:33
    const claudeAlike = resolveDmTarget("surface-33", env)!;
    const cmuxReal = resolveDmTarget("surface:33", env)!;
    expect(dmChannel(me, claudeAlike.identity)).not.toBe(dmChannel(me, cmuxReal.identity));
    // 叫 codex-aaaaaaaa 的 Claude 会话 vs 真 codex 任务
    const codexAlike = resolveDmTarget("codex-aaaaaaaa", env)!;
    expect(dmChannel(me, codexAlike.identity)).not.toBe(dmChannel(me, t1.identity));
  });
});

describe("resolveDmTarget", () => {
  test("surface:N → cmux；uuid → codex；会话名 → claude；格式非法 → null", () => {
    const env = sessionsFixture();
    expect(resolveDmTarget("surface:33", env)).toMatchObject({ kind: "cmux", cmuxRef: "surface:33" });
    expect(resolveDmTarget(THREAD, env)).toMatchObject({ kind: "codex-task", threadId: THREAD });
    expect(resolveDmTarget("worker-a", env)).toMatchObject({ kind: "claude", name: "worker-a" });
    expect(resolveDmTarget("bad name!", env)).toBeNull();
  });

  test("名字合法但不在线 → 返回无 session 的 claude 目标（消息可停靠而非报错）", () => {
    const env = sessionsFixture();
    const offline = resolveDmTarget("ghost", env);
    expect(offline).toMatchObject({ kind: "claude", name: "ghost" });
    expect((offline as { claude?: unknown }).claude).toBeUndefined();
  });
});

describe("resolveSelfName", () => {
  test("OCS_NAME 显式覆盖优先", () => {
    expect(resolveSelfName({ [OCS_NAME_ENV]: "me-42" })).toBe("me-42");
  });
});
