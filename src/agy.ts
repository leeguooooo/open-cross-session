// Optional Antigravity CLI receiver. Same-user rendezvous files and a per-runtime token
// protect the carrier; channel/seq remain the authoritative message reference.
import { lstatSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";
import { CHANNEL_RE, ocsHome } from "./store.ts";
import { nativeWindowsPipeApi, WindowsPipeStream, type WindowsPipeApi, type WindowsPipeHandle } from "./codex-ipc-win.ts";

export const AGY_TARGET = "agy";
export const AGY_WAKE_TIMEOUT_MS = 4000;
export const AGY_TOKEN_RE = /^[0-9a-f]{64}$/;
export const AGY_NOTE_MAX_BYTES = 5120;
export const AGY_FRAME_MAX_BYTES = 16 * 1024;
export interface AgyWorker {
  v: 1;
  target: "agy";
  pid: number;
  cwd: string;
  status: "idle" | "working";
  socketPath: string;
  token: string;
  heartbeat: number;
}

export function agyDir(env: NodeJS.ProcessEnv = process.env): string { return join(ocsHome(env), "agy"); }

export function agySocketPath(token: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string {
  if (!AGY_TOKEN_RE.test(token)) throw new Error("invalid agy runtime token");
  return platform === "win32" ? `\\\\.\\pipe\\ocs-agy-${token.slice(0, 16)}` : join(agyDir(env), `worker-${token.slice(0, 16)}.sock`);
}

export function findAgyWorker(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): AgyWorker | null {
  try {
    const dir = agyDir(env);
    const path = join(dir, "worker.json");
    for (const [file, directory] of [[dir, true], [path, false]] as const) {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || (platform !== "win32" && (stat.mode & 0o077) !== 0) ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.size > 4096) return null;
    }
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (r.v !== 1 || r.target !== AGY_TARGET || typeof r.pid !== "number" || !Number.isInteger(r.pid) || r.pid <= 0 ||
        typeof r.cwd !== "string" || !isAbsolute(r.cwd) || (r.status !== "idle" && r.status !== "working") ||
        typeof r.token !== "string" || !AGY_TOKEN_RE.test(r.token) || typeof r.socketPath !== "string" ||
        r.socketPath !== agySocketPath(r.token, env, platform) ||
        typeof r.heartbeat !== "number" || Math.abs(Date.now() - r.heartbeat) > 15000) return null;
    process.kill(r.pid, 0);
    if (platform !== "win32") {
      const stat = lstatSync(r.socketPath);
      if (!stat.isSocket() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 ||
          (typeof process.getuid === "function" && stat.uid !== process.getuid())) return null;
    }
    return r as unknown as AgyWorker;
  } catch { return null; }
}

export interface AgyJobInput { channel: string; seq: number; note: string; replyTarget?: string; }
export type AgyWakeResult =
  | { ok: true; job: string }
  | { ok: false; reason: "unavailable" | "rejected" | "unknown-outcome"; detail?: string };

export function validAgyJob(input: unknown): input is AgyJobInput {
  if (typeof input !== "object" || input === null) return false;
  const r = input as Record<string, unknown>;
  return typeof r.channel === "string" && CHANNEL_RE.test(r.channel) &&
    typeof r.seq === "number" && Number.isSafeInteger(r.seq) && r.seq > 0 &&
    typeof r.note === "string" && Buffer.byteLength(r.note, "utf8") <= AGY_NOTE_MAX_BYTES &&
    (r.replyTarget === undefined || (typeof r.replyTarget === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}@[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(r.replyTarget)));
}

export async function wakeAgy(input: AgyJobInput, env: NodeJS.ProcessEnv = process.env): Promise<AgyWakeResult> {
  if (!validAgyJob(input)) return { ok: false, reason: "rejected", detail: "invalid wake" };
  return requestAgy(input, env);
}

/** Stop is authenticated and graceful on Windows too; SIGTERM there is a hard kill. */
export async function stopAgyWorker(env: NodeJS.ProcessEnv = process.env): Promise<AgyWakeResult> {
  return requestAgy({ op: "stop" }, env);
}

export function openAgyPipe(worker: AgyWorker, api: WindowsPipeApi = nativeWindowsPipeApi()): WindowsPipeHandle {
  if (worker.socketPath !== agySocketPath(worker.token, {}, "win32")) throw new Error("not a local agy pipe");
  const handle = api.open(worker.socketPath);
  if (handle === null) throw new Error("agy pipe unavailable");
  try {
    const self = api.currentUserSid();
    const facts = handle.facts();
    // Elevated Windows processes may create objects owned by Administrators.
    // Still require the registered pid and the current user on this very handle.
    if (self === null || facts.serverUserSid?.toUpperCase() !== self.toUpperCase() ||
        facts.serverPid !== worker.pid || (facts.pipeOwnerSid?.toUpperCase() !== self.toUpperCase() &&
        facts.pipeOwnerSid !== "S-1-5-32-544")) throw new Error("agy pipe server identity mismatch");
    return handle;
  } catch (error) { handle.close(); throw error; }
}

async function requestAgy(input: AgyJobInput | { op: "stop" }, env: NodeJS.ProcessEnv): Promise<AgyWakeResult> {
  const worker = findAgyWorker(env);
  if (worker === null) return { ok: false, reason: "unavailable" };
  const frame = JSON.stringify({ ...input, token: worker.token }) + "\n";
  if (Buffer.byteLength(frame) > AGY_FRAME_MAX_BYTES) return { ok: false, reason: "rejected", detail: "encoded wake too large" };
  return new Promise((resolve) => {
    let written = false;
    let done = false;
    let data = "";
    let socket: { destroy(): void; write(data: string | Buffer): unknown } | null = null;
    const finish = (result: AgyWakeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve(result);
    };
    const fail = (detail: string) => finish({ ok: false, reason: written ? "unknown-outcome" : "unavailable", detail });
    const timer = setTimeout(() => fail("worker acknowledgement timed out"), AGY_WAKE_TIMEOUT_MS);
    const send = () => {
      written = true;
      try { socket!.write(Buffer.from(frame)); } catch (error) { fail(String(error)); }
    };
    const receive = (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > AGY_FRAME_MAX_BYTES) { fail("oversized worker reply"); return; }
      if (!data.includes("\n")) return;
      try {
        const reply = JSON.parse(data.slice(0, data.indexOf("\n"))) as Record<string, unknown>;
        if (reply.ok === true && typeof reply.job === "string") finish({ ok: true, job: reply.job });
        else if (reply.ok === false) finish({ ok: false, reason: "rejected", detail: String(reply.error ?? "rejected") });
        else fail("malformed worker reply");
      } catch { fail("malformed worker reply"); }
    };
    if (process.platform === "win32") {
      try {
        const handle = openAgyPipe(worker);
        socket = new WindowsPipeStream(handle, (chunk) => receive(chunk.toString("utf8")), (error) => fail(error.message));
        send();
      } catch (error) { fail(String(error)); }
    } else {
      const unix = connect(worker.socketPath);
      socket = unix;
      unix.setEncoding("utf8");
      unix.on("connect", send);
      unix.on("data", receive);
      unix.on("error", (error) => fail(error.message));
      unix.on("close", () => { if (!done) fail("worker closed without acknowledgement"); });
    }
  });
}
