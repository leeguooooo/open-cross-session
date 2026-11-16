// Codex 守护进程托管的会话（codex-daemon.ts）：新会话第一轮之前没有 rollout，判活和
// `codex-<8hex>` 寻址都要靠守护进程的 thread/loaded/list。这里守着 fail-closed 的每一条边。
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexDaemonPid,
  codexDaemonSnapshot,
  diagnoseCodexDaemon,
  probeCodexDaemon,
  setCodexDaemonPidSource,
  setCodexDaemonSnapshot,
} from "../src/codex-daemon.ts";
import { collectingSink, deliverToCodexTask } from "../src/deliver.ts";
import { messages } from "../src/i18n.ts";
import { codexThreadLivePid, codexThreadLivePids, queueCodexThread, resetCodexCliProbeCache } from "../src/codex-queue.ts";
import { resolveDmTarget } from "../src/roster.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

autoCleanupTempDirs();

const WITH_ROLLOUT = "01a1aaaa-1111-7222-8333-444444444444";
const FRESH = "01a1bbbb-1111-7222-8333-444444444444";
const EPHEMERAL = "01a1cccc-1111-7222-8333-444444444444";
const UNREADABLE = "01a1dddd-1111-7222-8333-444444444444";
const FRESH_TWIN = "01a1bbbb-9999-7222-8333-444444444444";

