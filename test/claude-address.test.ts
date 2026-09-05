import { describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { autoCleanupTempDirs, tempDir } from "./tmp";
autoCleanupTempDirs();
import { resetClaudeAddressCachesForTest, uniqueClaudeWorkspaceIdentity } from "../src/claude-address.ts";
import type { NativeClaudeSession } from "../src/claude-inject.ts";
import { OCS_HOME_ENV } from "../src/store.ts";

const REPO_CWD = join(import.meta.dir, "..");

function freshEnv(): NodeJS.ProcessEnv {
  return { [OCS_HOME_ENV]: tempDir("ocs-address-") };
}

function session(cwd: string): NativeClaudeSession {
  return {
    pid: process.pid, sessionId: "s", name: "w", cwd, status: "idle",
    statusUpdatedAt: null, kind: null, messagingSocketPath: "/tmp/x.sock", procStart: null,
  };
}

describe("workspaceKey 首次创建的并发窗口（#27 #290 线索）", () => {
  // 本函数先于注册表锁执行。首次创建时两个进程可以这样交错：我方 read() →
  // ENOENT；对方 writeOnce(key) → read() → writeOnce(id)；我方 readId() → 存在。
  // 修复是在那一步再回读一次 key。多进程压力脚本（80×16）在修复前打出
  // "workspace key is missing but …-id still exists"，修复后 140 轮零次。
  // 这里守住修复的两侧边界。
  test("key 真丢了、id 还在：仍然抛错，回读不弱化损坏检测", () => {
    const env = freshEnv();
    const self = session(REPO_CWD);
    expect(uniqueClaudeWorkspaceIdentity(self, [self], env)).toMatch(/^workspace:[0-9a-f]{64}$/);
    unlinkSync(join(env[OCS_HOME_ENV]!, "workspace-key")); // id 留着
    resetClaudeAddressCachesForTest();
    expect(() => uniqueClaudeWorkspaceIdentity(self, [self], env)).toThrow(/workspace key is missing/);
  });

  test("key 与 id 已由别的进程写好：直接采用，身份收敛", () => {
    const env = freshEnv();
    const self = session(REPO_CWD);
    const a = uniqueClaudeWorkspaceIdentity(self, [self], env);
    resetClaudeAddressCachesForTest(); // 模拟另一个进程冷启动读同一个 home
    expect(uniqueClaudeWorkspaceIdentity(self, [self], env)).toBe(a);
  });
});

describe("git 没能回答时不得编造另一个身份（#27 负载放大源）", () => {
  // git() 原来把超时/spawn 失败和「git 明确说没有 remote」一样返回 null，
  // 于是锚点 material 从 git:<remote> 悄悄换成 gitdir:<path>，对同一个 key
  // 算出另一个稳定身份并写进注册表——此后该别名永远 conflicts with saved state。
  // 清空 PATH 让 spawn 确定性失败，模拟 1s 超时那一类「没能回答」。
  test("spawn 失败 → 无锚点（null），而不是换 material 得到不同身份", () => {
    const env = freshEnv();
    const self = session(REPO_CWD);
    const withGit = uniqueClaudeWorkspaceIdentity(self, [self], env);
    expect(withGit).toMatch(/^workspace:/);
    // 本进程里改 PATH 没用：Bun 的 spawnSync 不传 env 时用启动时快照的 PATH。
    // 在子进程里跑同一函数，把一个被信号杀死的假 git 前置进它的 PATH——
    // 两次尝试都拿不到退出码（status === null），正是「没能回答」。
    const fakeBin = tempDir("ocs-fakegit-");
    writeFileSync(join(fakeBin, "git"), "#!/bin/sh\nkill -KILL $$\n", { mode: 0o755 });
    const script = `
      import { uniqueClaudeWorkspaceIdentity } from ${JSON.stringify(join(import.meta.dir, "..", "src", "claude-address.ts"))};
      const self = ${JSON.stringify(self)};
      console.log(JSON.stringify(uniqueClaudeWorkspaceIdentity(self, [self], process.env)));
    `;
    const child = Bun.spawnSync(["bun", "-e", script], {
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, [OCS_HOME_ENV]: env[OCS_HOME_ENV]! },
    });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString().trim())).toBeNull();
    // 失败不缓存：git 回来后身份必须和最初一致。
    resetClaudeAddressCachesForTest();
    expect(uniqueClaudeWorkspaceIdentity(self, [self], env)).toBe(withGit);
  });

  test("git 明确说没有 remote（非 git 目录）仍是稳定身份，且每次一致", () => {
    const env = freshEnv();
    const self = session(tempDir("ocs-nogit-"));
    const a = uniqueClaudeWorkspaceIdentity(self, [self], env);
    expect(a).toMatch(/^workspace:/);
    resetClaudeAddressCachesForTest();
    expect(uniqueClaudeWorkspaceIdentity(self, [self], env)).toBe(a);
  });
});
