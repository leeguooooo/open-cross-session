import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionsRoot, listCodexSessions } from "../src/codex-sessions.ts";
import { discoverCodexDesktopOwners } from "../src/codex-ipc.ts";
import { pickCodexSourceThread, splitWakeMentions, wakeCodexTask } from "../src/wake.ts";

const THREAD_A = "aaaaaaaa-1111-2222-3333-444444444444";
const THREAD_B = "bbbbbbbb-1111-2222-3333-444444444444";
const THREAD_C = "cccccccc-1111-2222-3333-444444444444";
const CLI = join(import.meta.dir, "..", "src", "cli.ts");

function rolloutFixture(options: { withThreadC?: boolean } = {}): NodeJS.ProcessEnv {
  const codexHome = mkdtempSync(join(tmpdir(), "ocs-codex-"));
  const day = join(codexHome, "sessions", "2026", "08", "31");
  mkdirSync(day, { recursive: true });
  const meta = (cwd: string) =>
    `${JSON.stringify({ type: "session_meta", payload: { cwd, originator: "codex", source: "terminal" } })}\n` +
    `${JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "hello\nworld" } })}\n`;
  if (options.withThreadC) {
    // 最老：自动选 source 时排在 A 之后
    writeFileSync(join(day, `rollout-2026-08-31T09-00-00-${THREAD_C}.jsonl`), meta("/tmp/c"));
  }
  writeFileSync(join(day, `rollout-2026-08-31T10-00-00-${THREAD_A}.jsonl`), meta("/tmp/a"));
  writeFileSync(join(day, `rollout-2026-08-31T11-00-00-${THREAD_B}.jsonl`), meta("/tmp/b"));
  return { CODEX_HOME: codexHome };
}

describe("codex-sessions（rollout 发现）", () => {
  test("新的在前，meta/summary 解析正确", () => {
    const env = rolloutFixture();
    const sessions = listCodexSessions(codexSessionsRoot(env));
    expect(sessions.map((s) => s.threadId)).toEqual([THREAD_B, THREAD_A]);
    expect(sessions[0]!.cwd).toBe("/tmp/b");
    expect(sessions[0]!.summary).toBe("hello world");
  });

  test("pickCodexSourceThread 跳过目标自身取最近的另一个", () => {
    const env = rolloutFixture();
    expect(pickCodexSourceThread(THREAD_B, env)).toBe(THREAD_A);
    expect(pickCodexSourceThread(THREAD_A, env)).toBe(THREAD_B);
    expect(pickCodexSourceThread(THREAD_A, { CODEX_HOME: mkdtempSync(join(tmpdir(), "ocs-empty-")) })).toBeNull();
  });
});

describe("splitWakeMentions（@ 分流）", () => {
  test("uuid 形状归 codex，其余归 Claude 会话名", () => {
    const { claudeNames, codexThreads } = splitWakeMentions([
      "worker-a",
      THREAD_A,
      "agentparty-9b",
      THREAD_B,
    ]);
    expect(claudeNames).toEqual(["worker-a", "agentparty-9b"]);
    expect(codexThreads).toEqual([THREAD_A, THREAD_B]);
  });
});

// ── 假 ChatGPT Desktop IPC 路由器：length-prefixed JSON 帧，握手三连 ──

interface FakeRouter {
  env: NodeJS.ProcessEnv;
  server: Server;
  startTurnRequests: Array<Record<string, unknown>>;
  close: () => void;
}

function encodeFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(4 + payload.length);
  frame.writeUInt32LE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