// UDS 路径有 104 字节上限，$TMPDIR 在 macOS 上太长：直接用 /tmp。
const dirs: string[] = [];
function shortDir(mode = 0o700): string {
  const dir = mkdtempSync("/tmp/ocs-cxd-");
  chmodSync(dir, mode);
  dirs.push(dir);
  return dir;
}
const servers: Array<{ stop(force?: boolean): void }> = [];
afterEach(() => {
  setCodexDaemonSnapshot(null);
  setCodexDaemonPidSource(null);
  for (const server of servers.splice(0)) server.stop(true);
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

type Reply = (request: { id: number; method: string; params: any }) => unknown | undefined;

/** 假守护进程：UDS 上的 WebSocket，按 reply 回 JSON-RPC；reply 返回 undefined 就不回。 */
function fakeDaemon(reply: Reply, dirMode = 0o700): { sock: string; seen: string[] } {
  const sock = join(shortDir(dirMode), "d.sock");
  const seen: string[] = [];
  const server = Bun.serve({
    unix: sock,
    fetch(req, srv) {
      if (srv.upgrade(req)) return undefined;
      return new Response("no", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        const message = JSON.parse(String(raw));
        if (message.id === undefined) return;
        seen.push(message.method);
        if (message.method === "initialize") {
          ws.send(JSON.stringify({ id: message.id, result: { userAgent: "fake" } }));
          return;
        }
        const answer = reply(message);
        if (answer !== undefined) ws.send(JSON.stringify({ id: message.id, ...(answer as object) }));
      },
    },
  });
  servers.push(server);
  return { sock, seen };
}

/** 典型宿主：一个有 rollout 的老会话、一个没跑过第一轮的新会话、一个宿主内部 ephemeral 线程、一个读不出元数据的。 */
const typical: Reply = ({ method, params }) => {
  if (method === "thread/loaded/list") return { result: { data: [WITH_ROLLOUT, FRESH, EPHEMERAL, UNREADABLE], nextCursor: null } };
  if (method === "thread/read") {
    if (params.threadId === FRESH) return { result: { thread: { id: FRESH, ephemeral: false, cwd: "/work/fresh" } } };
    if (params.threadId === EPHEMERAL) return { result: { thread: { id: EPHEMERAL, ephemeral: true, cwd: "/work/x" } } };
    return { error: { code: -32600, message: "thread not found" } };
  }
  return { error: { code: -32601, message: "unexpected" } };
};

describe("probeCodexDaemon：只读、fail closed", () => {
  test("loaded 且非 ephemeral 才算；没有 rollout 的补读 cwd；读不出的不采信", async () => {
    const daemon = fakeDaemon(typical);
    const snap = await probeCodexDaemon({
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
      rolloutThreadIds: new Set([WITH_ROLLOUT]),
      daemonPid: () => 4242,
    });
    expect(snap.pid).toBe(4242);
    expect([...snap.threads.keys()].sort()).toEqual([WITH_ROLLOUT, FRESH].sort());
    expect(snap.threads.get(FRESH)!.cwd).toBe("/work/fresh");
    // 只读：绝不 resume / queue / 拉起没 loaded 的 thread。
    expect(new Set(daemon.seen)).toEqual(new Set(["initialize", "thread/loaded/list", "thread/read"]));
  });

  test("socket 所在目录他人可写 → 不连（零字节），没有证据", async () => {
    const daemon = fakeDaemon(typical, 0o777);
    const snap = await probeCodexDaemon({
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
      rolloutThreadIds: new Set(),
      daemonPid: () => 4242,
    });
    expect(snap.threads.size).toBe(0);
    expect(daemon.seen).toEqual([]);
  });

  test("守护进程 pid 不可信 → 不连，没有证据（投递后的复查要靠这个 pid）", async () => {
    const daemon = fakeDaemon(typical);
    const snap = await probeCodexDaemon({
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
      rolloutThreadIds: new Set(),
      daemonPid: () => null,
    });
    expect(snap.threads.size).toBe(0);
    expect(daemon.seen).toEqual([]);
  });

  test("loaded/list 报错或应答畸形 → 没有证据", async () => {
    for (const bad of [{ error: { code: -1, message: "nope" } }, { result: { data: "x" } }, { result: null }]) {
      const daemon = fakeDaemon(({ method }) => (method === "thread/loaded/list" ? bad : undefined));
      const snap = await probeCodexDaemon({
        env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
        rolloutThreadIds: new Set(),
        daemonPid: () => 4242,
      });
      expect(snap.threads.size).toBe(0);
    }
  });

  test("守护进程不应答 → 超时后没有证据，不挂住", async () => {
    const daemon = fakeDaemon(() => undefined);
    const started = Date.now();
    const snap = await probeCodexDaemon({
      env: { OCS_CODEX_DAEMON_SOCK: daemon.sock },
      rolloutThreadIds: new Set(),
      daemonPid: () => 4242,
      timeoutMs: 200,
    });
    expect(snap.threads.size).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("socket 不存在 → 没有证据", async () => {
    const snap = await probeCodexDaemon({
      env: { OCS_CODEX_DAEMON_SOCK: join(shortDir(), "missing.sock") },
      rolloutThreadIds: new Set(),
      daemonPid: () => 4242,
    });
    expect(snap.threads.size).toBe(0);
  });
});

describe("codexDaemonPid：守护进程自报 pid 要过 codex 身份校验", () => {
  function home(pid: unknown): NodeJS.ProcessEnv {
    const codexHome = tempDir("ocs-cxd-home-");
    mkdirSync(join(codexHome, "app-server-daemon"), { recursive: true });
    writeFileSync(join(codexHome, "app-server-daemon", "daemon.pid"), JSON.stringify({ pid }));
    return { CODEX_HOME: codexHome };
  }
  const table = (comm: string) => new Map([[777, { ppid: 1, tty: "??", comm }]]);

  test("是 codex 二进制才采信", () => {
    expect(codexDaemonPid(home(777), table("/Users/u/.codex/packages/app-server-daemon/releases/x/bin/codex"))).toBe(777);
    expect(codexDaemonPid(home(777), table("/usr/local/bin/codex-issue-runner"))).toBeNull();
  });

  test("pid 文件缺失/畸形 → null", () => {
    expect(codexDaemonPid({ CODEX_HOME: tempDir("ocs-cxd-none-") }, table("/x/codex"))).toBeNull();
    expect(codexDaemonPid(home("777"), table("/x/codex"))).toBeNull();
    expect(codexDaemonPid(home(1), table("/x/codex"))).toBeNull();
  });
});

describe("判活与寻址：loaded 是 rollout 持有者之外的第二条证据", () => {
  const emptyCodexHome = () => ({ CODEX_HOME: tempDir("ocs-cxd-sessions-") });

  test("快照里 loaded → 活，pid 是守护进程；没拍快照 / pid 不可信 → 不活", () => {
    const env = emptyCodexHome();
    expect(codexThreadLivePid(FRESH, env, new Map())).toBeNull();
    setCodexDaemonSnapshot({ pid: 4242, threads: new Map([[FRESH, { threadId: FRESH, cwd: "/w" }]]) });
    expect(codexThreadLivePid(FRESH, env, new Map())).toBe(4242);
    expect(codexThreadLivePid(FRESH.toUpperCase(), env, new Map())).toBe(4242);
    expect(codexThreadLivePids([FRESH, EPHEMERAL], env, new Map()).has(EPHEMERAL)).toBe(false);
    setCodexDaemonSnapshot({ pid: null, threads: new Map([[FRESH, { threadId: FRESH, cwd: "/w" }]]) });
    expect(codexThreadLivePid(FRESH, env, new Map())).toBeNull();
    expect(codexDaemonSnapshot().threads.size).toBe(0);
  });

  test("loaded 的新会话真的 queue；没 loaded 的一个字都不发", async () => {
    const bin = tempDir("ocs-cxd-bin-");
    const argsLog = join(bin, "args.log");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}\necho "Queued message 01a079c9-7318-7192-ae2c-8078515ad91a for thread $3."\n`, { mode: 0o755 });
    resetCodexCliProbeCache();
    const env = { ...emptyCodexHome(), PATH: `${bin}:/usr/bin:/bin` };
    try {
      expect(queueCodexThread({ threadId: FRESH, prompt: "hi", env })).toMatchObject({ ok: false, reason: "not-live" });
      expect(await Bun.file(argsLog).exists()).toBe(false);
      // 快照的 pid 用测试进程自己：投递后的复查（进程还在）要过。
      setCodexDaemonSnapshot({ pid: process.pid, threads: new Map([[FRESH, { threadId: FRESH, cwd: "/w" }]]) });
      expect(queueCodexThread({ threadId: FRESH, prompt: "hi", env })).toMatchObject({ ok: true, pid: process.pid, threadId: FRESH });
      expect(await Bun.file(argsLog).text()).toContain(`queue --thread ${FRESH} --message hi`);
    } finally {
      resetCodexCliProbeCache();
    }
  });

  test("codex-<8hex> 短地址能解析到只在守护进程里的新会话；前缀撞车报歧义", () => {
    const env = emptyCodexHome();
    expect(resolveDmTarget("codex-01a1bbbb", env)?.threadId).toBeUndefined();
    setCodexDaemonSnapshot({ pid: 4242, threads: new Map([[FRESH, { threadId: FRESH, cwd: "/w" }]]) });
    expect(resolveDmTarget("codex-01a1bbbb", env)).toMatchObject({
      kind: "codex-task",
      identity: `codex:${FRESH}`,
      threadId: FRESH,
    });
    setCodexDaemonSnapshot({
      pid: 4242,
      threads: new Map([
        [FRESH, { threadId: FRESH, cwd: "/w" }],
        [FRESH_TWIN, { threadId: FRESH_TWIN, cwd: "/w" }],
      ]),
    });
    const ambiguous = resolveDmTarget("codex-01a1bbbb", env)!;
    expect(ambiguous.threadId).toBeUndefined();
    expect([...(ambiguous.ambiguousCodexTargets ?? [])].sort()).toEqual([FRESH, FRESH_TWIN].sort());
  });
});

describe("投递：lsof 没证据时按需问守护进程（客户原样用完整 UUID dm 的那条路）", () => {
  function world(reply: Reply) {
    const daemon = fakeDaemon(reply);
    const bin = tempDir("ocs-cxd-dbin-");
    const argsLog = join(bin, "args.log");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argsLog)}\necho "Queued message 01a079c9-7318-7192-ae2c-8078515ad91a for thread $3."\n`, { mode: 0o755 });
    resetCodexCliProbeCache();
    setCodexDaemonPidSource(() => process.pid);
    const env: NodeJS.ProcessEnv = {
      CODEX_HOME: tempDir("ocs-cxd-dhome-"),
      OCS_HOME: tempDir("ocs-cxd-ocs-"),
      OCS_CODEX_DAEMON_SOCK: daemon.sock,
      PATH: `${bin}:/usr/bin:/bin`,
    };
    return { env, argsLog, daemon };
  }
  const wake = { channel: "dm-test", seq: 1, from: "claude-x", body: "hello" };

  test("没有 rollout、守护进程里 loaded → 现拍快照后真的 queue", async () => {
    const w = world(typical);
    const sink = collectingSink();
    try {
      await deliverToCodexTask(FRESH, wake, messages("en"), sink, undefined, w.env, { parkOffline: true, defer: false });
    } finally {
      resetCodexCliProbeCache();
    }
    expect(sink.outcome()).toBe("ok");
    expect(await Bun.file(w.argsLog).text()).toContain(`queue --thread ${FRESH} --message`);
    expect(w.daemon.seen).toContain("thread/loaded/list");
  });

  test("守护进程里没有 → 停靠 inbox，一个字都不 queue", async () => {
    const w = world(({ method }) => (method === "thread/loaded/list" ? { result: { data: [], nextCursor: null } } : undefined));
    const sink = collectingSink();
    try {
      await deliverToCodexTask(FRESH, wake, messages("en"), sink, undefined, w.env, { parkOffline: true, defer: false });
    } finally {
      resetCodexCliProbeCache();
    }
    expect(await Bun.file(w.argsLog).exists()).toBe(false);
    // 后续降级（Desktop IPC）有没有、怎么失败取决于机器；这里只钉住「没 loaded 就绝不 queue」。
    expect(sink.lines.some((line) => /queued →/.test(line))).toBe(false);
  });
});

describe("doctor：守护进程这条证据为什么有/没有", () => {
  test("没 socket / socket 不可信 / pid 不可信 / loaded 计数分得开", async () => {
    expect((await diagnoseCodexDaemon({ OCS_CODEX_DAEMON_SOCK: join(shortDir(), "none.sock") })).kind).toBe("no-daemon");
    const loose = fakeDaemon(typical, 0o777);
    expect((await diagnoseCodexDaemon({ OCS_CODEX_DAEMON_SOCK: loose.sock })).kind).toBe("untrusted-socket");
    expect(loose.seen).toEqual([]);
    const daemon = fakeDaemon(typical);
    setCodexDaemonPidSource(() => null);
    expect((await diagnoseCodexDaemon({ OCS_CODEX_DAEMON_SOCK: daemon.sock, CODEX_HOME: tempDir("ocs-cxd-dg-") })).kind).toBe("pid-unverified");
    setCodexDaemonPidSource(() => 4242);
    expect(await diagnoseCodexDaemon({ OCS_CODEX_DAEMON_SOCK: daemon.sock, CODEX_HOME: tempDir("ocs-cxd-dg-") }))
      .toEqual({ kind: "loaded", pid: 4242, threads: 1 });
  });
});
