import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { agySocketPath, findAgyWorker, wakeAgy } from "../src/agy.ts";
import { collectingSink, deliverDm } from "../src/deliver.ts";
import { messages } from "../src/i18n.ts";
import { localAddressOf } from "../src/lan-daemon.ts";
import { isReservedOcsName } from "../src/names.ts";
import { resolveDmTarget, selfIdentity } from "../src/roster.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

autoCleanupTempDirs();
const servers: Server[] = [];
const TOKEN = "a".repeat(64);
afterEach(() => { for (const server of servers.splice(0)) server.close(); });

async function worker(drop = false) {
  const home = tempDir("ocs-agy-");
  const dir = join(home, "agy");
  mkdirSync(dir, { mode: 0o700 });
  const path = agySocketPath(TOKEN, { OCS_HOME: home });
  const requests: Record<string, unknown>[] = [];
  const server = createServer((socket) => {
    socket.once("data", (data) => {
      requests.push(JSON.parse(data.toString()));
      if (drop) socket.destroy();
      else socket.end(JSON.stringify({ ok: true, job: "job-1" }) + "\n");
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  servers.push(server);
  chmodSync(path, 0o600);
  const record = { v: 1, target: "agy", token: TOKEN, socketPath: path, pid: process.pid, cwd: home, status: "idle", heartbeat: Date.now() };
  const registration = join(dir, "worker.json");
  writeFileSync(registration, JSON.stringify(record), { mode: 0o600 });
  return { env: { OCS_HOME: home }, requests, registration, record };
}

test("discover and resolve the live agy worker with a compatible DM identity", async () => {
  const w = await worker();
  expect(findAgyWorker(w.env)?.target).toBe("agy");
  const target = resolveDmTarget("agy", w.env)!;
  expect(target.kind).toBe("agy");
  expect(isReservedOcsName("agy")).toBe(true);
  expect(target.identity).toBe(selfIdentity("agy"));
  expect(localAddressOf(target, "agy", w.env)).toEqual({ key: "agy", display: "agy" });
});

test("reject readable-by-other-users and stale registrations before writing", async () => {
  const w = await worker();
  chmodSync(w.registration, 0o644);
  expect((await wakeAgy({ channel: "test", seq: 1, note: "task" }, w.env))).toEqual({ ok: false, reason: "unavailable" });
  chmodSync(w.registration, 0o600);
  writeFileSync(w.registration, JSON.stringify({ ...w.record, heartbeat: Date.now() - 30000 }));
  expect(findAgyWorker(w.env)).toBeNull();
  expect(w.requests).toHaveLength(0);
});

test("queue one wake with the original channel, sequence, Unicode and LAN reply target", async () => {
  const w = await worker();
  const input = { channel: "test", seq: 3, note: "任务：检查代码", replyTarget: "claude-12345678@peer" };
  expect(await wakeAgy(input, w.env)).toEqual({ ok: true, job: "job-1" });
  expect(w.requests).toEqual([{ ...input, token: TOKEN }]);
});

test("missing acknowledgement after writing is unknown and never automatically replayed", async () => {
  const w = await worker(true);
  const result = await wakeAgy({ channel: "test", seq: 1, note: "task" }, w.env);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("unknown-outcome");
  expect(w.requests).toHaveLength(1);
});

test("offline agy is not exposed as a live LAN address", () => {
  const env = { OCS_HOME: tempDir("ocs-agy-offline-") };
  expect(localAddressOf(resolveDmTarget("agy", env)!, "agy", env)).toBeNull();
});

test("delivery acknowledges queuing and suppresses a self wake", async () => {
  const w = await worker();
  const input = { resolved: resolveDmTarget("agy", w.env)!, target: "agy", channel: "test", firstMessage: true,
    stableChannel: false, wakeInput: { channel: "test", seq: 1, from: "claude-test", body: "Review the code" },
    dmReplyTarget: null, env: w.env };
  const sink = collectingSink();
  await deliverDm(input, messages("en"), sink);
  expect(sink.outcome()).toBe("ok");
  expect(sink.lines[0]).toContain("durable task queue");
  expect(String(w.requests[0]?.note)).toContain("Review the code");
  await deliverDm({ ...input, env: { ...w.env, OCS_NAME: "agy" } }, messages("en"), sink);
  expect(w.requests).toHaveLength(1);
});

test("reject a legacy name collision without waking either target", async () => {
  const w = await worker();
  const dir = join(w.env.OCS_HOME, "names");
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, "agy.json"), JSON.stringify({ v: 1, name: "agy", kind: "codex", id: "11111111-1111-4111-8111-111111111111" }), { mode: 0o600 });
  const resolved = resolveDmTarget("agy", w.env)!;
  expect(resolved.ambiguousNameTargets).toHaveLength(2);
  const sink = collectingSink();
  await deliverDm({ resolved, target: "agy", channel: "test", firstMessage: true, stableChannel: false,
    wakeInput: { channel: "test", seq: 1, from: "sender", body: "private" }, dmReplyTarget: null, env: w.env }, messages("en"), sink);
  expect(sink.outcome()).toBe("failed");
  expect(w.requests).toHaveLength(0);
});

test("wire-size limits are checked after JSON escaping, before writing a request", async () => {
  const w = await worker();
  const result = await wakeAgy({ channel: "test", seq: 1, note: "\0".repeat(4096) }, w.env);
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.reason).toBe("rejected");
  expect(w.requests).toHaveLength(0);
});