function fakeRouter(
  options: {
    ownerOf?: (threadId: string) => string;
    withThreadC?: boolean;
    ignoreOwnerFor?: ReadonlySet<string>;
  } = {},
): FakeRouter {
  const codexHome = rolloutFixture({ withThreadC: options.withThreadC ?? false }).CODEX_HOME!;
  const ipcDir = join(codexHome, "ipc");
  mkdirSync(ipcDir, { mode: 0o700 });
  const sockPath = join(ipcDir, "ipc.sock");
  const startTurnRequests: Array<Record<string, unknown>> = [];
  const ownerOf = options.ownerOf ?? (() => "renderer-1");

  const server = createServer((socket: Socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const length = buf.readUInt32LE(0);
        if (buf.length < 4 + length) return;
        const message = JSON.parse(buf.subarray(4, 4 + length).toString("utf8")) as Record<string, unknown>;
        buf = buf.subarray(4 + length);
        if (message.type !== "request") continue;
        const params = message.params as Record<string, unknown>;
        const reply = (extra: Record<string, unknown>) =>
          socket.write(encodeFrame({ type: "response", requestId: message.requestId, resultType: "success", ...extra }));
        if (message.method === "initialize") {
          reply({ result: { clientId: "test-client" } });
        } else if (message.method === "thread-owner-discovery") {
          if (options.ignoreOwnerFor?.has(params.conversationId as string)) continue;
          reply({ handledByClientId: ownerOf(params.conversationId as string) });
        } else if (message.method === "thread-follower-start-turn") {
          startTurnRequests.push(params);
          reply({ result: { result: { turn: { id: "turn-42" } } } });
        }
      }
    });
  });
  server.listen(sockPath);
  chmodSync(sockPath, 0o600);
  return { env: { CODEX_HOME: codexHome }, server, startTurnRequests, close: () => server.close() };
}

async function runCli(
  router: FakeRouter,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const env = {
    ...process.env,
    ...router.env,
    OCS_HOME: mkdtempSync(join(tmpdir(), "ocs-codex-cli-")),
    OCS_LANG: "en",
    ...extraEnv,
  } as Record<string, string>;
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CLAUDE_CODE_MESSAGING_SOCKET;
  delete env.OCS_PI_SESSION_ID;
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  return { code: proc.exitCode ?? -1, stdout, stderr };
}

