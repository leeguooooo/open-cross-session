import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_NATIVE_SESSIONS_DIR_ENV,
  injectChannelMessage,
  listNativeSessions,
} from "../src/claude-inject.ts";
import {
  CLAUDE_MESSAGING_SOCKET_ENV,
  CLAUDE_SESSION_ID_ENV,
  findSelfClaudePid,
  parentPidOf,
  selectWakeTargets,
  truncateUtf8,
  wakeNote,
  wakeSessions,
  WAKE_BODY_INLINE_MAX_BYTES,
  WAKE_BODY_PREVIEW_BYTES,
  WAKE_NOTE_MAX_BYTES,
  WAKE_SKELETON_MAX_BYTES,
} from "../src/wake.ts";

// 造一个假的 ~/.claude/sessions 目录 + 真 Unix socket 服务端，端到端验证注入帧。
interface Fixture {
  env: NodeJS.ProcessEnv;
  sockPath: string;
  server: Server;
  received: () => Promise<string>;
}

function fixture(options: { pid?: number; name?: string; sessionId?: string; sockName?: string; cwd?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ocs-wake-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, options.sockName ?? "inbox.sock");
  let resolveData: (data: string) => void;
  const dataPromise = new Promise<string>((resolve) => {
    resolveData = resolve;
  });
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buf !== "") resolveData(buf);
    });
  });
  server.listen(sockPath);
  const pid = options.pid ?? process.pid; // 用自己的 pid 保证 pidAlive 通过
  writeFileSync(
    join(sessionsDir, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: options.sessionId ?? "sess-1234",
      name: options.name ?? "worker-a",
      cwd: options.cwd ?? "/work/worker",
      status: "idle",
      kind: "interactive",
      messagingSocketPath: sockPath,
    }),
    { mode: 0o600 },
  );
  return {
    env: { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir },
    sockPath,
    server,
    received: () => dataPromise,
  };
}

const bytes = (s: string) => Buffer.byteLength(s, "utf8");

