import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV, type NativeClaudeSession } from "../src/claude-inject.ts";
import {
  claudeEntryMatches,
  claudeShortId,
  clearOcsNames,
  isReservedOcsName,
  listOcsNames,
  readOcsName,
  setOcsName,
} from "../src/names.ts";
import { canonicalWakeAddress, resolveDmTarget, shadowFreeWorkspaceAlias } from "../src/roster.ts";
import { OCS_HOME_ENV } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const SELF_SID = "7043ea85-6942-4f4f-9193-256be54c4ad3";
const PEER_SID = "9f00aa11-2222-4333-8444-555566667777";
const THREAD = "01a09362-1111-7222-8333-444444444444";

const peer = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
afterAll(() => peer.kill());

function session(pid: number, sessionId: string, name: string, procStart: string | null = null): NativeClaudeSession {
  return {
    pid,
    sessionId,
    name,
    cwd: `/work/${name}`,
    status: "idle",
    statusUpdatedAt: null,
    kind: "interactive",
    messagingSocketPath: `/tmp/${pid}.sock`,
    procStart,
  };
}

/** 两个活 Claude 会话：本进程 = alpha-1，sleep 子进程 = beta-2。 */
function world(): { env: NodeJS.ProcessEnv; self: NativeClaudeSession; other: NativeClaudeSession } {
  const dir = tempDir("ocs-names-");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const self = session(process.pid, SELF_SID, "alpha-1", "Sun Sep 13 00:04:29 2026");
  const other = session(peer.pid, PEER_SID, "beta-2");
  for (const s of [self, other]) writeFileSync(join(sessionsDir, `${s.pid}.json`), JSON.stringify(s), { mode: 0o600 });
  return {
    env: { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir, [OCS_HOME_ENV]: join(dir, "home") },
    self,
    other,
  };
}

describe("ocs 名字存储", () => {
  test("被别的身份占着时拒绝，--force 才接管；同一身份重复设置是幂等的", () => {
    const { env, self, other } = world();
    expect(setOcsName("boss", { kind: "claude", session: self }, { env }).ok).toBe(true);
    expect(setOcsName("boss", { kind: "claude", session: self }, { env }).ok).toBe(true);
    const taken = setOcsName("boss", { kind: "claude", session: other }, { env });
    expect(taken).toMatchObject({ ok: false, reason: "taken" });
    expect(readOcsName("boss", env)).toMatchObject({ kind: "claude", id: SELF_SID });
    expect(setOcsName("boss", { kind: "claude", session: other }, { env, force: true }).ok).toBe(true);
    expect(readOcsName("boss", env)).toMatchObject({ kind: "claude", id: PEER_SID });
  });

  test("大小写不敏感（macOS 上本来就是同一个文件），展示保留拼写", () => {
    const { env, self, other } = world();
    expect(setOcsName("Boss", { kind: "claude", session: self }, { env }).ok).toBe(true);
    expect(readOcsName("boss", env)?.name).toBe("Boss");
    expect(setOcsName("BOSS", { kind: "claude", session: other }, { env })).toMatchObject({ reason: "taken" });
  });

  test("一个会话只有一个名字：改名释放旧名；--clear 全删", () => {
    const { env, self } = world();
    setOcsName("first", { kind: "claude", session: self }, { env });
    const second = setOcsName("second", { kind: "claude", session: self }, { env });
    expect(second).toMatchObject({ ok: true, replaced: ["first"] });
    expect(listOcsNames(env).map((entry) => entry.name)).toEqual(["second"]);
    expect(clearOcsNames({ kind: "claude", session: self }, env)).toEqual(["second"]);
    expect(listOcsNames(env)).toEqual([]);
  });

  test("地址语法是保留字，不许当名字", () => {
    for (const name of ["claude-7043ea85", "codex-01A09362", "pi-01a09109", THREAD, `pi-${PEER_SID}`]) {
      expect(isReservedOcsName(name)).toBe(true);
    }
    expect(isReservedOcsName("claude-code-usage-bar")).toBe(false);
    const { env, self } = world();
    expect(setOcsName("codex-01a09362", { kind: "claude", session: self }, { env })).toMatchObject({ reason: "reserved" });
    expect(setOcsName("bad name", { kind: "claude", session: self }, { env })).toMatchObject({ reason: "invalid" });
  });

  test("/clear 换了 sessionId 仍是同一进程时名字跟着窗口走；pid 复用（procStart 不同）不算", () => {
    const { env, self } = world();
    const set = setOcsName("win", { kind: "claude", session: self }, { env });
    if (!set.ok) throw new Error("set failed");
    expect(claudeEntryMatches(set.entry, { ...self, sessionId: "aaaaaaaa-0000-4000-8000-000000000000" })).toBe(true);
    expect(claudeEntryMatches(set.entry, { ...self, sessionId: "aaaaaaaa-0000-4000-8000-000000000000", procStart: "later" }))
      .toBe(false);
  });

  test("坏文件、多余字段一律忽略", () => {
    const { env } = world();
    const dir = join(env[OCS_HOME_ENV]!, "names");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "evil.json"), JSON.stringify({ v: 1, name: "evil", kind: "codex", id: THREAD, extra: 1 }));
    writeFileSync(join(dir, "other.json"), JSON.stringify({ v: 1, name: "mismatch", kind: "codex", id: THREAD }));
    writeFileSync(join(dir, "junk.json"), "{not json");
    expect(listOcsNames(env)).toEqual([]);
    expect(readdirSync(dir).length).toBe(3);
  });

  test("短 id 只取 hex 开头的 sessionId", () => {
    expect(claudeShortId(SELF_SID)).toBe("claude-7043ea85");
    expect(claudeShortId("self-sess")).toBeNull();
    expect(claudeShortId(null)).toBeNull();
  });
});

