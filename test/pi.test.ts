import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPiIntegration,
  PI_EXTENSION_SOURCE,
} from "../src/pi-extension.ts";
import {
  listPiSessions,
  piSessionIdFromTarget,
  piTargetName,
  wakePiSession,
  type PiSessionRegistration,
} from "../src/pi-sessions.ts";
import { resolveDmTarget, resolveSelfName, selfIdentity } from "../src/roster.ts";
import { splitWakeMentions } from "../src/wake.ts";

const SESSION_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "a".repeat(64);
const openServers: Server[] = [];
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const path of tempRoots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(path);
  return path;
}

async function listen(server: Server, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  openServers.push(server);
}

function writeRegistration(home: string, socketPath: string): PiSessionRegistration {
  const dir = join(home, "pi-sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const registration: PiSessionRegistration = {
    v: 1,
    extension_version: 1,
    harness: "pi",
    session_id: SESSION_ID,
    target: piTargetName(SESSION_ID),
    name: "review auth",
    pid: process.pid,
    cwd: "/work/auth",
    socket_path: socketPath,
    token: TOKEN,
    registered_at: new Date().toISOString(),
  };
  writeFileSync(join(dir, `${SESSION_ID}.${process.pid}.json`), JSON.stringify(registration), { mode: 0o600 });
  return registration;
}

describe("Pi registration and wake transport", () => {
  test("discovers an owner-only live socket and acknowledges one queued wake", async () => {
    const home = tempRoot("ocs-pi-");
    const inbox = join(home, "pi-inbox");
    mkdirSync(inbox, { mode: 0o700 });
    const socketPath = join(inbox, "pi-test.sock");
    let received: Record<string, unknown> | null = null;
    const server = createServer((socket) => {
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        received = JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>;
        socket.end(`${JSON.stringify({ v: 1, ok: true, session_id: SESSION_ID, delivery: "queued" })}\n`);
      });
    });
    await listen(server, socketPath);
    chmodSync(socketPath, 0o600);
    const expected = writeRegistration(home, socketPath);
    const env = { OCS_HOME: home };

    expect(listPiSessions(env)).toEqual([expected]);
    expect(resolveDmTarget(`pi-${SESSION_ID.slice(0, 8)}`, env)).toMatchObject({
      kind: "pi",
      name: piTargetName(SESSION_ID),
      identity: `pi:${SESSION_ID}`,
      piSessionId: SESSION_ID,
    });
    const result = await wakePiSession(expected, "[ocs wake] hello");
    expect(result).toEqual({ ok: true, sessionId: SESSION_ID, delivery: "queued" });
    expect(received).toMatchObject({
      v: 1,
      type: "wake",
      session_id: SESSION_ID,
      token: TOKEN,
      note: "[ocs wake] hello",
    });
  });

  test("Pi address has a separate identity namespace and is routed out of Claude mentions", async () => {
    const target = piTargetName(SESSION_ID);
    expect(piSessionIdFromTarget(target)).toBe(SESSION_ID);
    expect(selfIdentity(target)).toBe(`pi:${SESSION_ID}`);
    expect(resolveSelfName({ OCS_PI_SESSION_ID: SESSION_ID })).toBe(target);
    expect(resolveDmTarget(target, { OCS_HOME: tempRoot("ocs-pi-empty-") }))
      .toMatchObject({ kind: "pi", name: target, identity: `pi:${SESSION_ID}`, piSessionId: SESSION_ID });
    expect(splitWakeMentions([target, SESSION_ID, "claude-worker"])).toEqual({
      piTargets: [target],
      codexThreads: [SESSION_ID],
      claudeNames: ["claude-worker"],
    });
  });
});

describe("installed Pi extension", () => {
  test("registers a TUI, injects a follow-up custom message, and cleans up on shutdown", async () => {
    // macOS tmpdir() expands to a long /var/folders/... path. Keep this
    // generated Unix socket below sockaddr_un's path limit.
    const root = mkdtempSync("/tmp/ocs-pi-extension-");
    tempRoots.push(root);
    const home = join(root, "ocs-home");
    const agentDir = join(root, "pi-agent");
    const paths = installPiIntegration("---\nname: ocs\n---\n", { PI_CODING_AGENT_DIR: agentDir }, root);
    expect(await Bun.file(paths.extensionPath).text()).toBe(PI_EXTENSION_SOURCE);

    const host = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures", "pi-extension-host.ts"), paths.extensionPath, SESSION_ID],
      {
        env: { ...process.env, OCS_HOME: home },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      let registration: PiSessionRegistration | undefined;
      const deadline = Date.now() + 3_000;
      while (registration === undefined && Date.now() < deadline) {
        [registration] = listPiSessions({ OCS_HOME: home });
        if (registration === undefined) await Bun.sleep(10);
      }
      expect(registration).toMatchObject({
        harness: "pi",
        session_id: SESSION_ID,
        target: piTargetName(SESSION_ID),
        name: "auth review",
        cwd: "/work/pi-auth",
      });
      expect(resolveSelfName({ OCS_PI_SESSION_ID: SESSION_ID })).toBe(piTargetName(SESSION_ID));
      const result = await wakePiSession(registration!, "[ocs wake] review the patch");
      expect(result.ok).toBe(true);
      const [stdout, stderr] = await Promise.all([
        new Response(host.stdout).text(),
        new Response(host.stderr).text(),
      ]);
      await host.exited;
      expect(stderr).toBe("");
      expect(host.exitCode).toBe(0);
      const output = JSON.parse(stdout) as {
        sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
        notices: string[];
      };
      expect(output.sent).toEqual([{
        message: {
          customType: "ocs",
          content: "[ocs wake] review the patch",
          display: true,
          details: { transport: "local-uds" },
        },
        options: { deliverAs: "followUp", triggerTurn: true },
      }]);
      expect(output.notices).toEqual([]);
      expect(listPiSessions({ OCS_HOME: home })).toEqual([]);
    } finally {
      if (host.exitCode === null) host.kill();
    }
  });
});
