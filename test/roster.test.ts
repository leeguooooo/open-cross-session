import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import {
  dmChannel,
  buildRoster,
  claudeWorkspaceAlias,
  findDmReplyChannel,
  resolveDmTarget,
  resolveSelfName,
  selfIdentity,
  uniqueClaudeWorkspaceAlias,
  OCS_NAME_ENV,
} from "../src/roster.ts";
import { appendMessage, loadCursor, readMessages, saveCursor, OCS_HOME_ENV } from "../src/store.ts";

const THREAD = "aaaaaaaa-1111-2222-3333-444444444444";

function sessionsFixture(options: { name?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "ocs-roster-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: "sess-1",
      name: options.name ?? "worker-a",
      cwd: options.cwd ?? "/work/worker",
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

  test("工作区 basename 是跨重启短地址，不猜测重启前的一次性名字", () => {
    const env = sessionsFixture({ name: "choose-browser-21", cwd: "/work/choose-browser" });
    expect(resolveDmTarget("choose-browser", env)).toMatchObject({
      kind: "claude",
      name: "choose-browser-21",
      workspaceAlias: "choose-browser",
    });
    const stale = resolveDmTarget("choose-browser-10", env);
    expect(stale).toMatchObject({
      kind: "claude",
      name: "choose-browser-10",
    });
    expect((stale as { claude?: unknown }).claude).toBeUndefined();
  });

  test("同一工作区多个活会话时别名判歧义，不任选目标", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocs-roster-ambiguous-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { mode: 0o700 });
    const peer = Bun.spawn(["sleep", "30"], { stdio: ["ignore", "ignore", "ignore"] });
    try {
      for (const [pid, name] of [[process.pid, "choose-browser-21"], [peer.pid, "choose-browser-af"]] as const) {
        writeFileSync(join(sessionsDir, `${pid}.json`), JSON.stringify({
          pid,
          sessionId: `sess-${pid}`,
          name,
          cwd: "/work/choose-browser",
          status: "idle",
          messagingSocketPath: join(dir, `${pid}.sock`),
        }));
      }
      const env = { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir };
      expect(resolveDmTarget("choose-browser", env)).toMatchObject({
        ambiguousClaudeTargets: [
          expect.stringContaining("choose-browser-21(pid "),
          expect.stringContaining("choose-browser-af(pid "),
        ],
      });
      const aliases = buildRoster(env).entries
        .filter((entry) => entry.kind === "claude")
        .map((entry) => entry.kind === "claude" ? entry.workspaceAlias : undefined);
      expect(aliases).toEqual([undefined, undefined]);
    } finally {
      peer.kill();
    }
  });
});

test("claudeWorkspaceAlias 只接受绝对 cwd 的合法 basename", () => {
  const base = {
    pid: process.pid,
    sessionId: "s",
    name: "agentparty-eb",
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: "/tmp/unused.sock",
    procStart: null,
  };
  expect(claudeWorkspaceAlias({ ...base, cwd: "/work/agentparty" })).toBe("agentparty");
  expect(claudeWorkspaceAlias({ ...base, cwd: "relative/path" })).toBeNull();
  expect(claudeWorkspaceAlias({ ...base, cwd: "/work/bad name" })).toBeNull();
});

test("工作区别名与另一活会话的精确名冲突时不得用于短 Reply", () => {
  const self = {
    pid: 101,
    sessionId: "self",
    name: "agentparty-eb",
    cwd: "/work/agentparty",
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: "/tmp/self.sock",
    procStart: null,
  };
  const collision = { ...self, pid: 202, sessionId: "other", name: "agentparty", cwd: "/work/other" };
  expect(uniqueClaudeWorkspaceAlias(self, [self])).toBe("agentparty");
  expect(uniqueClaudeWorkspaceAlias(self, [self, collision])).toBeNull();
});

describe("findDmReplyChannel（跨载体反向 dm 会话收敛，review 回归）", () => {
  test("被唤醒方读过的频道里有对方发言 → 反向 dm 续用同一频道", () => {
    const env = { [OCS_HOME_ENV]: require("node:fs").mkdtempSync(require("node:path").join(require("node:os").tmpdir(), "ocs-dmrev-")) };
    // 正向：alice dm 一个 codex 目标 → 频道按载体身份派生
    const target = resolveDmTarget("aaaaaaaa-1111-2222-3333-444444444444", env)!;
    const forward = dmChannel(selfIdentity("alice"), target.identity);
    appendMessage({ channel: forward, from: "alice", body: "hi codex", env });
    // 被唤醒方 codex-ping 按指针读频道（留下游标）
    readMessages(forward, { env });
    saveCursor(forward, "codex-ping", 1, env);
    // 反向：codex-ping dm alice —— 应命中同一频道，而不是 name 对派生的新频道
    expect(findDmReplyChannel("codex-ping", "alice", env)).toBe(forward);
    // 无游标/无参与时不乱认
    expect(findDmReplyChannel("stranger", "alice", env)).toBeNull();
    expect(findDmReplyChannel("codex-ping", "nobody", env)).toBeNull();
  });
});

describe("resolveSelfName", () => {
  test("OCS_NAME 显式覆盖优先", () => {
    expect(resolveSelfName({ [OCS_NAME_ENV]: "me-42" })).toBe("me-42");
  });
});