describe("按名字 / 短 id 寻址", () => {
  test("ocs 名字解析到底层活会话，频道身份与精确名一致", () => {
    const { env, other } = world();
    setOcsName("helper", { kind: "claude", session: other }, { env });
    const byName = resolveDmTarget("helper", env);
    const byExact = resolveDmTarget("beta-2", env);
    expect(byName).toMatchObject({ kind: "claude", name: "beta-2", via: "ocs-name" });
    expect(byName?.claude?.pid).toBe(peer.pid);
    expect(byName?.identity).toBe(byExact?.identity);
    expect(resolveDmTarget("HELPER", env)?.claude?.pid).toBe(peer.pid);
  });

  test("claude-<8hex> 找到对应会话；前缀多命中拒绝", () => {
    const { env } = world();
    expect(resolveDmTarget("claude-9f00aa11", env)).toMatchObject({ name: "beta-2", via: "short-id" });
    expect(resolveDmTarget("claude-7043EA85", env)?.claude?.pid).toBe(process.pid);
  });

  test("ocs 名字与另一个活会话精确名撞车时拒绝任选", () => {
    const { env, self } = world();
    // 绕过 CLI 的撞车检查，模拟「先起名、后来别的会话 /rename 成同名」。
    setOcsName("beta-2", { kind: "claude", session: self }, { env });
    const resolved = resolveDmTarget("beta-2", env);
    expect(resolved?.ambiguousNameTargets?.length).toBe(2);
    expect(resolved?.claude).toBeUndefined();
  });

  test("名字可以指向 Codex / Pi；@提及归一成分流认得的地址", () => {
    const { env, other } = world();
    setOcsName("coder", { kind: "codex", id: THREAD }, { env });
    expect(resolveDmTarget("coder", env)).toMatchObject({ kind: "codex-task", threadId: THREAD, via: "ocs-name" });
    setOcsName("helper", { kind: "claude", session: other }, { env });
    expect(canonicalWakeAddress("coder", env)).toBe(THREAD);
    expect(canonicalWakeAddress("helper", env)).toBe("beta-2");
    expect(canonicalWakeAddress("claude-9f00aa11", env)).toBe("beta-2");
    expect(canonicalWakeAddress("beta-2", env)).toBe("beta-2");
    expect(canonicalWakeAddress("nobody", env)).toBe("nobody");
  });

  test("被别人 ocs 名字遮蔽的工作区别名不再对外宣告", () => {
    const { env, self, other } = world();
    const sessions = [self, other];
    expect(shadowFreeWorkspaceAlias(self, sessions, listOcsNames(env))).toBe("alpha-1");
    setOcsName("alpha-1", { kind: "claude", session: other }, { env, force: true });
    expect(shadowFreeWorkspaceAlias(self, sessions, listOcsNames(env))).toBeNull();
  });
});
