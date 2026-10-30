// OpenCode interactive-session discovery and direct wake transport.
//
// A local OpenCode plugin (installed by `ocs skill install`) owns one Unix socket per
// observed session and publishes a 0600 registration under ~/.ocs/opencode-sessions.
// Native Windows has no filesystem sockets for Node, so there the inbox is a named pipe
// `\\.\pipe\ocs-opencode-<sha256(session)[:24]>-<pid>-<128 random bits>`: unguessable, so it cannot
// be created first by someone else; mode bits mean nothing there (the profile ACL guards ~/.ocs).
// The random per-runtime token prevents a stale/reused pid or forged socket from
// accepting a wake intended for another session. A successful response means the
// OpenCode runtime admitted a native queue item; it does not claim the model read it.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ocsHome } from "./store.ts";

export const OCS_OPENCODE_SESSION_ID_ENV = "OCS_OPENCODE_SESSION_ID";
export const OPENCODE_WAKE_TIMEOUT_MS = 2_000;
export const OPENCODE_WAKE_MAX_BYTES = 16 * 1024;

const SESSION_ID_RE = /^ses_[A-Za-z0-9]{1,51}$/;
const REGISTRATION_RE = /^(ses_[A-Za-z0-9]{1,51})\.(\d+)\.json$/;
const TOKEN_RE = /^[0-9a-f]{64}$/;
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\ocs-opencode-([0-9a-f]{24})-(\d+)-[0-9a-f]{32}$/;

/** Where a registration may point its inbox: under ~/.ocs/opencode-inbox (Unix) or our own pipe name (Windows). */
export function opencodeInboxPathValid(
  socketPath: string,
  sessionId: string,
  pid: number,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (platform === "win32") {
    const match = WINDOWS_PIPE_RE.exec(socketPath);
    return match !== null &&
      match[1] === createHash("sha256").update(sessionId).digest("hex").slice(0, 24) &&
      Number(match[2]) === pid;
  }
  return isAbsolute(socketPath) && within(join(ocsHome(env), "opencode-inbox"), socketPath);
}

export function isOpenCodeSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

export function opencodeTargetName(sessionId: string): string {
  if (!isOpenCodeSessionId(sessionId)) throw new Error(`invalid OpenCode session id: ${sessionId}`);
  return `opencode-${sessionId}`;
}

export function opencodeSessionIdFromTarget(target: string): string | null {
  if (!target.startsWith("opencode-")) return null;
  const value = target.slice(9);
  return isOpenCodeSessionId(value) ? value : null;
}

export interface OpenCodeSessionRegistration {
  v: 1;
  plugin_version: 1;
  harness: "opencode";
  session_id: string;
  target: string;
  name: string | null;
  pid: number;
  cwd: string;
  socket_path: string;
  token: string;
  registered_at: string;
}

const REGISTRATION_KEYS = [
  "cwd",
  "plugin_version",
  "harness",
  "name",
  "pid",
  "registered_at",
  "session_id",
  "socket_path",
  "target",
  "token",
  "v",
] as const;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function within(root: string, path: string): boolean {
  const base = resolve(root);
  const candidate = resolve(path);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

function readRegistration(
  dir: string,
  filename: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): OpenCodeSessionRegistration | null {
  const match = REGISTRATION_RE.exec(filename);
  if (match === null) return null;
  const path = join(dir, filename);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 16 * 1024 ||
      (platform !== "win32" && (stat.mode & 0o077) !== 0) ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== [...REGISTRATION_KEYS].sort().join(",")) return null;
    const sessionId = typeof record.session_id === "string" ? record.session_id : "";
    const pid = record.pid;
    const socketPath = record.socket_path;
    if (
      record.v !== 1 ||
      record.plugin_version !== 1 ||
      record.harness !== "opencode" ||
      !isOpenCodeSessionId(sessionId) ||
      match[1]! !== sessionId ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      Number(match[2]) !== pid ||
      record.target !== opencodeTargetName(sessionId) ||
      !(record.name === null ||
        (typeof record.name === "string" &&
          record.name.length <= 96 &&
          !/[\r\n\t]/.test(record.name))) ||
      typeof record.cwd !== "string" ||
      !isAbsolute(record.cwd) ||
      typeof socketPath !== "string" ||
      !opencodeInboxPathValid(socketPath, sessionId, pid, env, platform) ||
      typeof record.token !== "string" ||
      !TOKEN_RE.test(record.token) ||
      typeof record.registered_at !== "string" ||
      !Number.isFinite(Date.parse(record.registered_at))
    ) return null;
    if (!pidAlive(pid)) return null;
    if (platform === "win32") return { ...(record as unknown as OpenCodeSessionRegistration), session_id: sessionId };
    const socketStat = lstatSync(socketPath);
    if (
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      (socketStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && socketStat.uid !== process.getuid())
    ) return null;
    return { ...(record as unknown as OpenCodeSessionRegistration), session_id: sessionId };
  } catch {
    return null;
  }
}

