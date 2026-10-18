import { afterEach, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { readRoutedMessages } from "../src/store.ts";

// Every registry, channel, and pipe belongs to the fixture. No live agent is used.
const SELF_ID = "12345678-1234-4234-8234-123456789abc";
const PEER_ID = "87654321-4321-4321-8321-cba987654321";
const SELF = "claude-12345678";
const PEER = "claude-87654321";
const CLI = process.env.OCS_TEST_BINARY
  ? [process.env.OCS_TEST_BINARY]
  : [process.execPath, join(import.meta.dir, "..", "src", "cli.ts")];
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(workspaces = false) {
  const tempRoot = resolve(tmpdir());
  const dir = mkdtempSync(join(tempRoot, "ocs-sender-title-"));
  const sessionsDir = join(dir, "sessions");
  const home = join(dir, "state");
  mkdirSync(sessionsDir);
  const servers: Server[] = [];
  const sockets = new Set<Socket>();
  const messages: Record<"self" | "peer", string[]> = { self: [], peer: [] };
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
    if (dirname(resolve(dir)) !== tempRoot || !basename(dir).startsWith("ocs-sender-title-")) {
      throw new Error(`refusing cleanup outside fixture temp root: ${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  const baseEnv: Record<string, string> = {};
  for (const key of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP", "COMSPEC", "USERPROFILE"]) {
    if (process.env[key] !== undefined) baseEnv[key] = process.env[key]!;
  }
  Object.assign(baseEnv, {
    OCS_HOME: home,
    OCS_CLAUDE_NATIVE_SESSIONS_DIR: sessionsDir,
    OCS_NO_UPDATE_CHECK: "1",
    OCS_UPGRADE_CHECK: "0",
    OCS_NO_RECEIPTS: "1",
    OCS_LANG: "en",
  });
  // The existing parent is only a live-PID fixture entry, never a message endpoint.
  const records = {
    self: { pid: process.pid, sessionId: SELF_ID, name: "OCS skill for Codex agent" },
    peer: { pid: process.ppid, sessionId: PEER_ID, name: "Peer with spaces" },
  };
  expect(records.peer.pid).toBeGreaterThan(1);
  expect(records.peer.pid).not.toBe(records.self.pid);
  const endpoints: Record<string, string> = {};
  for (const side of ["self", "peer"] as const) {
    const endpoint = process.platform === "win32"
      ? `\\\\.\\pipe\\ocs-sender-title-${randomUUID()}`
      : join(dir, `${side}.sock`);
    endpoints[side] = endpoint;
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("error", () => {});
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const frame = JSON.parse(line);
          if (frame.type === "user") messages[side].push(frame.message.content);
        }
      });
    });
    servers.push(server);
    server.listen(endpoint);
    await once(server, "listening");
    const hash = createHash("sha256").update(endpoint).digest("hex");
    writeFileSync(join(sessionsDir, `${records[side].pid}.${hash}.key`),
      JSON.stringify({ peerToken: "0123456789abcdef0123456789abcdef" }));
    if (workspaces) {
      const cwd = join(dir, `${side}-workspace`);
      mkdirSync(cwd);
      // Keep each fixture independent of any Git repository containing TEMP.
      expect(Bun.spawnSync(["git", "init", "--quiet", cwd], { env: baseEnv }).exitCode).toBe(0);
    }
  }
  function save(side: "self" | "peer") {
    writeFileSync(join(sessionsDir, `${records[side].pid}.json`), JSON.stringify({
      ...records[side], status: "idle", messagingSocketPath: endpoints[side],
      ...(workspaces ? { cwd: join(dir, `${side}-workspace`) } : {}),
    }));
  }
  save("self");
  save("peer");
  const envFor = (side: "self" | "peer", overrides: Record<string, string> = {}) => ({
    ...baseEnv,
    CLAUDE_CODE_SESSION_ID: records[side].sessionId,
    CLAUDE_CODE_MESSAGING_SOCKET: endpoints[side]!,
    ...overrides,
  });
  async function run(side: "self" | "peer", args: string[], overrides: Record<string, string> = {}) {
    const proc = Bun.spawn([...CLI, ...args], {
      env: envFor(side, overrides), cwd: dir, stdout: "pipe", stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
    ]);
    return { code, stdout: stdout.trim(), stderr: stderr.trim() };
  }
  async function received(side: "self" | "peer", count: number) {
    const deadline = Date.now() + 3000;
    while (messages[side].length < count && Date.now() < deadline) await Bun.sleep(10);
    expect(messages[side].length).toBe(count);
    return messages[side][count - 1]!;
  }
  return { dir, home, messages, records, save, run, received, env: baseEnv };
}

function channelOf(stdout: string): string {
  const channel = /\(channel ([^,]+), seq \d+\)/.exec(stdout)?.[1];
  expect(channel).toBeDefined();
  return channel!;
}

describe("Claude desktop titles as sender identities", () => {
  test("invalid display titles use a stable sender ID and are not advertised as addresses", async () => {
    const f = await fixture();
    for (const title of ["OCS skill for Codex agent", "Email: review!", "邮件内容", "A".repeat(65)]) {
      f.records.self.name = title;
      f.save("self");
      expect(await f.run("self", ["whoami"])).toEqual({ code: 0, stdout: SELF, stderr: "" });
      const info = await f.run("self", ["whoami", "--json"]);
      expect(info.code).toBe(0);
      expect(JSON.parse(info.stdout)).toMatchObject({ id: SELF, session: title, addresses: [SELF] });
      expect((await f.run("self", ["whoami", "--session", SELF_ID])).stdout).toBe(SELF);
    }
  });

  test("valid mixed-case names and explicit identity overrides retain their behavior", async () => {
    const f = await fixture();
    f.records.self.name = "Valid.Mixed_CASE-1";
    f.save("self");
    expect((await f.run("self", ["whoami"])).stdout).toBe("Valid.Mixed_CASE-1");
    expect((await f.run("self", ["whoami"], { OCS_NAME: "chosen-role" })).stdout).toBe("chosen-role");
    const sent = await f.run("self", ["send", "chat", "override", "--no-wake", "--as", "explicit-role"]);
    expect(sent.code).toBe(0);
    expect(readRoutedMessages("chat", { env: f.env })[0]?.from).toBe("explicit-role");
  });

  test("channel send/read work without --as before and after assigning an ocs name", async () => {
    const f = await fixture();
    expect((await f.run("self", ["send", "chat", "first", "--no-wake"])).code).toBe(0);
    expect((await f.run("self", ["rename", "local-reviewer"])).code).toBe(0);
    const info = await f.run("self", ["whoami", "--json"]);
    expect(JSON.parse(info.stdout)).toMatchObject({ name: "local-reviewer", addresses: ["local-reviewer", SELF] });
    expect((await f.run("self", ["send", "chat", "second", "--no-wake"])).code).toBe(0);
    const read = await f.run("self", ["read", "chat", "--json"]);
    expect(read.code).toBe(0);
    expect(JSON.parse(read.stdout).map((message: { from: string; self: boolean }) => [message.from, message.self]))
      .toEqual([[SELF, true], [SELF, true]]);
  });

  test("DM and reverse DM use the same channel and full session identities", async () => {
    const f = await fixture();
    const sent = await f.run("self", ["dm", PEER, "fixture ping"]);
    expect(sent.code).toBe(0);
    const channel = channelOf(sent.stdout);
    expect(await f.received("peer", 1)).toContain("fixture ping");
    const reply = await f.run("peer", ["dm", SELF, "fixture pong"]);
    expect(reply.code).toBe(0);
    expect(channelOf(reply.stdout)).toBe(channel);
    expect(await f.received("self", 1)).toContain("fixture pong");
    expect(readRoutedMessages(channel, { env: f.env }).map((message) => ({
      from: message.from, fromIdentity: message.from_identity, toIdentity: message.to_identity,
    }))).toEqual([
      { from: SELF, fromIdentity: `claude:${SELF_ID}`, toIdentity: `claude:${PEER_ID}` },
      { from: PEER, fromIdentity: `claude:${PEER_ID}`, toIdentity: `claude:${SELF_ID}` },
    ]);
  });

  test("generated --reply-to commands wake the short-ID sender and preserve inbox routing", async () => {
    const f = await fixture();
    const sent = await f.run("self", ["dm", PEER, "inbox ping"]);
    expect(sent.code).toBe(0);
    const channel = channelOf(sent.stdout);
    expect(await f.received("peer", 1)).toContain(`Reply: ocs send ${channel}`);
    const inbox = await f.run("peer", ["inbox", "--json"]);
    expect(inbox.code).toBe(0);
    expect(JSON.parse(inbox.stdout)).toMatchObject([{ channel, unread: 1 }]);
    const pinned = await f.run("peer", ["inbox", "--session", PEER_ID, "--json"]);
    expect(pinned.code).toBe(0);
    expect(JSON.parse(pinned.stdout)).toEqual(JSON.parse(inbox.stdout));
    expect((await f.run("peer", ["read", channel, "--json"])).code).toBe(0);
    const reply = await f.run("peer", ["send", channel, "inbox pong", "--reply-to", "1"]);
    expect(reply.code).toBe(0);
    expect(await f.received("self", 1)).toContain("inbox pong");
    const routed = readRoutedMessages(channel, { env: f.env });
    expect(routed[1]).toMatchObject({
      from: PEER, from_identity: `claude:${PEER_ID}`, to_identity: `claude:${SELF_ID}`, reply_to: 1,
    });
    expect(JSON.parse((await f.run("self", ["inbox", "--json"])).stdout)).toMatchObject([{ channel, unread: 1 }]);
    const read = await f.run("self", ["read", channel, "--json"]);
    expect(JSON.parse(read.stdout)).toMatchObject([{ seq: 2, body: "inbox pong", self: false }]);
    expect(JSON.parse((await f.run("self", ["inbox", "--json"])).stdout)).toEqual([]);
  });

  test("workspace routing survives invalid-title changes and continues the same DM", async () => {
    const f = await fixture(true);
    const sent = await f.run("self", ["dm", PEER, "workspace ping"]);
    expect(sent.code).toBe(0);
    const channel = channelOf(sent.stdout);
    const first = readRoutedMessages(channel, { env: f.env })[0]!;
    expect(first.from_identity).toMatch(/^workspace:[0-9a-f]{64}$/);
    expect(first.to_identity).toMatch(/^workspace:[0-9a-f]{64}$/);
    f.records.self.name = "A different desktop title";
    f.save("self");
    const next = await f.run("self", ["dm", PEER, "same conversation"]);
    expect(next.code).toBe(0);
    expect(channelOf(next.stdout)).toBe(channel);
    expect(readRoutedMessages(channel, { env: f.env })[1]?.from_identity).toBe(first.from_identity);
  });

  test("an unaddressable Claude sender fails closed instead of borrowing an inherited Codex identity", async () => {
    const f = await fixture();
    f.records.self.sessionId = "not-a-hex-session";
    f.save("self");
    const result = await f.run("self", ["whoami"], { CODEX_THREAD_ID: "aaaaaaaa-1111-4111-8111-111111111111" });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
  });

  test("short-ID fallback still suppresses a self wake", async () => {
    const f = await fixture();
    const result = await f.run("self", ["send", "chat", `self ping @${SELF}`]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("self");
    expect(f.messages.self).toEqual([]);
    expect(f.messages.peer).toEqual([]);
  });
});
