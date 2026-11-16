import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  installPiIntegration,
  PI_EXTENSION_SOURCE,
} from "../src/pi-extension.ts";
import { createHash } from "node:crypto";
import {
  listPiSessions,
  piInboxPathValid,
  piSessionIdFromTarget,
  piTargetName,
  unregisteredPiPids,
  wakePiSession,
  type PiSessionRegistration,
} from "../src/pi-sessions.ts";
import { nativePiSessionId, nearestPiOrHermesHost, resolveDmTarget, resolveSelfName, selfIdentity, selfNameOwner } from "../src/roster.ts";
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

  test("Windows registrations must point at this session's own unguessable local pipe", () => {
    const key = createHash("sha256").update(SESSION_ID).digest("hex").slice(0, 24);
    const pipe = `\\\\.\\pipe\\ocs-pi-${key}-4242-${"ab".repeat(16)}`;
    expect(pipe.startsWith("\\\\.\\pipe\\")).toBe(true);
    expect(piInboxPathValid(pipe, SESSION_ID, 4242, {}, "win32")).toBe(true);
    expect(piInboxPathValid(pipe, SESSION_ID, 4243, {}, "win32")).toBe(false);
    expect(piInboxPathValid(pipe, "22222222-2222-4333-8444-555555555555", 4242, {}, "win32")).toBe(false);
    expect(piInboxPathValid(pipe.replace("\\\\.", "\\\\fileserver"), SESSION_ID, 4242, {}, "win32")).toBe(false);
    expect(piInboxPathValid(`\\\\.\\pipe\\ocs-pi-${key}-4242`, SESSION_ID, 4242, {}, "win32")).toBe(false);
    expect(piInboxPathValid("C:\\Users\\x\\.ocs\\pi-inbox\\pi.sock", SESSION_ID, 4242, {}, "win32")).toBe(false);
    // and the Unix rule is unchanged: a pipe name is not an inbox path there
    expect(piInboxPathValid(pipe, SESSION_ID, 4242, { OCS_HOME: "/h" }, "darwin")).toBe(false);
    expect(piInboxPathValid("/h/pi-inbox/pi-x.sock", SESSION_ID, 4242, { OCS_HOME: "/h" }, "darwin")).toBe(true);
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
      hermesTargets: [],
    });
  });
});

