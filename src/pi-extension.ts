// Source and installer for the global Pi extension used by ocs.
// The extension intentionally has no Pi package import, so the same file works
// with the upstream @mariozechner build and compatible distributions.

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
export const PI_EXTENSION_VERSION = 1;

export const PI_EXTENSION_SOURCE = `// Installed by open-cross-session. Re-run: ocs skill install
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

const OCS_PI_EXTENSION_VERSION = 1;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FRAME_BYTES = 16 * 1024;
// While the TUI is alive, check this often that its registration and inbox still exist and
// recreate whichever is gone (#76). Two stat calls and one small read; the timer is unref'd.
// OCS_PI_HEAL_INTERVAL_MS only exists so tests need not wait 30s.
const HEAL_INTERVAL_MS = Number(process.env.OCS_PI_HEAL_INTERVAL_MS) > 0 ? Number(process.env.OCS_PI_HEAL_INTERVAL_MS) : 30 * 1000;
// Native Windows Node cannot listen on a filesystem .sock path (EACCES); local IPC there is a
// named pipe. The name carries 128 random bits so nobody can create it first, libuv opens the
// first instance exclusively, and the default pipe DACL keeps other accounts from adding
// instances. The per-runtime token still authenticates every frame.
const WINDOWS = process.platform === "win32";
const BS = "\\\\";
// Pi caches the extension factory per process, so this module can also see session events from
// a second, non-TUI AgentSession created in the same process. The runtime remembers the
// extension API object (one per runner) that started it: only that owner's events may stop or
// rewrite it, and a non-TUI session_start never touches it (#76).
let runtime = null;

function ocsHome() {
  const configured = process.env.OCS_HOME;
  return typeof configured === "string" && configured !== "" && isAbsolute(configured)
    ? configured
    : join(homedir(), ".ocs");
}

function safeName(value) {
  if (typeof value !== "string") return null;
  const oneLine = value.replace(/[\\r\\n\\t]+/g, " ").trim();
  return oneLine === "" ? null : oneLine.slice(0, 96);
}

function atomicWrite(path, value) {
  const tmp = path + "." + process.pid + "." + randomBytes(8).toString("hex") + ".tmp";
  writeFileSync(tmp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
  try {
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
}

function ensureDirs(current) {
  mkdirSync(current.sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(current.inboxDir, { recursive: true, mode: 0o700 });
  chmodSync(current.sessionsDir, 0o700);
  chmodSync(current.inboxDir, 0o700);
}

function registration(current) {
  return {
    v: 1,
    extension_version: OCS_PI_EXTENSION_VERSION,
    harness: "pi",
    session_id: current.sessionId,
    target: current.target,
    name: current.name,
    pid: process.pid,
    cwd: current.cwd,
    socket_path: current.inbox.path,
    token: current.token,
    registered_at: current.registeredAt,
  };
}

function writeRegistration(current) {
  atomicWrite(current.registryPath, registration(current));
}

function ownRegistration(current) {
  try {
    const saved = JSON.parse(readFileSync(current.registryPath, "utf8"));
    return saved.token === current.token && saved.pid === process.pid;
  } catch {
    return false;
  }
}

function removeRegistration(current) {
  // Only the file this runtime wrote: a newer runtime may have taken the same path.
  if (ownRegistration(current)) try { unlinkSync(current.registryPath); } catch {}
}

function setStatus(current, text) {
  try { current.ui.setStatus("ocs", text); } catch {}
}

function notify(current, text, level) {
  try { current.ui.notify(text, level); } catch {}
}

function reply(socket, value) {
  socket.end(JSON.stringify(value) + "\\n");
}

// Every inbox gets a fresh random path. Closing a Unix server unlinks its path by name, so a
// path shared with a newer listener (same session and pid) would take the newer socket with it.
function newInboxPath(current) {
  if (WINDOWS) {
    return BS + BS + "." + BS + "pipe" + BS + "ocs-pi-" + current.socketKey + "-" + process.pid + "-" +
      randomBytes(16).toString("hex");
  }
  return join(current.inboxDir, "pi-" + current.socketKey + "-" + process.pid + "-" + randomBytes(8).toString("hex") + ".sock");
}

async function openInbox(current) {
  const path = newInboxPath(current);
  const inbox = { server: null, sockets: new Set(), path, dev: 0, ino: 0 };
  const server = createServer((socket) => {
    inbox.sockets.add(socket);
    socket.once("close", () => inbox.sockets.delete(socket));
    socket.setTimeout(2000, () => socket.destroy());
    socket.setEncoding("utf8");
    let buffer = "";
    let handled = false;
    socket.on("data", (chunk) => {
      if (handled) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        handled = true;
        reply(socket, { v: 1, ok: false, error: "wake frame too large" });
        return;
      }
      const newline = buffer.indexOf("\\n");
      if (newline === -1) return;
      handled = true;
      let frame;
      try { frame = JSON.parse(buffer.slice(0, newline)); }
      catch {
        reply(socket, { v: 1, ok: false, error: "malformed wake frame" });
        return;
      }
      if (
        current.stopped ||
        frame.v !== 1 ||
        frame.type !== "wake" ||
        frame.session_id !== current.sessionId ||
        frame.token !== current.token ||
        typeof frame.note !== "string" ||
        frame.note === "" ||
        Buffer.byteLength(frame.note, "utf8") > MAX_FRAME_BYTES
      ) {
        reply(socket, { v: 1, ok: false, error: "invalid wake frame" });
        return;
      }
      try {
        current.owner.sendMessage(
          {
            customType: "ocs",
            content: frame.note,
            display: true,
            details: { transport: WINDOWS ? "local-pipe" : "local-uds" },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        reply(socket, { v: 1, ok: true, session_id: current.sessionId, delivery: "queued" });
      } catch (error) {
        reply(socket, { v: 1, ok: false, error: String(error) });
      }
    });
  });
  inbox.server = server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => notify(current, "ocs Pi inbox error: " + String(error), "warning"));
  if (!WINDOWS) {
    try {
      chmodSync(path, 0o600);
      const stat = lstatSync(path);
      inbox.dev = stat.dev;
      inbox.ino = stat.ino;
    } catch (error) {
      await closeInbox(inbox);
      throw error;
    }
  }
  return inbox;
}

function inboxIntact(inbox) {
  if (!inbox.server.listening) return false;
  if (WINDOWS) return true;
  try {
    const stat = lstatSync(inbox.path);
    return stat.isSocket() && !stat.isSymbolicLink() && stat.dev === inbox.dev && stat.ino === inbox.ino;
  } catch {
    return false;
  }
}

async function closeInbox(inbox) {
  if (inbox === null) return;
  for (const socket of inbox.sockets) socket.destroy();
  await new Promise((resolve) => inbox.server.close(() => resolve()));
  if (WINDOWS) return;
  // server.close() normally unlinks the path already; remove it only if it is still our socket.
  try {
    const stat = lstatSync(inbox.path);
    if (stat.isSocket() && stat.dev === inbox.dev && stat.ino === inbox.ino) unlinkSync(inbox.path);
  } catch {}
}

async function stop(current) {
  if (current === null) return;
  if (runtime === current) runtime = null;
  current.stopped = true;
  if (current.timer !== null) clearInterval(current.timer);
  if (process.env.OCS_PI_SESSION_ID === current.sessionId) delete process.env.OCS_PI_SESSION_ID;
  removeRegistration(current);
  await closeInbox(current.inbox);
}

// The TUI is alive but its registration or inbox is gone (deleted by hand, by an older copy of
// this extension, or by a cleanup we do not know about): recreate it so the session stays
// discoverable and wakeable, and keep the status line truthful when that fails (#76).
async function heal(current) {
  if (runtime !== current || current.healing) return;
  current.healing = true;
  try {
    let repaired = false;
    ensureDirs(current);
    if (!inboxIntact(current.inbox)) {
      const fresh = await openInbox(current);
      if (current.stopped) {
        await closeInbox(fresh);
        return;
      }
      const previous = current.inbox;
      current.inbox = fresh;
      repaired = true;
      closeInbox(previous).catch(() => {});
    }
    if (repaired || !ownRegistration(current)) {
      writeRegistration(current);
      repaired = true;
    }
    if (process.env.OCS_PI_SESSION_ID !== current.sessionId) process.env.OCS_PI_SESSION_ID = current.sessionId;
    if (repaired || current.healError !== null) setStatus(current, "ocs: " + current.target);
    current.healError = null;
  } catch (error) {
    const message = String(error);
    setStatus(current, "ocs: not registered");
    if (current.healError !== message) notify(current, "ocs could not restore Pi registration: " + message, "warning");
    current.healError = message;
  } finally {
    current.healing = false;
  }
}

async function start(pi, ctx) {
  // A print/rpc session, or an SDK session created inside this TUI process, must leave the
  // TUI's registration alone (#76).
  if (ctx.mode !== "tui") return;
  await stop(runtime);
  const sessionId = String(ctx.sessionManager.getSessionId()).toLowerCase();
  if (!UUID_RE.test(sessionId)) throw new Error("Pi returned a non-UUID session id");
  const home = ocsHome();
  const sessionsDir = join(home, "pi-sessions");
  const current = {
    owner: pi,
    ui: ctx.ui,
    inbox: null,
    timer: null,
    healing: false,
    healError: null,
    stopped: false,
    sessionId,
    target: "pi-" + sessionId,
    name: safeName(pi.getSessionName()),
    cwd: ctx.cwd,
    sessionsDir,
    inboxDir: join(home, "pi-inbox"),
    socketKey: createHash("sha256").update(sessionId).digest("hex").slice(0, 24),
    registryPath: join(sessionsDir, sessionId + "." + process.pid + ".json"),
    token: randomBytes(32).toString("hex"),
    registeredAt: new Date().toISOString(),
  };
  ensureDirs(current);
  current.inbox = await openInbox(current);
  runtime = current;
  try {
    writeRegistration(current);
    process.env.OCS_PI_SESSION_ID = sessionId;
    setStatus(current, "ocs: " + current.target);
  } catch (error) {
    await stop(current);
    throw error;
  }
  current.timer = setInterval(() => { heal(current); }, HEAL_INTERVAL_MS);
  if (typeof current.timer.unref === "function") current.timer.unref();
}

function owned(pi) {
  return runtime !== null && runtime.owner === pi ? runtime : null;
}

export default function ocsPiExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    try { await start(pi, ctx); }
    catch (error) {
      try { ctx.ui.setStatus("ocs", undefined); } catch {}
      ctx.ui.notify("ocs Pi integration failed: " + String(error), "error");
    }
  });
  pi.on("session_info_changed", (_event, ctx) => {
    const current = owned(pi);
    if (current === null) return;
    current.name = safeName(pi.getSessionName());
    try { writeRegistration(current); }
    catch (error) { ctx.ui.notify("ocs could not update Pi registration: " + String(error), "warning"); }
  });
  for (const event of ["agent_start", "agent_end"]) {
    pi.on(event, async () => {
      const current = owned(pi);
      if (current !== null) await heal(current);
    });
  }
  pi.on("session_shutdown", async (_event, ctx) => {
    // Only the session that started the inbox may take it down.
    const current = owned(pi);
    if (current === null) return;
    try { ctx.ui.setStatus("ocs", undefined); } catch {}
    await stop(current);
  });
}
`;