describe("wakeNote（协议 §1 骨架）", () => {
  test("≤4096 字节正文逐字内联；Reply:/Thread: 行逐字精确；行序固定", () => {
    const body = 'line one with "quotes" <tags> and @bob\nline two';
    const note = wakeNote({ channel: "dev", seq: 7, from: "alice", body, receiver: "worker-a", replyTo: 3 });
    expect(note).toBe(
      "[ocs wake] alice mentioned you in #dev (seq 7, reply to seq 3)\n" +
        "\n" +
        `${body}\n` +
        "\n" +
        'Reply: ocs send dev "<your reply>" --as worker-a --reply-to 7\n' +
        "Thread: ocs read dev --as worker-a",
    );
  });

  test("刚好 4096 字节仍逐字内联；4097 字节截成前 512 字节 + 总字节数 + 读线程命令", () => {
    const exact = "x".repeat(WAKE_BODY_INLINE_MAX_BYTES);
    expect(wakeNote({ channel: "dev", seq: 1, from: "a", body: exact, receiver: "b" })).toContain(`\n\n${exact}\n\n`);

    const over = "y".repeat(WAKE_BODY_INLINE_MAX_BYTES + 1);
    const note = wakeNote({ channel: "dev", seq: 1, from: "a", body: over, receiver: "b" });
    const inlined = note.split("\n")[2]!;
    expect(bytes(inlined)).toBe(WAKE_BODY_PREVIEW_BYTES);
    expect(note.split("\n")[3]).toBe(`… (${WAKE_BODY_INLINE_MAX_BYTES + 1} bytes total; full text: ocs read dev --as b)`);
    expect(note).not.toContain("y".repeat(WAKE_BODY_PREVIEW_BYTES + 1));
  });

  test("截断落在字符边界：多字节字符与代理对不被切开", () => {
    // 510 个 ASCII + 一个 4 字节 emoji 跨过 512 边界 → 前缀只剩 510 字节，emoji 整个不进。
    const body = `${"a".repeat(510)}😀${"z".repeat(5000)}`;
    const note = wakeNote({ channel: "dev", seq: 1, from: "a", body, receiver: "b" });
    const inlined = note.split("\n")[2]!;
    expect(inlined).toBe("a".repeat(510));
    expect(bytes(inlined)).toBeLessThanOrEqual(WAKE_BODY_PREVIEW_BYTES);
    // 3 字节汉字版：511 个 ASCII + 「中」 → 511
    const zhBody = `${"a".repeat(511)}中${"z".repeat(5000)}`;
    const zhInlined = wakeNote({ channel: "dev", seq: 1, from: "a", body: zhBody, receiver: "b" }).split("\n")[2]!;
    expect(zhInlined).toBe("a".repeat(511));
    expect(truncateUtf8("中文", 3)).toBe("中");
    expect(truncateUtf8("中文", 5)).toBe("中");
    expect(truncateUtf8("中文", 6)).toBe("中文");
  });

  test("4096 字节正文 + 64 字符频道/名字：整条 ≤5120，骨架 ≤1024，Reply/Thread 永不砍", () => {
    const channel = "c".repeat(64);
    const sender = "s".repeat(64);
    const receiver = "r".repeat(64);
    const body = "b".repeat(WAKE_BODY_INLINE_MAX_BYTES);
    for (const lang of ["en", "zh"] as const) {
      const note = wakeNote({ channel, seq: 999999, from: sender, body, receiver, replyTo: 999998, ago: "just now", lang });
      expect(bytes(note)).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
      expect(bytes(note) - bytes(body)).toBeLessThanOrEqual(WAKE_SKELETON_MAX_BYTES);
      expect(note).toContain(`ocs send ${channel} "<your reply>" --as ${receiver} --reply-to 999999`);
      expect(note).toContain(`ocs read ${channel} --as ${receiver}`);
    }
  });

  test("骨架超预算按阶梯降级：先砍 ago 再砍 sender，两行命令保留", () => {
    // 骨架 = header + 5 个换行 + Reply 行 + Thread 行；header 不带 ago 时 = 41 + sender 长度。
    // sender 895：不带 ago 恰好 1022 ≤ 1024，带 ago（+8）超 → 只砍 ago。
    const keepSender = "h".repeat(895);
    const note = wakeNote({ channel: "dev", seq: 1, from: keepSender, body: "hi", receiver: "b", ago: "1m ago" });
    expect(bytes(note) - bytes("hi")).toBeLessThanOrEqual(WAKE_SKELETON_MAX_BYTES);
    expect(note).not.toContain("1m ago");
    expect(note).toContain(`[ocs wake] ${keepSender} mentioned you`);
    expect(note).toContain('Reply: ocs send dev "<your reply>" --as b --reply-to 1');
    expect(note).toContain("Thread: ocs read dev --as b");
    // sender 1000：砍掉 ago 仍超 → 再砍 sender
    const dropSender = "h".repeat(1000);
    const note2 = wakeNote({ channel: "dev", seq: 1, from: dropSender, body: "hi", receiver: "b", ago: "1m ago" });
    expect(bytes(note2) - bytes("hi")).toBeLessThanOrEqual(WAKE_SKELETON_MAX_BYTES);
    expect(note2).not.toContain(dropSender);
    expect(note2).toContain("[ocs wake] New mention in #dev (seq 1)");
    expect(note2).toContain('Reply: ocs send dev "<your reply>" --as b --reply-to 1');
    expect(note2).toContain("Thread: ocs read dev --as b");
    // receiver 塞爆到连砍 sender 都不够 → 编程错误，明确抛出而不是产出超限 note
    expect(() => wakeNote({ channel: "dev", seq: 1, from: "a", body: "hi", receiver: "r".repeat(1200) })).toThrow();
  });

  test("中文骨架", () => {
    const note = wakeNote({ channel: "dev", seq: 7, from: "alice", body: "你好", receiver: "worker-a", replyTo: 3, lang: "zh" });
    expect(note).toBe(
      "[ocs 唤醒] alice 在 #dev 提到了你（seq 7，回复 seq 3）\n" +
        "\n" +
        "你好\n" +
        "\n" +
        '回复：ocs send dev "<your reply>" --as worker-a --reply-to 7\n' +
        "线程：ocs read dev --as worker-a",
    );
  });

  test("Claude DM 的 Reply 使用对方名字，Thread 保留完整频道但不再带 --as（#8 #9）", () => {
    const channel = "dm-6045332524136dc61bd34ebf09051258ad0e2e7c--agent";
    const note = wakeNote({
      channel,
      seq: 7,
      from: "agentparty-eb",
      body: "hello",
      receiver: "super-admin-af",
      dmReplyTarget: "agentparty-eb",
    });
    expect(note).toContain('Reply: ocs dm agentparty-eb "<your reply>"');
    expect(note).toContain(`Thread: ocs read ${channel}`);
    expect(note).not.toContain("--as super-admin-af");
    expect(note).not.toContain("--reply-to 7");
  });
});

