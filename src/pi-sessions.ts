// Pi interactive-session discovery and direct wake transport.
//
// A small Pi extension (installed by `ocs skill install`) owns one Unix socket per
// live TUI session and publishes a 0600 registration under ~/.ocs/pi-sessions.
// The random per-runtime token prevents a stale/reused pid or forged socket from
// accepting a wake intended for another session. A successful response means the
// Pi runtime accepted the custom message; it does not claim the model read it.

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join, resolve, sep } from "node:path";
import { ocsHome } from "./store.ts";

export const OCS_PI_SESSION_ID_ENV = "OCS_PI_SESSION_ID";
export const PI_WAKE_TIMEOUT_MS = 2_000;
export const PI_WAKE_MAX_BYTES = 16 * 1024;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REGISTRATION_RE = /^([0-9a-f-]{36})\.(\d+)\.json$/i;
const TOKEN_RE = /^[0-9a-f]{64}$/;

export function isPiSessionId(value: string): boolean {
  return UUID_RE.test(value);
}

export function piTargetName(sessionId: string): string {
  if (!isPiSessionId(sessionId)) throw new Error(`invalid Pi session id: ${sessionId}`);
  return `pi-${sessionId.toLowerCase()}`;
}

export function piSessionIdFromTarget(target: string): string | null {
  if (!target.startsWith("pi-")) return null;
  const value = target.slice(3);
  return isPiSessionId(value) ? value.toLowerCase() : null;
}

export interface PiSessionRegistration {
  v: 1;
  extension_version: 1;
  harness: "pi";
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
  "extension_version",
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
): PiSessionRegistration | null {
  const match = REGISTRATION_RE.exec(filename);
  if (match === null) return null;
  const path = join(dir, filename);
  try {
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 16 * 1024 ||
      (stat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && stat.uid !== process.getuid())
    ) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== [...REGISTRATION_KEYS].sort().join(",")) return null;
    const sessionId = typeof record.session_id === "string" ? record.session_id.toLowerCase() : "";
    const pid = record.pid;
    const socketPath = record.socket_path;
    if (
      record.v !== 1 ||
      record.extension_version !== 1 ||
      record.harness !== "pi" ||
      !isPiSessionId(sessionId) ||
      match[1]!.toLowerCase() !== sessionId ||
      typeof pid !== "number" ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      Number(match[2]) !== pid ||
      record.target !== piTargetName(sessionId) ||
      !(record.name === null ||
        (typeof record.name === "string" &&
          record.name.length <= 96 &&
          !/[\r\n\t]/.test(record.name))) ||
      typeof record.cwd !== "string" ||
      !isAbsolute(record.cwd) ||
      typeof socketPath !== "string" ||
      !isAbsolute(socketPath) ||
      !within(join(ocsHome(env), "pi-inbox"), socketPath) ||
      typeof record.token !== "string" ||
      !TOKEN_RE.test(record.token) ||
      typeof record.registered_at !== "string" ||
      !Number.isFinite(Date.parse(record.registered_at))
    ) return null;
    if (!pidAlive(pid)) return null;
    const socketStat = lstatSync(socketPath);
    if (
      !socketStat.isSocket() ||
      socketStat.isSymbolicLink() ||
      (socketStat.mode & 0o077) !== 0 ||
      (typeof process.getuid === "function" && socketStat.uid !== process.getuid())
    ) return null;
    return { ...(record as unknown as PiSessionRegistration), session_id: sessionId };
  } catch {
    return null;
  }
}

export function piSessionsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(ocsHome(env), "pi-sessions");
}

export function listPiSessions(env: NodeJS.ProcessEnv = process.env): PiSessionRegistration[] {
  const dir = piSessionsRoot(env);
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const sessions = files
    .map((file) => readRegistration(dir, file, env))
    .filter((session): session is PiSessionRegistration => session !== null);
  sessions.sort((a, b) => Date.parse(b.registered_at) - Date.parse(a.registered_at) || a.pid - b.pid);
  return sessions;
}

export type PiWakeResult =
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
 * Deliver one already-formatted wake note to a registered Pi extension.
 * Once the frame has been written, a missing/malformed acknowledgement is an
 * unknown outcome and must not be retried automatically.
 */
export function wakePiSession(
  session: PiSessionRegistration,
  note: string,
): Promise<PiWakeResult> {
  const bytes = Buffer.byteLength(note, "utf8");
  if (bytes === 0 || bytes > PI_WAKE_MAX_BYTES) {
    return Promise.resolve({ ok: false, reason: "failed", detail: `wake note is ${bytes} bytes` });
  }
  return new Promise((finish) => {
    let settled = false;
    let written = false;
    let buffer = "";
    const socket = connect(session.socket_path);
    const done = (result: PiWakeResult) => {
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
        detail: `Pi inbox timed out after ${PI_WAKE_TIMEOUT_MS}ms`,
      });
    }, PI_WAKE_TIMEOUT_MS);
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
      if (Buffer.byteLength(buffer, "utf8") > PI_WAKE_MAX_BYTES) {
        done({ ok: false, reason: "unknown-outcome", detail: "oversized Pi inbox acknowledgement" });
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      let ack: WakeAck;
      try {
        ack = JSON.parse(buffer.slice(0, newline)) as WakeAck;
      } catch {
        done({ ok: false, reason: "unknown-outcome", detail: "malformed Pi inbox acknowledgement" });
        return;
      }
      if (
        ack.v === 1 &&
        ack.ok === true &&
        ack.session_id?.toLowerCase() === session.session_id &&
        ack.delivery === "queued"
      ) {
        done({ ok: true, sessionId: session.session_id, delivery: "queued" });
      } else if (ack.v === 1 && ack.ok === false) {
        done({ ok: false, reason: "failed", detail: ack.error ?? "Pi inbox rejected wake" });
      } else {
        done({ ok: false, reason: "unknown-outcome", detail: "invalid Pi inbox acknowledgement" });
      }
    });
    socket.on("error", (error) => {
      done({ ok: false, reason: written ? "unknown-outcome" : "unavailable", detail: String(error) });
    });
    socket.on("end", () => {
      if (!settled) {
        done({ ok: false, reason: written ? "unknown-outcome" : "unavailable", detail: "Pi inbox closed without acknowledgement" });
      }
    });
  });
}
