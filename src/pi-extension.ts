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
    socket_path: current.socketPath,
    token: current.token,
    registered_at: current.registeredAt,
  };
}

function writeRegistration(current) {
  atomicWrite(current.registryPath, registration(current));
}

function removeRegistration(current) {
  try {
    const saved = JSON.parse(readFileSync(current.registryPath, "utf8"));
    if (saved.token === current.token && saved.pid === process.pid) unlinkSync(current.registryPath);
  } catch {}
}

async function stop() {
  const current = runtime;
  runtime = null;
  if (current === null) return;
  if (process.env.OCS_PI_SESSION_ID === current.sessionId) delete process.env.OCS_PI_SESSION_ID;
  removeRegistration(current);
  for (const socket of current.sockets) socket.destroy();
  await new Promise((resolve) => current.server.close(() => resolve()));
  try { unlinkSync(current.socketPath); } catch {}
}

function reply(socket, value) {
  socket.end(JSON.stringify(value) + "\\n");
}

async function start(pi, ctx) {
  await stop();
  if (ctx.mode !== "tui") return;
  const sessionId = String(ctx.sessionManager.getSessionId()).toLowerCase();
  if (!UUID_RE.test(sessionId)) throw new Error("Pi returned a non-UUID session id");
  const home = ocsHome();
  const sessionsDir = join(home, "pi-sessions");
  const inboxDir = join(home, "pi-inbox");
  mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(inboxDir, { recursive: true, mode: 0o700 });
  chmodSync(sessionsDir, 0o700);
  chmodSync(inboxDir, 0o700);
  const socketKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 24);
  const socketPath = join(inboxDir, "pi-" + socketKey + "-" + process.pid + ".sock");
  const registryPath = join(sessionsDir, sessionId + "." + process.pid + ".json");
  try {
    const stale = lstatSync(socketPath);
    if (stale.isSocket() && !stale.isSymbolicLink()) unlinkSync(socketPath);
    else throw new Error("refusing to replace non-socket Pi inbox path: " + socketPath);
  } catch (error) {
    if (error && error.code !== "ENOENT") throw error;
  }
  const current = {
    server: null,
    sockets: new Set(),
    sessionId,
    target: "pi-" + sessionId,
    name: safeName(pi.getSessionName()),
    cwd: ctx.cwd,
    socketPath,
    registryPath,
    token: randomBytes(32).toString("hex"),
    registeredAt: new Date().toISOString(),
  };
  const server = createServer((socket) => {
    current.sockets.add(socket);
    socket.once("close", () => current.sockets.delete(socket));
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
        pi.sendMessage(
          {
            customType: "ocs",
            content: frame.note,
            display: true,
            details: { transport: "local-uds" },
          },
          { deliverAs: "followUp", triggerTurn: true },
        );
        reply(socket, { v: 1, ok: true, session_id: current.sessionId, delivery: "queued" });
      } catch (error) {
        reply(socket, { v: 1, ok: false, error: String(error) });
      }
    });
  });
  current.server = server;
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(socketPath, () => {
      server.off("error", onError);
      resolve();
    });
  });
  server.on("error", (error) => ctx.ui.notify("ocs Pi inbox error: " + String(error), "warning"));
  chmodSync(socketPath, 0o600);
  runtime = current;
  try {
    writeRegistration(current);
    process.env.OCS_PI_SESSION_ID = sessionId;
    ctx.ui.setStatus("ocs", "ocs: " + current.target);
  } catch (error) {
    await stop();
    throw error;
  }
}

export default function ocsPiExtension(pi) {
  pi.on("session_start", async (_event, ctx) => {
    try { await start(pi, ctx); }
    catch (error) { ctx.ui.notify("ocs Pi integration failed: " + String(error), "error"); }
  });
  pi.on("session_info_changed", (_event, ctx) => {
    if (runtime === null) return;
    runtime.name = safeName(pi.getSessionName());
    try { writeRegistration(runtime); }
    catch (error) { ctx.ui.notify("ocs could not update Pi registration: " + String(error), "warning"); }
  });
  pi.on("session_shutdown", async (_event, ctx) => {
    ctx.ui.setStatus("ocs", undefined);
    await stop();
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