describe("listNativeSessions / selectWakeTargets", () => {
  test("列出 fixture 会话；mention 求交；selfPids 排除", () => {
    const f = fixture({ name: "worker-a" });
    try {
      const sessions = listNativeSessions(f.env);
      expect(sessions.map((s) => s.name)).toEqual(["worker-a"]);

      const hit = selectWakeTargets(["worker-a", "ghost"], { env: f.env });
      expect(hit.targets.map((s) => s.name)).toEqual(["worker-a"]);

      const excluded = selectWakeTargets(["worker-a"], { selfPids: [process.pid], env: f.env });
      expect(excluded.targets).toEqual([]);
      expect(excluded.excludedSelf).toEqual([process.pid]);
    } finally {
      f.server.close();
    }
  });

  test("唯一工作区别名能唤醒当前会话，不猜测旧的一次性名字（#7）", () => {
    const f = fixture({ name: "choose-browser-21", cwd: "/work/choose-browser" });
    try {
      expect(selectWakeTargets(["choose-browser"], { env: f.env }).targets.map((s) => s.name))
        .toEqual(["choose-browser-21"]);
      expect(selectWakeTargets(["choose-browser-10"], { env: f.env }).targets).toEqual([]);
    } finally {
      f.server.close();
    }
  });

  test("#3：发送者按名字也被排除（--as 的名字 @ 到自己不回环）", () => {
    const f = fixture({ name: "super-admin-c7" });
    try {
      const byName = selectWakeTargets(["super-admin-c7"], { selfNames: ["super-admin-c7"], env: f.env });
      expect(byName.targets).toEqual([]);
      expect(byName.excludedSelf).toEqual([process.pid]);
      const other = selectWakeTargets(["super-admin-c7"], { selfNames: ["someone-else"], env: f.env });
      expect(other.targets.map((s) => s.name)).toEqual(["super-admin-c7"]);
    } finally {
      f.server.close();
    }
  });
});

