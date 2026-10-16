// Grok Build leader IPC (xai-org/grok-build, protocol v1). No session/load,
// permission changes, leader spawning, cancellation, or replay after a prompt write.
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { connect } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { psTable } from "./codex-queue.ts";
import { nativeWindowsPipeApi, WindowsPipeStream, type WindowsPipeApi, type WindowsPipeHandle } from "./codex-ipc-win.ts";

export const GROK_SESSION_ID_ENV = "GROK_SESSION_ID";
export const GROK_TIMEOUT_MS = 4000;
const MAX_FRAME = 4 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isGrokSessionId = (id: string): boolean => UUID.test(id);
export function grokTargetName(id: string): string { return `grok-${id.toLowerCase()}`; }
export function grokSessionIdFromTarget(target: string): string | null {
  const id = target.toLowerCase().startsWith("grok-") ? target.slice(5) : "";
  return UUID.test(id) ? id.toLowerCase() : null;
}
export function selfGrokSessionId(env: NodeJS.ProcessEnv = process.env): string | null {
  const id = env[GROK_SESSION_ID_ENV];
  if (typeof id !== "string" || !UUID.test(id)) return null;
  // Nested agents inherit each other's env. Grok stamps this id per tool call;
  // when host markers conflict, prefer the nearest actual host process.
  if (env.CODEX_THREAD_ID || env.CLAUDE_CODE_SESSION_ID || env.OCS_PI_SESSION_ID || env.HERMES_SESSION_ID) {
    const table = psTable(env);
    let pid = process.ppid;
    for (let depth = 0; depth < 64; depth++) {
      const p = table.get(pid); if (!p) return null;
      const name = basename(p.comm).replace(/\.exe$/i, "");
      if (/^grok(?:-\d[^/]*)?$/.test(name)) return id.toLowerCase();
      if (/^(codex|claude|pi|hermes)$/.test(name) || /\/(?:ChatGPT|Claude)\.app\//.test(p.comm)) return null;
      if (p.ppid === pid) break;
      pid = p.ppid;
    }
    return null;
  }
  return id.toLowerCase();
}
export function grokHome(env: NodeJS.ProcessEnv): string { return env.GROK_HOME || join(homedir(), ".grok"); }
export interface GrokLeader { path: string; pid: number; }
export interface GrokSession { id: string; cwd: string; title: string | null; status: string; }

function owned(path: string, kind: "file" | "directory" | "socket", platform: NodeJS.Platform): boolean {
  try {
    const s = lstatSync(path);
    return !s.isSymbolicLink() && (kind === "file" ? s.isFile() && s.size <= MAX_FRAME : kind === "directory" ? s.isDirectory() : s.isSocket()) &&
      (platform === "win32" || ((s.mode & 0o022) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid())));
  } catch { return false; }
}
export function findGrokLeaders(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): GrokLeader[] {
  const root = grokHome(env);
  let paths: string[] = [];
  if (owned(root, "directory", platform)) {
    try { paths = readdirSync(root).filter((n) => /^leader(?:-[A-Za-z0-9._-]+)?\.lock$/.test(n)).map((n) => join(root, n.replace(/\.lock$/, ".sock"))); }
    catch { /* a concurrently removed home is unavailable */ }
  }
  if (env.GROK_LEADER_SOCKET) paths.push(env.GROK_LEADER_SOCKET);
  const table = platform === "win32" || paths.length === 0 ? null : psTable(env);
  return [...new Set(paths)].flatMap((path) => {
    try {
    if (!owned(dirname(path), "directory", platform) || !owned(path.replace(/\.[^.\\/]+$/, ".lock"), "file", platform)) return [];
    if (platform !== "win32" && !owned(path, "socket", platform)) return [];
    const pid = Number(readFileSync(path.replace(/\.[^.\\/]+$/, ".lock"), "utf8").trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return [];
    try { process.kill(pid, 0); } catch { return []; }
    if (table !== null && !/^grok(?:-\d[^/]*)?$/.test(basename(table.get(pid)?.comm ?? ""))) return [];
    return [{ path, pid }];
    } catch { return []; } // lock/socket can disappear during a leader restart.
  });
}

/** Windows Path hashing is Rust-specific. Enumerate only Grok's local pipes,
 * then bind to the expected PID and user on the handle that carries all frames. */
export function openGrokPipe(leader: GrokLeader, api: WindowsPipeApi = nativeWindowsPipeApi(),
  names: readonly string[] = readdirSync("\\\\.\\pipe\\")): WindowsPipeHandle {
  const matches: WindowsPipeHandle[] = [];
  const self = api.currentUserSid()?.toUpperCase();
  if (!self) throw new Error("cannot identify Windows user");
  try {
    for (const name of names.filter((n) => /^grok-leader-[0-9a-f]{16}$/i.test(n))) {
      const handle = api.open(`\\\\.\\pipe\\${name}`);
      if (handle === null) continue;
      let valid = false;
      try {
        const f = handle.facts();
        valid = f.serverPid === leader.pid && f.serverUserSid?.toUpperCase() === self &&
          (f.pipeOwnerSid?.toUpperCase() === self || f.pipeOwnerSid === "S-1-5-32-544") &&
          /(?:^|[\\/])grok(?:-\d[^\\/]*)?\.exe$/i.test(f.serverImagePath ?? "");
      } finally { if (!valid) handle.close(); }
      if (valid) matches.push(handle);
    }
    if (matches.length !== 1) throw new Error("Grok leader pipe missing or ambiguous");
    return matches[0]!;
  } catch (error) { for (const h of matches) h.close(); throw error; }
}

export interface GrokConnection {
  call(method: string, params: Record<string, unknown>): Promise<unknown>;
  prompt(sessionId: string, text: string): Promise<"queued" | "started">;
  close(): void;
}
export class GrokError extends Error {
  constructor(message: string, readonly written = false, readonly rejected = false) { super(message); }
}

export async function connectGrok(leader: GrokLeader, platform: NodeJS.Platform = process.platform,
  timeout = GROK_TIMEOUT_MS): Promise<GrokConnection> {
  let transport: { write(b: Buffer): unknown; destroy(): void };
  let buffer = Buffer.alloc(0);
  let nextId = 0;
  let stopped = false;
  let readyResolve!: () => void;
  let readyReject!: (e: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  void ready.catch(() => {});
  const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout>; written: boolean; promptId?: string; sessionId?: string }>();
  const fail = (error: Error) => {
    if (stopped) return;
    stopped = true;
    readyReject(error);
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new GrokError(error.message, p.written)); }
    pending.clear();
    transport?.destroy();
  };
  const frame = (value: unknown) => {
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_FRAME) throw new GrokError("Grok IPC frame too large");
    const head = Buffer.alloc(4); head.writeUInt32BE(body.length);
    transport.write(Buffer.concat([head, body]));
  };
  const settle = (id: number, value: unknown, error?: Error) => {
    const p = pending.get(id); if (!p) return;
    clearTimeout(p.timer); pending.delete(id);
    if (error) p.reject(error); else p.resolve(value);
  };
  const incoming = (chunk: Buffer) => {
    if (stopped) return;
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length >= 4) {
        const size = buffer.readUInt32BE(0);
        if (size > MAX_FRAME) throw new Error("oversized Grok IPC frame");
        if (buffer.length < size + 4) break;
        const packet = JSON.parse(buffer.subarray(4, size + 4).toString("utf8"));
        buffer = buffer.subarray(size + 4);
        if (packet.type === "registered") {
          if (packet.leader_protocol_version !== 1) throw new Error("unsupported Grok leader protocol");
          if (packet.ready !== false) readyResolve();
        } else if (packet.type === "leader_ready") readyResolve();
        else if (packet.type === "error" || packet.type === "shutdown" || packet.type === "shutting_down") throw new Error("Grok leader refused or closed connection");
        else if (packet.type === "acp") {
          const rpc = JSON.parse(packet.payload);
          if (rpc.method === undefined && typeof rpc.id === "number" && pending.has(rpc.id)) {
            if (rpc.error) settle(rpc.id, null, new GrokError(`Grok RPC error ${rpc.error.code}: ${rpc.error.message}`, pending.get(rpc.id)!.written,
              [-32600, -32601, -32602].includes(rpc.error.code)));
            else {
              const p = pending.get(rpc.id)!;
              // A prompt response is a completed turn, not merely an IPC write.
              if (p.promptId) {
                if (rpc.result?._meta?.promptId === p.promptId && rpc.result.stopReason === "end_turn") settle(rpc.id, "started");
                else settle(rpc.id, null, new GrokError("prompt response did not confirm admission", true));
              } else settle(rpc.id, rpc.result);
            }
          } else if ((rpc.method === "x.ai/queue/changed" || rpc.method === "_x.ai/queue/changed") && rpc.params) {
            for (const [id, p] of pending) {
              if (!p.promptId || p.sessionId !== rpc.params.sessionId) continue;
              if (rpc.params.runningPromptId === p.promptId) settle(id, "started");
              else if (Array.isArray(rpc.params.entries) && rpc.params.entries.some((e: { id?: string }) => e.id === p.promptId)) settle(id, "queued");
            }
          }
          // Never answer permission, tool, or filesystem reverse requests.
        }
      }
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  };
  const start = () => {
    try { frame({ type: "register", client_type: "ocs", mode: "stdio", capabilities: {} }); }
    catch (error) { fail(error as Error); }
  };
  const readyTimer = setTimeout(() => fail(new Error("Grok leader registration timed out")), timeout);
  try {
    if (platform === "win32") { transport = new WindowsPipeStream(openGrokPipe(leader), incoming, fail); start(); }
    else {
      const socket = connect(leader.path);
      transport = socket;
      socket.on("data", incoming); socket.on("error", fail); socket.on("close", () => fail(new Error("Grok leader disconnected")));
      socket.once("connect", start);
    }
    await ready;
  } catch (error) { fail(error as Error); throw error; }
  finally { clearTimeout(readyTimer); }
  const request = (method: string, params: Record<string, unknown>, promptId?: string, sessionId?: string) => new Promise<unknown>((resolve, reject) => {
    if (stopped) { reject(new GrokError("Grok connection closed")); return; }
    const id = ++nextId;
    const p = { resolve, reject, written: false, promptId, sessionId,
      timer: setTimeout(() => { pending.delete(id); reject(new GrokError("Grok RPC/admission timed out", promptId !== undefined)); }, timeout) };
    pending.set(id, p);
    try {
      // Mark before writing: even a partially written prompt must not be replayed.
      p.written = promptId !== undefined;
      frame({ type: "acp", payload: JSON.stringify({ jsonrpc: "2.0", id, method, params }) });
    } catch (error) { settle(id, null, new GrokError(String(error), p.written)); }
  });
  return {
    call: (method, params) => request(method, params),
    prompt: async (sessionId, text) => {
      const promptId = randomUUID();
      return await request("session/prompt", { sessionId, prompt: [{ type: "text", text }],
        _meta: { promptId, clientIdentifier: "ocs", sendNow: false } }, promptId, sessionId) as "queued" | "started";
    },
    close: () => fail(new Error("Grok connection closed")),
  };
}