export function opencodeSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "opencode-sessions");
}

export function listOpenCodeSessions(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): OpenCodeSessionRegistration[] {
  const dir = opencodeSessionsRoot(env);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = files
    .map((file) => readRegistration(dir, file, env, platform))
    .filter((session): session is OpenCodeSessionRegistration => session !== null);
  sessions.sort((a, b) => Date.parse(b.registered_at) - Date.parse(a.registered_at) || a.pid - b.pid);
  return sessions;
}

export type OpenCodeWakeResult =
  | { ok: true; sessionId: string; delivery: "queued" }
  | { ok: false; reason: "unavailable" | "failed" | "unknown-outcome"; detail?: string };

interface WakeAck {
  v: 1;
  ok: boolean;
  session_id?: string;
  delivery?: string;
  error?: string;
}

/**
 * Deliver one already-formatted wake note to a registered OpenCode extension.
 * Once the frame has been written, a missing/malformed acknowledgement is an
 * unknown outcome and must not be retried automatically.
 */
export function wakeOpenCodeSession(
  session: OpenCodeSessionRegistration,
  note: string,
): Promise<OpenCodeWakeResult> {
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes === 0 || bytes > OPENCODE_WAKE_MAX_BYTES) {
    return Promise.resolve({ ok: false, reason: "failed", detail: `wake note is ${bytes} bytes` });
  }
  return new Promise((finish) => {
    let settled = false;
    let written = false;
    let buffer = "";
    const socket = connect(session.socket_path);
    const done = (result: OpenCodeWakeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      finish(result);
    };
    const timer = setTimeout(() => {
      done({
        ok: false,
        reason: written ? "unknown-outcome" : "unavailable",
        detail: `OpenCode inbox timed out after ${OPENCODE_WAKE_TIMEOUT_MS}ms`,
      });
    }, OPENCODE_WAKE_TIMEOUT_MS);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      const frame = JSON.stringify({
        v: 1,
        type: "wake",
        session_id: session.session_id,
        token: session.token,
        note,
      });
      try {
        // Once write() accepts the frame, an error/no-ack is an unknown outcome:
        // some or all bytes may already have reached the peer.
        written = true;
        socket.write(`${frame}\n`, (error) => {
          if (error !== undefined && error !== null) {
            done({ ok: false, reason: "unknown-outcome", detail: String(error) });
          }
        });
      } catch (error) {
        written = false;
        done({ ok: false, reason: "failed", detail: String(error) });
      }
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer, "utf8") > OPENCODE_WAKE_MAX_BYTES) {
        done({ ok: false, reason: "unknown-outcome", detail: "oversized OpenCode inbox acknowledgement" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let ack: WakeAck;
      try {
        const value: unknown = JSON.parse(buffer.slice(0, newline));
        if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid acknowledgement");
        ack = value as WakeAck;
      } catch {
        done({ ok: false, reason: "unknown-outcome", detail: "malformed OpenCode inbox acknowledgement" });
        return;
      }
      if (
        ack.v === 1 &&
        ack.ok === true &&
        ack.session_id === session.session_id &&
        ack.delivery === "queued"
      ) {
        done({ ok: true, sessionId: session.session_id, delivery: "queued" });
      } else if (ack.v === 1 && ack.ok === false) {
        done({ ok: false, reason: "failed", detail: ack.error ?? "OpenCode inbox rejected wake" });
      } else {
        done({ ok: false, reason: "unknown-outcome", detail: "invalid OpenCode inbox acknowledgement" });
      }
    });
    socket.on("error", (error) => {
      done({ ok: false, reason: written ? "unknown-outcome" : "unavailable", detail: String(error) });
    });
    socket.on("end", () => {
      if (!settled) {
        done({ ok: false, reason: written ? "unknown-outcome" : "unavailable", detail: "OpenCode inbox closed without acknowledgement" });
      }
    });
  });
}

export function openCodeShortId(id: string): string {
  return `oc-${createHash("sha256").update(id).digest("hex").slice(0, 8)}`;
}
export function selfOpenCodeSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env.OCS_OPENCODE_SESSION_ID ?? env.OPENCODE_SESSION_ID;
  return typeof id === "string" && isOpenCodeSessionId(id) ? id : null;
}