export function piAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configured = env[PI_CODING_AGENT_DIR_ENV];
  return typeof configured === "string" && configured !== "" && isAbsolute(configured)
    ? configured
    : join(home, ".pi", "agent");
}

export function piExtensionPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(piAgentDir(env, home), "extensions", "ocs.ts");
}

export function piSkillPath(env: NodeJS.ProcessEnv = process.env, home?: string): string {
  return join(piAgentDir(env, home), "skills", "ocs", "SKILL.md");
}

function atomicWriteText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // Preserve a canonical symlink created by `skills add` when it already has
    // the exact bundled content. Pi still needs the separate extension below.
    if (readFileSync(path, "utf8") === content) return;
  } catch {
    // missing or unreadable: write below and surface any real write error
  }
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, content, { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try {
      unlinkSync(tmp);
    } catch {
      // renamed or never created
    }
  }
}

export function installPiIntegration(
  skillSource: string,
  env: NodeJS.ProcessEnv = process.env,
  home?: string,
): { extensionPath: string; skillPath: string } {
  const extensionPath = piExtensionPath(env, home);
  const skillPath = piSkillPath(env, home);
  atomicWriteText(extensionPath, PI_EXTENSION_SOURCE);
  atomicWriteText(skillPath, skillSource);
  return { extensionPath, skillPath };
}

export function piExtensionCurrent(env: NodeJS.ProcessEnv = process.env, home?: string): boolean {
  try {
    return readFileSync(piExtensionPath(env, home), "utf8") === PI_EXTENSION_SOURCE;
  } catch {
    return false;
  }
}