describe("injectChannelMessage 端到端（真 UDS）", () => {
  test("帧写达 socket：包装内含正文逐字 + 精确的 Reply: 命令", async () => {
    const f = fixture({ name: "worker-a", sessionId: "sess-e2e" });
    try {
      const body = 'please review PR #12\nsecond line with "quotes"';
      const [outcome] = await wakeSessions(listNativeSessions(f.env), {
        channel: "dev",
        seq: 7,
        from: "alice",
        body,
        replyTo: 2,
        env: f.env,
      });
      expect(outcome!.result.ok).toBe(true);
      const raw = await f.received();
      const lines = raw.trimEnd().split("\n");
      expect(lines.length).toBe(1); // 无 peer token → 无 auth 行
      const frame = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(frame.type).toBe("user");
      expect(frame.priority).toBe("next");
      const message = frame.message as { role: string; content: string };
      expect(message.role).toBe("user");
      expect(message.content.startsWith('<cross-session-message from-name="alice" from-mode="prompting">\n')).toBe(true);
      expect(message.content.endsWith("\n</cross-session-message>")).toBe(true);
      expect(message.content).toContain("[ocs wake] alice mentioned you in #dev (seq 7, reply to seq 2)\n\n");
      expect(message.content).toContain(`\n\n${body}\n\n`);
      expect(message.content).toContain('\nReply: ocs send dev "<your reply>" --as worker-a --reply-to 7\n');
      expect(message.content).toContain("\nThread: ocs read dev --as worker-a\n");
    } finally {
      f.server.close();
    }
  });

  test("sessionId 不匹配拒投（防 pid 复用投错会话）", async () => {
    const f = fixture({ sessionId: "sess-real" });
    try {
      const result = await injectChannelMessage({
        name: "worker-a",
        pid: process.pid,
        sessionId: "sess-STALE",
        body: "x",
        fromName: "alice",
        env: f.env,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("no-match");
    } finally {
      f.server.close();
    }
  });
});

describe("findSelfClaudePid：ps 缺失也不许炸", () => {
  // 祖先链用真子进程验证：测试进程自己写 sessions json，子进程（CLI）沿祖先链找到它。
  // 不拿 process.ppid 当断言依据——容器里 bun test 的父进程就是 pid 1。
  function whoami(pathEnv: string | undefined): { code: number | null; stdout: string; stderr: string } {
    const dir = mkdtempSync(join(tmpdir(), "ocs-self-"));
    const sessionsDir = join(dir, "sessions");
    mkdirSync(sessionsDir, { mode: 0o700 });
    writeFileSync(
      join(sessionsDir, `${process.pid}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "s", name: "tester", status: "idle", messagingSocketPath: join(dir, "x.sock") }),
    );
    const proc = Bun.spawnSync([process.execPath, join(import.meta.dir, "..", "src", "cli.ts"), "whoami"], {
      env: {
        PATH: pathEnv ?? process.env.PATH ?? "",
        HOME: dir,
        [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir,
        OCS_LANG: "en",
      },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString().trim(), stderr: proc.stderr.toString() };
  }

  test("parentPidOf 与 process.ppid 一致", () => {
    expect(parentPidOf(process.pid)).toBe(process.ppid);
  });

  test("正常 PATH：CLI 沿祖先链认出本测试进程", () => {
    const r = whoami(undefined);
    expect(r.stderr).not.toContain("TypeError");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("tester");
  }, 30_000);

  test("PATH 指向空目录（无 ps）：不崩——有 /proc 的 Linux 照样认出，否则明确说认不出", () => {
    const r = whoami(mkdtempSync(join(tmpdir(), "ocs-empty-bin-")));
    expect(r.stderr).not.toContain("TypeError");
    if (existsSync("/proc/self/stat")) {
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("tester");
    } else {
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("cannot tell who you are");
    }
  }, 30_000);
});

describe("findSelfClaudePid：环境变量优先，祖先链兜底", () => {
  // parentPid 注入一个计数桩：调用次数 = 会 spawn（ps）的次数；桩的链把任何 pid 都指向本进程。
  function counting() {
    let calls = 0;
    return { calls: () => calls, parentPid: (_pid: number) => { calls++; return process.pid; } };
  }

  test("三者一致（sessionId、socket 路径、pid 活）→ 直接认出，零 spawn", () => {
    const f = fixture({ sessionId: "sess-env", sockName: `${process.pid}.sock` });
    const c = counting();
    try {
      const env = { ...f.env, [CLAUDE_SESSION_ID_ENV]: "sess-env", [CLAUDE_MESSAGING_SOCKET_ENV]: f.sockPath };
      expect(findSelfClaudePid(env, 10, { parentPid: c.parentPid })).toBe(process.pid);
      expect(c.calls()).toBe(0);
    } finally {
      f.server.close();
    }
  });

  test("环境变量与文件不一致 → 忽略环境变量，回落祖先链", () => {
    const f = fixture({ sessionId: "sess-real", sockName: `${process.pid}.sock` });
    try {
      // sessionId 陈旧（/clear 后换会话）
      const stale = { ...f.env, [CLAUDE_SESSION_ID_ENV]: "sess-STALE", [CLAUDE_MESSAGING_SOCKET_ENV]: f.sockPath };
      const c1 = counting();
      expect(findSelfClaudePid(stale, 10, { parentPid: c1.parentPid })).toBe(process.pid);
      expect(c1.calls()).toBeGreaterThan(0);
      // socket 路径对不上
      const wrongSock = { ...f.env, [CLAUDE_SESSION_ID_ENV]: "sess-real", [CLAUDE_MESSAGING_SOCKET_ENV]: `/tmp/elsewhere/${process.pid}.sock` };
      const c2 = counting();
      expect(findSelfClaudePid(wrongSock, 10, { parentPid: c2.parentPid })).toBe(process.pid);
      expect(c2.calls()).toBeGreaterThan(0);
      // socket 文件名里的 pid 不是活会话
      const deadPid = { ...f.env, [CLAUDE_SESSION_ID_ENV]: "sess-real", [CLAUDE_MESSAGING_SOCKET_ENV]: "/tmp/cc-socks/999999999.sock" };
      const c3 = counting();
      expect(findSelfClaudePid(deadPid, 10, { parentPid: c3.parentPid })).toBe(process.pid);
      expect(c3.calls()).toBeGreaterThan(0);
      // 祖先链也找不到 → null，不抛
      const nobody = { ...stale };
      expect(findSelfClaudePid(nobody, 10, { parentPid: () => null })).toBeNull();
    } finally {
      f.server.close();
    }
  });

  test("环境变量缺失 → 现有祖先链路径", () => {
    const f = fixture();
    const c = counting();
    try {
      expect(f.env[CLAUDE_SESSION_ID_ENV]).toBeUndefined();
      expect(findSelfClaudePid(f.env, 10, { parentPid: c.parentPid })).toBe(process.pid);
      expect(c.calls()).toBe(1);
    } finally {
      f.server.close();
    }
  });
});