export interface GrokDeps { env?: NodeJS.ProcessEnv; leaders?: () => GrokLeader[]; connect?: (leader: GrokLeader) => Promise<GrokConnection>; }
function parseSessions(raw: unknown): GrokSession[] {
  const result = raw as { result?: { sessions?: unknown }; error?: unknown };
  if (result?.error || !Array.isArray(result?.result?.sessions)) throw new GrokError("Grok roster unavailable or unsupported");
  return result.result.sessions.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const r = row as Record<string, unknown>;
    if (typeof r.sessionId !== "string" || !UUID.test(r.sessionId) || r.resident !== true ||
      !["idle", "working", "needs_input"].includes(String(r.activity)) || typeof r.cwd !== "string" ||
      (r.origin as { kind?: string })?.kind !== "local") return [];
    return [{ id: r.sessionId.toLowerCase(), cwd: r.cwd, title: typeof r.title === "string" ? r.title.replace(/[\r\n\t]/g, " ").slice(0, 96) : null, status: String(r.activity) }];
  });
}
export async function listGrokSessions(deps: GrokDeps = {}): Promise<{ sessions: GrokSession[]; reason?: string }> {
  const sessions = new Map<string, GrokSession>();
  const duplicates = new Set<string>();
  const errors: string[] = [];
  for (const leader of (deps.leaders ?? (() => findGrokLeaders(deps.env)))()) {
    let conn: GrokConnection | undefined;
    try {
      conn = await (deps.connect ?? connectGrok)(leader);
      for (const s of parseSessions(await conn.call("_x.ai/sessions/list", {}))) {
        if (sessions.has(s.id)) duplicates.add(s.id); else sessions.set(s.id, s);
      }
    } catch (error) { errors.push((error as Error).message); }
    finally { conn?.close(); }
  }
  for (const id of duplicates) sessions.delete(id);
  if (duplicates.size) errors.push("same Grok session appears on multiple leaders; use only one active owner");
  if (sessions.size === 0 && !deps.leaders) {
    const env = deps.env ?? process.env;
    const path = join(grokHome(env), "active_sessions.json");
    try {
      if (owned(path, "file", process.platform)) {
        const active: unknown = JSON.parse(readFileSync(path, "utf8"));
        if (Array.isArray(active) && active.some((s) => {
          if (typeof s?.session_id !== "string" || !UUID.test(s.session_id) || !Number.isSafeInteger(s.pid) || s.pid <= 0) return false;
          try { process.kill(s.pid, 0); return true; } catch { return false; }
        })) errors.push("Grok TUI is open, but no leader-backed resident session was found. Start with `grok --leader` and submit the first prompt; existing standalone sessions cannot be injected into.");
      }
    } catch { /* diagnostic only */ }
  }
  return { sessions: [...sessions.values()], ...(errors.length ? { reason: errors.join("; ") } : {}) };
}
export type GrokWakeResult = { ok: true; delivery: "queued" | "started" } |
  { ok: false; reason: "unavailable" | "not-open" | "ambiguous" | "failed" | "unknown-outcome"; detail?: string };
export async function wakeGrokSession(id: string, note: string, deps: GrokDeps = {}): Promise<GrokWakeResult> {
  if (!UUID.test(id) || Buffer.byteLength(note) === 0 || Buffer.byteLength(note) > 5120) return { ok: false, reason: "failed", detail: "invalid Grok session or wake payload" };
  const connections: GrokConnection[] = [];
  const matches: GrokConnection[] = [];
  try {
    for (const leader of (deps.leaders ?? (() => findGrokLeaders(deps.env)))()) {
      const conn = await (deps.connect ?? connectGrok)(leader); connections.push(conn);
      if (parseSessions(await conn.call("_x.ai/sessions/list", {})).some((s) => s.id === id.toLowerCase())) matches.push(conn);
    }
    if (matches.length !== 1) return { ok: false, reason: matches.length > 1 ? "ambiguous" : "not-open" };
    return { ok: true, delivery: await matches[0]!.prompt(id.toLowerCase(), note) };
  } catch (error) {
    const e = error as GrokError;
    return { ok: false, reason: e.written ? e.rejected ? "failed" : "unknown-outcome" : "unavailable", detail: e.message };
  } finally { for (const conn of connections) conn.close(); }
}