describe("wakeCodexTask 端到端（假 IPC 路由器）", () => {
  test("ocs who 只展示被 open renderer 认领的 Codex task", async () => {
    const router = fakeRouter({ ignoreOwnerFor: new Set([THREAD_A]) });
    try {
      const result = await runCli(router, ["who", "--json"], { CODEX_THREAD_ID: THREAD_B });
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      const roster = JSON.parse(result.stdout) as {
        entries: Array<{
          kind: string;
          target?: string;
          threadId?: string;
          summary?: string | null;
          cwd?: string | null;
          self?: boolean;
        }>;
      };
      const codex = roster.entries.filter((entry) => entry.kind === "codex-task");
      expect(codex).toEqual([{
        kind: "codex-task",
        target: "codex-bbbbbbbb",
        threadId: THREAD_B,
        summary: "hello world",
        cwd: "/tmp/b",
        self: true,
      }]);
    } finally {
      router.close();
    }
  });

  test("ocs doctor 区分 router socket、当前 task ownership 与 rollout 历史", async () => {
    const router = fakeRouter({ ignoreOwnerFor: new Set([THREAD_B]) });
    try {
      const result = await runCli(router, ["doctor"], { CODEX_THREAD_ID: THREAD_B });
      expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: "" });
      expect(result.stdout).toContain("Desktop IPC router socket available");
      expect(result.stdout).toContain("this Codex task (bbbbbbbb) is not claimed by an open Desktop renderer");
      expect(result.stdout).toContain("local Codex rollout record(s) found (history only");
    } finally {
      router.close();
    }
  });

  test("批量 owner 探测只返回被打开 renderer 认领的 task", async () => {
    const router = fakeRouter({ ignoreOwnerFor: new Set([THREAD_A]) });
    try {
      const owners = await discoverCodexDesktopOwners([THREAD_A, THREAD_B], {
        env: router.env,
        timeoutMs: 30,
      });
      expect(owners).toEqual({ [THREAD_B]: "renderer-1" });
    } finally {
      router.close();
    }
  });

  test("同 renderer：turn 被接受，toolOutput 走 codex_app/send_message_to_thread", async () => {
    const router = fakeRouter();
    try {
      const result = await wakeCodexTask({
        targetThreadId: THREAD_B,
        channel: "dev",
        body: "hello codex",
        seq: 9,
        from: "alice",
        env: router.env,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.turnId).toBe("turn-42");
        expect(result.sourceThreadId).toBe(THREAD_A); // 自动选了最近的另一个
      }
      expect(router.startTurnRequests.length).toBe(1);
      const turnStart = (router.startTurnRequests[0]!.turnStart as Record<string, unknown>).request as Record<string, unknown>;
      const toolOutput = turnStart.toolOutput as Record<string, unknown>;
      expect(toolOutput.name).toBe("send_message_to_thread");
      expect(toolOutput.namespace).toBe("codex_app");
      expect(String(toolOutput.output)).toContain("#dev");
      expect(String(toolOutput.output)).toContain("seq 9");
      expect(String(toolOutput.output)).toContain(THREAD_A); // source 钉进 envelope
    } finally {
      router.close();
    }
  });

  test("source/target 不同 renderer 拒投（route-mismatch）", async () => {
    const router = fakeRouter({ ownerOf: (t) => (t === THREAD_B ? "renderer-1" : "renderer-2") });
    try {
      const result = await wakeCodexTask({
        targetThreadId: THREAD_B,
        sourceThreadId: THREAD_A,
        channel: "dev",
        body: "hello codex",
        seq: 1,
        from: "a",
        env: router.env,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("route-mismatch");
      expect(router.startTurnRequests.length).toBe(0);
    } finally {
      router.close();
    }
  });

  test("自动选 source 跳过未打开的 rollout，取下一个同 renderer 候选", async () => {
    // 当前 Desktop 对未认领的 A 不回响应；C（较老）开着且同 renderer → 并发探测后选 C。
    const router = fakeRouter({
      withThreadC: true,
      ignoreOwnerFor: new Set([THREAD_A]),
    });
    try {
      const result = await wakeCodexTask({
        targetThreadId: THREAD_B,
        channel: "dev",
        body: "hello codex",
        seq: 1,
        from: "a",
        env: router.env,
        ownerDiscoveryTimeoutMs: 30,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.sourceThreadId).toBe(THREAD_C);
    } finally {
      router.close();
    }
  });

  test("无人认领的 target 在短探测窗口后如实报告已存储/inbox，不等待默认 10 秒", async () => {
    const router = fakeRouter({ ignoreOwnerFor: new Set([THREAD_B]) });
    try {
      const started = Date.now();
      const result = await wakeCodexTask({
        targetThreadId: THREAD_B,
        channel: "dm-test",
        body: "park me",
        seq: 3,
        from: "a",
        env: router.env,
        ownerDiscoveryTimeoutMs: 30,
      });
      expect(Date.now() - started).toBeLessThan(500);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("not-open");
        expect(result.detail).toContain("not claimed by an open ChatGPT Desktop renderer");
        expect(result.detail).toContain("message is stored in #dm-test");
        expect(result.detail).toContain("ocs inbox");
      }
      expect(router.startTurnRequests).toEqual([]);
    } finally {
      router.close();
    }
  });

  test("target 未打开的报错点名 target；source 未打开的报错点名 source（归因回归）", async () => {
    const targetClosed = fakeRouter({ ownerOf: (t) => (t === THREAD_B ? "" : "renderer-1") });
    try {
      const r1 = await wakeCodexTask({
        targetThreadId: THREAD_B,
        channel: "dev",
        body: "hello codex",
        seq: 1,
        from: "a",
        env: targetClosed.env,
      });
      expect(r1.ok).toBe(false);
      if (!r1.ok) expect(r1.detail).toContain(`target task ${THREAD_B}`);
    } finally {
      targetClosed.close();
    }
    const sourceClosed = fakeRouter({ ownerOf: (t) => (t === THREAD_A ? "" : "renderer-1") });
    try {
      const r2 = await wakeCodexTask({
        targetThreadId: THREAD_B,
        sourceThreadId: THREAD_A,
        channel: "dev",
        body: "hello codex",
        seq: 1,
        from: "a",
        env: sourceClosed.env,
      });
      expect(r2.ok).toBe(false);
      if (!r2.ok) expect(r2.detail).toContain(`source task ${THREAD_A}`);
    } finally {
      sourceClosed.close();
    }
  });

  test("IPC socket 不存在 → unavailable，不炸", async () => {
    const result = await wakeCodexTask({
      targetThreadId: THREAD_B,
      sourceThreadId: THREAD_A,
      channel: "dev",
      body: "hello codex",
      seq: 1,
      from: "a",
      env: { CODEX_HOME: mkdtempSync(join(tmpdir(), "ocs-noipc-")) },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unavailable");
  });
});