describe("Pi native PI_SESSION_ID fallback (#64)", () => {
  const OTHER_ID = "99999999-8888-4777-8666-555555555555";
  const CODEX_ID = "019a0000-0000-7000-8000-000000000001";
  // An empty Claude sessions dir: the test runner itself may live inside a Claude session.
  const base = () => ({
    OCS_HOME: tempRoot("ocs-pi-native-"),
    OCS_CLAUDE_NATIVE_SESSIONS_DIR: tempRoot("ocs-pi-native-claude-"),
  });

  test("a Pi our extension is not running in still has an identity", () => {
    const env = { ...base(), PI_SESSION_ID: SESSION_ID.toUpperCase() };
    expect(resolveSelfName(env)).toBe(piTargetName(SESSION_ID));
    expect(selfNameOwner(env)).toEqual({ kind: "pi", id: SESSION_ID });
  });

  test("the extension's id wins over Pi's own, and garbage is ignored", () => {
    expect(resolveSelfName({ ...base(), OCS_PI_SESSION_ID: SESSION_ID, PI_SESSION_ID: OTHER_ID }))
      .toBe(piTargetName(SESSION_ID));
    expect(resolveSelfName({ ...base(), PI_SESSION_ID: "not-a-uuid" })).toBeNull();
  });

  test("Pi and Hermes nested in each other: the nearer host ancestor wins", () => {
    const HERMES = { HERMES_SESSION_ID: "20261104_120000_abcdef", HERMES_SESSION_SOURCE: "tui" };
    const table = (rows: Array<[number, number, string]>) => {
      const map = new Map(rows.map(([pid, ppid, comm]) => [pid, { ppid, comm }]));
      return (pid: number) => map.get(pid);
    };
    // ocs(100) <- sh(90) <- hermes(80) <- sh(70) <- pi(60): Hermes launched from Pi's bash.
    const hermesInPi = table([[90, 80, "/bin/sh"], [80, 70, "/usr/local/bin/hermes"], [70, 60, "zsh"], [60, 1, "pi"]]);
    // ocs(100) <- sh(90) <- pi(80) <- hermes(70): Pi launched from Hermes' terminal.
    const piInHermes = table([[90, 80, "/bin/sh"], [80, 70, "pi"], [70, 1, "hermes"]]);
    expect(nearestPiOrHermesHost(hermesInPi, 90)).toBe("hermes");
    expect(nearestPiOrHermesHost(piInHermes, 90)).toBe("pi");
    expect(nearestPiOrHermesHost(table([[90, 1, "node"]]), 90)).toBeNull();
    const env = { ...base(), ...HERMES, PI_SESSION_ID: SESSION_ID };
    expect(nativePiSessionId(env, (pid) => hermesInPi(pid === process.ppid ? 90 : pid))).toBeNull();
    expect(nativePiSessionId(env, (pid) => piInHermes(pid === process.ppid ? 90 : pid))).toBe(SESSION_ID);
    // Without Hermes there is nothing to disambiguate.
    expect(nativePiSessionId({ PI_SESSION_ID: SESSION_ID }, () => undefined)).toBe(SESSION_ID);
  });

  test("agents launched from Pi's bash tool keep their own identity", () => {
    expect(resolveSelfName({ ...base(), PI_SESSION_ID: SESSION_ID, CODEX_THREAD_ID: CODEX_ID })).toBe(CODEX_ID);
    expect(selfNameOwner({ ...base(), PI_SESSION_ID: SESSION_ID, CODEX_THREAD_ID: CODEX_ID }))
      .toEqual({ kind: "codex", id: CODEX_ID });
    // Claude found through the process ancestry (our parent stands in for the Claude process).
    const claudeDir = tempRoot("ocs-pi-native-claude-");
    writeFileSync(
      join(claudeDir, `${process.ppid}.json`),
      JSON.stringify({
        pid: process.ppid,
        sessionId: "claude-in-pi-session",
        name: "claude-in-pi",
        messagingSocketPath: join(claudeDir, "claude.sock"),
      }),
      { mode: 0o600 },
    );
    const env = { ...base(), OCS_CLAUDE_NATIVE_SESSIONS_DIR: claudeDir, PI_SESSION_ID: SESSION_ID };
    expect(resolveSelfName(env)).toBe("claude-in-pi");
    expect(selfNameOwner(env)?.kind).toBe("claude");
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

describe("installed Pi extension on Windows", () => {
  test("listens on a named pipe instead of a .sock file and is discoverable and wakeable", async () => {
    const root = mkdtempSync("/tmp/ocs-pi-win-");
    tempRoots.push(root);
    const home = join(root, "ocs-home");
    const paths = installPiIntegration("---\nname: ocs\n---\n", { PI_CODING_AGENT_DIR: join(root, "pi-agent") }, root);
    const host = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures", "pi-extension-host.ts"), paths.extensionPath, SESSION_ID, "win32"],
      { cwd: root, env: { ...process.env, OCS_HOME: home }, stdout: "pipe", stderr: "pipe" },
    );
    const previousCwd = process.cwd();
    try {
      let registration: PiSessionRegistration | undefined;
      const deadline = Date.now() + 3_000;
      while (registration === undefined && Date.now() < deadline) {
        [registration] = listPiSessions({ OCS_HOME: home }, "win32");
        if (registration === undefined) await Bun.sleep(10);
      }
      expect(registration?.socket_path).toMatch(/^\\\\\.\\pipe\\ocs-pi-[0-9a-f]{24}-\d+-[0-9a-f]{32}$/);
      expect(registration?.pid).toBe(host.pid);
      // nothing was bound under pi-inbox: that is the path Windows refused with EACCES
      expect(readdirSync(join(home, "pi-inbox"))).toEqual([]);
      // the Unix reader keeps refusing an inbox outside ~/.ocs/pi-inbox
      expect(listPiSessions({ OCS_HOME: home }, "darwin")).toEqual([]);
      process.chdir(root); // on this runner the "pipe" is a relative socket under the host's cwd
      const result = await wakePiSession(registration!, "[ocs wake] from windows");
      process.chdir(previousCwd);
      expect(result).toEqual({ ok: true, sessionId: SESSION_ID, delivery: "queued" });
      const [stdout, stderr] = await Promise.all([new Response(host.stdout).text(), new Response(host.stderr).text()]);
      await host.exited;
      expect(stderr).toBe("");
      const output = JSON.parse(stdout) as { sent: Array<{ message: Record<string, unknown> }>; notices: string[] };
      expect(output.notices).toEqual([]);
      expect(output.sent.map((entry) => entry.message.details)).toEqual([{ transport: "local-pipe" }]);
      expect(listPiSessions({ OCS_HOME: home }, "win32")).toEqual([]);
    } finally {
      process.chdir(previousCwd);
      if (host.exitCode === null) host.kill();
    }
  });
});

describe("doctor hint for Pi processes without a registration (#76)", () => {
  test("lists terminal Pi processes whose pid has no live registration", () => {
    const registered = { pid: 200 } as PiSessionRegistration;
    const table = new Map([
      [100, { tty: "ttys001", comm: "pi" }], // lost its registration
      [200, { tty: "ttys002", comm: "pi" }], // registered
      [300, { tty: "??", comm: "pi" }], // no terminal: not a TUI
      [400, { tty: "ttys003", comm: "pi-rpc" }], // rpc never registers
      [500, { tty: "ttys004", comm: "/usr/local/bin/pi" }],
      [600, { tty: "ttys005", comm: "pip" }],
    ]);
    expect(unregisteredPiPids(table, [registered])).toEqual([100, 500]);
    expect(unregisteredPiPids(table, [registered, { pid: 100 } as PiSessionRegistration, { pid: 500 } as PiSessionRegistration])).toEqual([]);
  });
});

describe("installed Pi extension keeps a live TUI registered (#76)", () => {
  interface LifecycleOutput {
    sent: Array<Record<string, unknown>>;
    notices: string[];
    statuses: Array<string | null>;
    envAfterForeign: string | null;
    envAtWake: string | null;
    registeredBeforeOldShutdown: string[];
  }

  function spawnLifecycle(scenario: string, extra: Record<string, string> = {}) {
    // Short /tmp root: sockaddr_un paths are limited to ~104 bytes on macOS.
    const root = mkdtempSync("/tmp/ocs-pi-76-");
    tempRoots.push(root);
    const home = join(root, "h");
    const paths = installPiIntegration("---\nname: ocs\n---\n", { PI_CODING_AGENT_DIR: join(root, "a") }, root);
    const host = Bun.spawn(
      [process.execPath, join(import.meta.dir, "fixtures", "pi-extension-lifecycle.ts"), paths.extensionPath, SESSION_ID, scenario],
      { env: { ...process.env, OCS_HOME: home, ...extra }, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    return { home, host };
  }

  async function waitFor<T>(probe: () => T | undefined, ms = 3_000): Promise<T | undefined> {
    const deadline = Date.now() + ms;
    for (;;) {
      const value = probe();
      if (value !== undefined || Date.now() > deadline) return value;
      await Bun.sleep(10);
    }
  }

  /** Read the host's stderr until it prints `token` (the fixture's progress markers). */
  async function waitForMarker(host: ReturnType<typeof Bun.spawn>, token: string): Promise<void> {
    const reader = (host.stderr as ReadableStream<Uint8Array>).getReader();
    let seen = "";
    try {
      while (!seen.includes(token)) {
        const { value, done } = await reader.read();
        if (done) throw new Error(`host exited before ${token}: ${seen}`);
        seen += new TextDecoder().decode(value);
      }
    } finally {
      reader.releaseLock();
    }
  }

  async function finish(host: ReturnType<typeof Bun.spawn>): Promise<LifecycleOutput> {
    const stdout = await new Response(host.stdout as ReadableStream).text();
    await host.exited;
    return JSON.parse(stdout) as LifecycleOutput;
  }

  test("a non-TUI session in the same process neither unregisters nor un-identifies the TUI", async () => {
    const { home, host } = spawnLifecycle("foreign");
    try {
      // the sibling session has started and shut down once the host says ready
      await waitForMarker(host, "ready");
      const still = listPiSessions({ OCS_HOME: home });
      expect(still.map((s) => s.session_id)).toEqual([SESSION_ID]);
      expect(await wakePiSession(still[0]!, "[ocs wake] still there?")).toEqual({ ok: true, sessionId: SESSION_ID, delivery: "queued" });
      const output = await finish(host);
      expect(output.envAfterForeign).toBe(SESSION_ID);
      expect(output.statuses).toEqual([`ocs: ${piTargetName(SESSION_ID)}`, null]);
      expect(listPiSessions({ OCS_HOME: home })).toEqual([]);
    } finally {
      if (host.exitCode === null) host.kill();
    }
  });

  test("an old extension instance shutting down late does not take the newer inbox with it", async () => {
    const { home, host } = spawnLifecycle("stale");
    try {
      // ready = the newer instance registered and the old one has shut down
      await waitForMarker(host, "ready");
      const sessions = listPiSessions({ OCS_HOME: home });
      expect(sessions.map((s) => s.session_id)).toEqual([SESSION_ID]);
      const live = sessions[0];
      expect(readdirSync(join(home, "pi-inbox"))).toEqual([basename(live!.socket_path)]);
      expect(await wakePiSession(live!, "[ocs wake] after reload")).toEqual({ ok: true, sessionId: SESSION_ID, delivery: "queued" });
      const output = await finish(host);
      // while both instances were live, the newer registration stayed in place
      expect(output.registeredBeforeOldShutdown).toEqual([live!.socket_path]);
      expect(output.sent).toHaveLength(1);
      expect(listPiSessions({ OCS_HOME: home })).toEqual([]);
      expect(readdirSync(join(home, "pi-inbox"))).toEqual([]);
    } finally {
      if (host.exitCode === null) host.kill();
    }
  });

  test("an idle TUI recreates a deleted registration, inbox and identity", async () => {
    const { home, host } = spawnLifecycle("heal", { OCS_PI_HEAL_INTERVAL_MS: "50" });
    try {
      await waitForMarker(host, "ready");
      const original = listPiSessions({ OCS_HOME: home })[0];
      expect(original?.session_id).toBe(SESSION_ID);
      const stdin = host.stdin as import("bun").FileSink;
      stdin.write("drop\n");
      await stdin.flush();
      await waitForMarker(host, "dropped");
      // what #76 observed: the Pi process is alive, its registration and socket are gone
      rmSync(join(home, "pi-sessions", `${SESSION_ID}.${host.pid}.json`));
      rmSync(original!.socket_path);
      expect(listPiSessions({ OCS_HOME: home })).toEqual([]);
      const healed = await waitFor(() => listPiSessions({ OCS_HOME: home })[0]);
      expect(healed?.session_id).toBe(SESSION_ID);
      expect(healed?.socket_path).not.toBe(original!.socket_path);
      expect(await wakePiSession(healed!, "[ocs wake] healed")).toEqual({ ok: true, sessionId: SESSION_ID, delivery: "queued" });
      const output = await finish(host);
      expect(output.envAtWake).toBe(SESSION_ID);
      expect(output.notices).toEqual([]);
      expect(listPiSessions({ OCS_HOME: home })).toEqual([]);
      expect(readdirSync(join(home, "pi-inbox"))).toEqual([]);
    } finally {
      if (host.exitCode === null) host.kill();
    }
  });
});
