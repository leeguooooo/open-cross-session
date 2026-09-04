import { describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV, listNativeSessions } from "../src/claude-inject.ts";
import {
  createIdleSubscription,
  formatDuration,
  IDLE_SUB_TTL_MS,
  idleSubsDir,
  loadIdleSubscription,
  pendingIdleSubscriptions,
  runIdleWatch,
  saveIdleSubscription,
} from "../src/idle.ts";
import { OCS_HOME_ENV } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

// 订阅方 = 本测试进程（有真 socket 收帧）；目标 = 每个 fixture 自己的 sleep 子进程
// （活 pid，可随时杀）。不用 beforeAll 共享：bun test 在用例超时后会杀掉所有子进程。

interface Fixture {
  env: NodeJS.ProcessEnv;
  sessionsDir: string;
  target: ReturnType<typeof Bun.spawn>;
  server: Server;
  frames: string[];
  nextFrame: () => Promise<string>;
  setTarget: (status: "busy" | "idle", statusUpdatedAt?: number) => void;
  removeTarget: () => void;
  close: () => void;
}

function fixture(): Fixture {
  const dir = tempDir("ocs-idle-");
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "sub.sock");
  const frames: string[] = [];
  const waiters: Array<(f: string) => void> = [];
  let consumed = 0; // nextFrame 先吐已到但未取的帧（异步跑 CLI 时帧常早于调用到达），再等新帧
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
    });
    socket.on("end", () => {
      if (buf === "") return;
      frames.push(buf);
      waiters.shift()?.(buf);
    });
  });
  server.listen(sockPath);
  writeFileSync(
    join(sessionsDir, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: "sub-sess", name: "subscriber-1", status: "busy", messagingSocketPath: sockPath }),
    { mode: 0o600 },
  );
  const target = Bun.spawn(["sleep", "120"], { stdio: ["ignore", "ignore", "ignore"] });
  const targetPath = join(sessionsDir, `${target.pid}.json`);
  const setTarget = (status: "busy" | "idle", statusUpdatedAt?: number) =>
    writeFileSync(
      targetPath,
      JSON.stringify({
        pid: target.pid,
        sessionId: "tgt-sess",
        name: "worker-b",
        status,
        ...(statusUpdatedAt !== undefined ? { statusUpdatedAt } : {}),
        messagingSocketPath: join(dir, "target.sock"),
      }),
      { mode: 0o600 },
    );
  return {
    env: { [CLAUDE_NATIVE_SESSIONS_DIR_ENV]: sessionsDir, [OCS_HOME_ENV]: join(dir, "home") },
    sessionsDir,
    target,
    server,
    frames,
    nextFrame: () =>
      new Promise<string>((resolve, reject) => {
        if (consumed < frames.length) {
          resolve(frames[consumed++]!);
          return;
        }
        waiters.push((frame) => {
          consumed++;
          resolve(frame);
        });
        setTimeout(() => reject(new Error("no frame within 3s")), 3000);
      }),
    setTarget,
    removeTarget: () => unlinkSync(targetPath),
    close: () => {
      server.close();
      target.kill();
    },
  };
}

