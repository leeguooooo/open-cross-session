import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
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
  uniqueClaudeWorkspaceIdentity,
  OCS_NAME_ENV,
} from "../src/roster.ts";
import { resetClaudeAddressCachesForTest } from "../src/claude-address.ts";
import { verifiedClaudeWorkspaceIdentity } from "../src/workspace-registry.ts";
import { appendMessage, loadCursor, readMessages, saveCursor, OCS_HOME_ENV } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const THREAD = "aaaaaaaa-1111-2222-3333-444444444444";

function sessionsFixture(options: { name?: string; cwd?: string } = {}): NodeJS.ProcessEnv {
  const dir = tempDir("ocs-roster-");
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
      messagingSocketPath: join(dir, `${process.pid}.sock`),
    }),
  );
  return {
    [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
    [OCS_HOME_ENV]: join(dir, "home"),
  };
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

  test("工作区别名离线后从本机持久索引恢复稳定身份，不伪造活会话", () => {
    const env = sessionsFixture({ name: "choose-browser-21", cwd: "/work/choose-browser" });
    const live = resolveDmTarget("choose-browser", env);
    expect(live).toMatchObject({ workspaceAlias: "choose-browser", claude: { name: "choose-browser-21" } });
    const sessionsDir = env[CLAUDE_NATIVE_SESSIONS_DIR_ENV]!;
    for (const file of readdirSync(sessionsDir)) unlinkSync(join(sessionsDir, file));
    const offline = resolveDmTarget("choose-browser", env);
    expect(offline).toMatchObject({
      kind: "claude",
      name: "choose-browser",
      workspaceAlias: "choose-browser",
      workspaceIdentity: live!.workspaceIdentity,
    });
    expect((offline as { claude?: unknown }).claude).toBeUndefined();
  });

  test("同一工作区多个活会话时别名判歧义，不任选目标", () => {
    const dir = tempDir("ocs-roster-ambiguous-");
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
      const env = {
        [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
        [OCS_HOME_ENV]: join(dir, "home"),
      };
      expect(resolveDmTarget("choose-browser", env)).toMatchObject({
        ambiguousClaudeTargets: [
          expect.stringContaining("choose-browser-21(pid "),
          expect.stringContaining("choose-browser-af(pid "),
        ],
      });
      const claudeEntries = buildRoster(env).entries.filter((entry) => entry.kind === "claude");
      const aliases = claudeEntries
        .map((entry) => entry.kind === "claude" ? entry.workspaceAlias : undefined);
      expect(aliases).toEqual([undefined, undefined]);
      expect(claudeEntries.every((entry) =>
        entry.kind === "claude" && entry.workspaceWarning?.includes("using session-scoped DM") === true
      )).toBe(true);
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

test("稳定工作区身份跨会话名不变，同 basename 不同绝对路径不碰撞", () => {
  const env = { [OCS_HOME_ENV]: tempDir("ocs-identity-") };
  const base = {
    pid: 101,
    sessionId: "old",
    name: "super-admin-53",
    cwd: "/Users/leo/tk.com/super-admin",
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: "/tmp/old.sock",
    procStart: null,
  };
  const restarted = { ...base, pid: 202, sessionId: "new", name: "super-admin-26", messagingSocketPath: "/tmp/new.sock" };
  const otherPath = { ...restarted, cwd: "/tmp/other/super-admin" };
  const oldIdentity = uniqueClaudeWorkspaceIdentity(base, [base], env);
  const newIdentity = uniqueClaudeWorkspaceIdentity(restarted, [restarted], env);
  const otherIdentity = uniqueClaudeWorkspaceIdentity(otherPath, [otherPath], env);
  expect(oldIdentity).toBe(newIdentity);
  expect(otherIdentity).not.toBe(newIdentity);
  expect(newIdentity).toMatch(/^workspace:[0-9a-f]{64}$/);
  expect(newIdentity).not.toContain("/Users/leo");
});

test("HTTPS / SSH 形式的同一 Git 远程得到同一工作区身份", () => {
  const root = tempDir("ocs-git-anchor-");
  const first = join(root, "first");
  const second = join(root, "second");
  mkdirSync(first);
  mkdirSync(second);
  for (const [cwd, remote] of [
    [first, "https://github.com/example/shared-project.git"],
    [second, "git@github.com:example/shared-project.git"],
  ] as const) {
    expect(Bun.spawnSync(["git", "-C", cwd, "init", "-q"]).exitCode).toBe(0);
    expect(Bun.spawnSync(["git", "-C", cwd, "remote", "add", "origin", remote]).exitCode).toBe(0);
  }
  const env = { [OCS_HOME_ENV]: join(root, "ocs-home") };
  const session = (cwd: string, pid: number) => ({
    pid,
    sessionId: `s-${pid}`,
    name: `shared-project-${pid}`,
    cwd,
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: join(root, `${pid}.sock`),
    procStart: null,
  });
  const a = session(first, 101);
  const b = session(second, 202);
  expect(claudeWorkspaceAlias(a)).toBe("shared-project");
  expect(claudeWorkspaceAlias(b)).toBe("shared-project");
  expect(uniqueClaudeWorkspaceIdentity(a, [a], env))
    .toBe(uniqueClaudeWorkspaceIdentity(b, [b], env));
});

test("workspace-key 丢失时拒绝生成新身份，不静默漂移频道", () => {
  const home = tempDir("ocs-key-loss-");
  const env = { [OCS_HOME_ENV]: home };
  const session = {
    pid: 101,
    sessionId: "s",
    name: "project-aa",
    cwd: "/work/project",
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: "/tmp/project.sock",
    procStart: null,
  };
  expect(uniqueClaudeWorkspaceIdentity(session, [session], env)).toMatch(/^workspace:/);
  unlinkSync(join(home, "workspace-key"));
  resetClaudeAddressCachesForTest();
  expect(() => uniqueClaudeWorkspaceIdentity(session, [session], env))
    .toThrow("workspace key is missing");
});

test("workspace-key 丢失时目标仍可按精确会话名解析，只禁用稳定历史", () => {
  const env = sessionsFixture({ name: "project-aa", cwd: "/work/project" });
  expect(resolveDmTarget("project-aa", env)?.workspaceIdentity).toMatch(/^workspace:/);
  unlinkSync(join(env[OCS_HOME_ENV]!, "workspace-key"));
  resetClaudeAddressCachesForTest();
  const degraded = resolveDmTarget("project-aa", env);
  expect(degraded).toMatchObject({ kind: "claude", name: "project-aa", claude: { name: "project-aa" } });
  expect(degraded?.workspaceIdentity).toBeUndefined();
  expect(degraded?.workspaceWarning).toContain("session-scoped DM remains available");
});

test("同一别名的持久身份发生变化时禁用稳定频道并给出诊断", () => {
  const root = tempDir("ocs-identity-conflict-");
  const env = { [OCS_HOME_ENV]: join(root, "home") };
  const first = {
    pid: 101,
    sessionId: "a",
    name: "project-aa",
    cwd: join(root, "one", "project"),
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: "/tmp/a.sock",
    procStart: null,
  };
  const moved = { ...first, pid: 202, sessionId: "b", name: "project-bb", cwd: join(root, "two", "project") };
  expect(verifiedClaudeWorkspaceIdentity(first, [first], env).identity).toMatch(/^workspace:/);
  const conflict = verifiedClaudeWorkspaceIdentity(moved, [moved], env);
  expect(conflict.identity).toBeNull();
  expect(conflict.warning).toContain("conflicts with saved state");
});

describe("findDmReplyChannel（跨载体反向 dm 会话收敛，review 回归）", () => {
  test("被唤醒方读过的频道里有对方发言 → 反向 dm 续用同一频道", () => {
    const env = { [OCS_HOME_ENV]: tempDir("ocs-dmrev-") };
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

  test("Codex 会话直接使用宿主提供的 thread id，不再要求 --as", () => {
    // 必须把原生会话目录指到空目录：否则在 Claude 会话里跑这套测试时，
    // findSelfClaudePid 会沿真实祖先链命中宿主会话并返回它的名字，
    // CODEX_THREAD_ID 分支永远走不到（在开发机上稳定失败）。
    expect(resolveSelfName({
      CODEX_THREAD_ID: THREAD.toUpperCase(),
      [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: tempDir("ocs-no-sessions-"),
    })).toBe(THREAD);
    expect(selfIdentity(THREAD)).toBe(`codex:${THREAD}`);
  });

  test("可验证的 Claude 会话优先于祖先进程遗留的 Codex thread id", () => {
    const env = sessionsFixture({ name: "worker-a" });
    env.CODEX_THREAD_ID = THREAD;
    env.CLAUDE_CODE_SESSION_ID = "sess-1";
    env.CLAUDE_CODE_MESSAGING_SOCKET = join(
      env[CLAUDE_NATIVE_SESSIONS_DIR_ENV]!,
      "..",
      `${process.pid}.sock`,
    );
    expect(resolveSelfName(env)).toBe("worker-a");
  });
});

test("codex-<8hex> 短地址解析到唯一的本地 thread id", () => {
  const root = tempDir("ocs-codex-short-");
  const day = join(root, "sessions", "2026", "09", "04");
  mkdirSync(day, { recursive: true });
  writeFileSync(
    join(day, `rollout-2026-09-04T12-00-00-${THREAD}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/current" } })}\n`,
  );
  const resolved = resolveDmTarget("codex-aaaaaaaa", { CODEX_HOME: root });
  expect(resolved).toMatchObject({
    kind: "codex-task",
    name: "codex-aaaaaaaa",
    identity: `codex:${THREAD}`,
    threadId: THREAD,
  });
});
