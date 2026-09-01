import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_NATIVE_SESSIONS_DIR_ENV,
  injectChannelMessage,
  listNativeSessions,
} from "../src/claude-inject.ts";
import { selectWakeTargets, wakeNote, WAKE_NOTE_MAX_BYTES } from "../src/wake.ts";

// 造一个假的 ~/.claude/sessions 目录 + 真 Unix socket 服务端，端到端验证注入帧。
interface Fixture {
  env: NodeJS.ProcessEnv;
  sockPath: string;
  server: Server;
  received: () => Promise<string>;
}

function fixture(options: { pid?: number; name?: string; sessionId?: string } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ocs-wake-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir, { mode: 0o700 });
  const sockPath = join(dir, "inbox.sock");
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

describe("wakeNote", () => {
  test("恒 ≤512 字节（含长频道名/长名字）", () => {
    const note = wakeNote("a".repeat(64), 999999, "n".repeat(64));
    expect(Buffer.byteLength(note, "utf8")).toBeLessThanOrEqual(WAKE_NOTE_MAX_BYTES);
    expect(note).toContain("ocs read");
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
});

describe("injectChannelMessage 端到端（真 UDS）", () => {
  test("帧写达 socket：user 帧包 cross-session-message，指针正文完整", async () => {
    const f = fixture({ name: "worker-a", sessionId: "sess-e2e" });
    try {
      const result = await injectChannelMessage({
        name: "worker-a",
        pid: process.pid,
        sessionId: "sess-e2e",
        body: wakeNote("dev", 7, "alice"),
        fromName: "alice",
        env: f.env,
      });
      expect(result.ok).toBe(true);
      const raw = await f.received();
      const lines = raw.trimEnd().split("\n");
      expect(lines.length).toBe(1); // 无 peer token → 无 auth 行
      const frame = JSON.parse(lines[0]!) as Record<string, unknown>;
      expect(frame.type).toBe("user");
      expect(frame.priority).toBe("next");
      const message = frame.message as { role: string; content: string };
      expect(message.role).toBe("user");
      expect(message.content).toContain('<cross-session-message from-name="alice" from-mode="prompting">');
      expect(message.content).toContain("#dev");
      expect(message.content).toContain("seq 7");
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