function subscribe(f: Fixture) {
  const sessions = listNativeSessions(f.env);
  const sub = sessions.find((s) => s.pid === process.pid)!;
  const tgt = sessions.find((s) => s.pid === f.target.pid)!;
  return createIdleSubscription({ target: tgt, subscriber: sub, lang: "en", env: f.env });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const content = (frame: string) =>
  (JSON.parse(frame.trim()) as { message: { content: string } }).message.content;

describe("notify-when-idle watcher", () => {
  test("busy→idle 触发恰好一条通知；后续再翻转不再触发（一次性）", async () => {
    const f = fixture();
    try {
      f.setTarget("busy", Date.now() - 65_000);
      const { sub, deduped } = subscribe(f);
      expect(deduped).toBe(false);
      expect(Date.parse(sub.expires) - Date.parse(sub.created)).toBe(IDLE_SUB_TTL_MS);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      await sleep(80);
      expect(f.frames.length).toBe(0); // 还 busy，不许提前发
      f.setTarget("idle");
      const frame = await f.nextFrame();
      const c = content(frame);
      expect(c.startsWith('<cross-session-message from-name="ocs" from-mode="prompting">\n')).toBe(true);
      expect(c).toMatch(/\n\[Cross-session idle notice\] worker-b is now idle\. \(busy for 1m [5-9]s\)\n<\/cross-session-message>$/);
      const done = await Promise.race([watcher, sleep(1500).then(() => "timeout" as const)]);
      expect(done).not.toBe("timeout");
      expect((done as { state: string }).state).toBe("fired");
      // 再翻两次：不能再有任何帧
      f.setTarget("busy");
      await sleep(60);
      f.setTarget("idle");
      await sleep(60);
      f.setTarget("busy");
      await sleep(60);
      f.setTarget("idle");
      await sleep(150);
      expect(f.frames.length).toBe(1);
      expect(loadIdleSubscription(sub.id, f.env)?.state).toBe("fired");
      expect(pendingIdleSubscriptions(f.env)).toEqual([]);
    } finally {
      f.close();
    }
  });

  test("订阅时已 idle → 立即触发", async () => {
    const f = fixture();
    try {
      f.setTarget("idle");
      const { sub } = subscribe(f);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      const frame = await f.nextFrame();
      expect(content(frame)).toContain("[Cross-session idle notice] worker-b is now idle. (busy for 0s)");
      expect((await watcher)?.state).toBe("fired");
      expect(f.frames.length).toBe(1);
    } finally {
      f.close();
    }
  });

  test("目标退出（sessions 文件消失）→ exited 通知", async () => {
    const f = fixture();
    try {
      f.setTarget("busy");
      const { sub } = subscribe(f);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      await sleep(60);
      f.removeTarget();
      const frame = await f.nextFrame();
      expect(content(frame)).toContain("[Cross-session idle notice] worker-b exited before going idle.");
      expect((await watcher)?.state).toBe("exited");
      expect(f.frames.length).toBe(1);
    } finally {
      f.close();
    }
  });

  test("sessionId 变了（pid 复用）也算退出，绝不把别人的 idle 当目标的", async () => {
    const f = fixture();
    try {
      f.setTarget("busy");
      const { sub } = subscribe(f);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      await sleep(60);
      writeFileSync(
        join(f.sessionsDir, `${f.target.pid}.json`),
        JSON.stringify({ pid: f.target.pid, sessionId: "REUSED", name: "worker-b", status: "idle", messagingSocketPath: "/tmp/x.sock" }),
      );
      expect(content(await f.nextFrame())).toContain("exited before going idle");
      expect((await watcher)?.state).toBe("exited");
    } finally {
      f.close();
    }
  });

  test("订阅方自己没了 → watcher 直接收工，不发帧、不空转", async () => {
    const f = fixture();
    try {
      f.setTarget("busy");
      const { sub } = subscribe(f);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      await sleep(60);
      unlinkSync(join(f.sessionsDir, `${process.pid}.json`)); // 订阅方会话注销
      const done = await Promise.race([watcher, sleep(1500).then(() => "timeout" as const)]);
      expect(done).not.toBe("timeout");
      expect((done as { state: string; detail?: string }).state).toBe("failed");
      expect((done as { detail?: string }).detail).toBe("subscriber gone");
      f.setTarget("idle");
      await sleep(100);
      expect(f.frames.length).toBe(0);
      expect(pendingIdleSubscriptions(f.env)).toEqual([]);
    } finally {
      f.close();
    }
  });

  test("过期 → expired 通知（6h 文案逐字）", async () => {
    const f = fixture();
    try {
      f.setTarget("busy");
      const { sub } = subscribe(f);
      saveIdleSubscription({ ...sub, expires: new Date(Date.now() - 1000).toISOString() }, f.env);
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      expect(content(await f.nextFrame())).toContain(
        "[Cross-session idle notice] worker-b did not go idle within 6h; subscription expired.",
      );
      expect((await watcher)?.state).toBe("expired");
    } finally {
      f.close();
    }
  });

  test("同一（目标, 订阅方）重复订阅去重；触发后可再订", async () => {
    const f = fixture();
    try {
      f.setTarget("busy");
      const first = subscribe(f);
      const second = subscribe(f);
      expect(second.deduped).toBe(true);
      expect(second.sub.id).toBe(first.sub.id);
      expect(readdirSync(idleSubsDir(f.env)).filter((n) => n.endsWith(".json")).length).toBe(1);
      expect(pendingIdleSubscriptions(f.env).map((s) => s.id)).toEqual([first.sub.id]);
      saveIdleSubscription({ ...first.sub, state: "fired" }, f.env);
      const third = subscribe(f);
      expect(third.deduped).toBe(false);
      expect(third.sub.id).not.toBe(first.sub.id);
    } finally {
      f.close();
    }
  });

  test("中文通知文案", async () => {
    const f = fixture();
    try {
      f.setTarget("idle");
      const sessions = listNativeSessions(f.env);
      const { sub } = createIdleSubscription({
        target: sessions.find((s) => s.pid === f.target.pid)!,
        subscriber: sessions.find((s) => s.pid === process.pid)!,
        lang: "zh",
        env: f.env,
      });
      const watcher = runIdleWatch(sub.id, { env: f.env, pollMs: 20 });
      expect(content(await f.nextFrame())).toContain("[跨会话空闲通知] worker-b 现在空闲了（忙了 0s）。");
      await watcher;
    } finally {
      f.close();
    }
  });

  test("formatDuration", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59_999)).toBe("59s");
    expect(formatDuration(65_000)).toBe("1m 5s");
    expect(formatDuration(3_600_000 * 2 + 60_000 * 7)).toBe("2h 7m");
  });
});
