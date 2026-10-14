// Optional headless agy carrier; uses Bun's bundled SQLite, no Python/systemd dependency.
import { spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { AGY_FRAME_MAX_BYTES, AGY_TOKEN_RE, agyDir, agySocketPath, findAgyWorker, validAgyJob, type AgyWorker } from "./agy.ts";
import { AgyQueue, ensureAgyDirectory, type AgyJob } from "./agy-queue.ts";
import { spawnDetached } from "./detach.ts";
import { agyMessages } from "./i18n-agy.ts";
import { detectLang } from "./i18n.ts";
import { selfCommand } from "./idle.ts";
import { listNativeSessions } from "./claude-inject.ts";
import { readOcsName } from "./names.ts";

export const AGY_WORKER_COMMAND = "_agy-worker";
export interface AgyOptions { cwd: string; model?: string; timeout: number; }
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function killChildGroup(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    child.kill("SIGKILL");
    return;
  }
  try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); }
  catch { child.kill("SIGKILL"); }
}

export function agyEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...env };
  // Prevent a receiver spawned inside another agent from replying with that agent's identity.
  for (const key of ["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_MESSAGING_SOCKET",
    "CLAUDECODE", "OCS_PI_SESSION_ID", "HERMES_SESSION_ID", "HERMES_SESSION_SOURCE", "HERMES_UI_SESSION_ID"]) delete clean[key];
  clean.OCS_NAME = "agy";
  return clean;
}

export function parseAgyOptions(flags: Map<string, string | true>): AgyOptions {
  const timeout = Number(flags.get("timeout") ?? 3600);
  const model = flags.get("model");
  const cwd = resolve(typeof flags.get("cwd") === "string" ? flags.get("cwd") as string : process.cwd());
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 21600) throw new Error("agy timeout must be 1..21600 seconds");
  if (!statSync(cwd).isDirectory()) throw new Error("agy workspace must be a directory");
  return { cwd, timeout, ...(typeof model === "string" ? { model } : {}) };
}

export function parseAgyResult(output: string): { success: boolean; response: string; conversation: string | null; error: string | null } {
  let result: Record<string, unknown> | null = null;
  for (const line of output.split("\n")) {
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (row !== null && typeof row === "object" && typeof row.status === "string") result = row;
    } catch { /* only the final JSON object is relevant */ }
  }
  const conversation = typeof result?.conversation_id === "string" && UUID_RE.test(result.conversation_id) ? result.conversation_id : null;
  return { success: result?.status === "SUCCESS" && typeof result.response === "string",
    response: typeof result?.response === "string" ? result.response : "",
    conversation, error: typeof result?.error === "string" ? result.error : null };
}

export function agyPrompt(note: string): string {
  return "You are the Antigravity CLI receiver connected to OCS as agy. Complete the delegated task within its stated scope. " +
    "The following OCS envelope marks another agent's message, not a human prompt. " +
    "Use any workspace explicitly specified by the requester. If the envelope contains a preview, use its Thread command to read the complete message before acting. Handle every item of an OCS batch and return one combined result. " +
    "Do not send an OCS reply yourself: the receiver sends your final answer automatically. " +
    "Report completed work, validation, and failures honestly.\n\n" + note;
}

async function runProcess(command: readonly string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeout: number;
    child?: (child: ChildProcess | null) => void }): Promise<{ code: number; output: string; reason: "timeout" | "output-limit" | null }> {
  return new Promise((done, reject) => {
    const child = spawnDetached(command[0]!, command.slice(1), { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "inherit"] });
    options.child?.(child);
    const chunks: Buffer[] = [];
    let size = 0;
    let reason: "timeout" | "output-limit" | null = null;
    const terminate = (why: "timeout" | "output-limit") => { reason = why; killChildGroup(child); };
    const timer = setTimeout(() => terminate("timeout"), options.timeout);
    child.stdout!.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) { terminate("output-limit"); return; }
      chunks.push(chunk);
    });
    child.once("error", (error) => { clearTimeout(timer); options.child?.(null); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); options.child?.(null); done({ code: code ?? -1, output: Buffer.concat(chunks).toString("utf8"), reason }); });
  });
}

function saveRegistration(worker: AgyWorker, env: NodeJS.ProcessEnv): void {
  const path = join(agyDir(env), "worker.json");
  const tmp = `${path}.${worker.token}.tmp`;
  writeFileSync(tmp, JSON.stringify(worker), { mode: 0o600 });
  renameSync(tmp, path);
}

export async function runAgyWorker(options: AgyOptions, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  assertAgyAddressAvailable(env);
  if (process.platform !== "win32") process.umask(0o077);
  const clean = agyEnvironment(env);
  const M = agyMessages(detectLang(clean));
  const token = randomBytes(32).toString("hex");
  const queue = new AgyQueue(clean);
  let claimed = false;
  let closing = false;
  let agent: ChildProcess | null = null;
  let drain: Promise<void> | null = null;
  const worker: AgyWorker = { v: 1, target: "agy", pid: process.pid, cwd: options.cwd, status: "idle",
    token, socketPath: agySocketPath(token, clean), heartbeat: Date.now() };
  const publish = (status: "idle" | "working" = worker.status) => { worker.status = status; worker.heartbeat = Date.now(); saveRegistration(worker, clean); };
  const ocs = selfCommand();
  const deliver = async (job: AgyJob, response: string) => {
    if (!queue.beginReply(job.id)) return;
    let text = response.trim() || "(agy returned an empty response)";
    const replyLimit = process.platform === "win32" ? 12000 : 90000;
    if (Buffer.byteLength(text) > replyLimit) {
      const path = join(agyDir(clean), `${job.id}.txt`);
      writeFileSync(path, text, { mode: 0o600 });
      text = Buffer.from(text).subarray(0, process.platform === "win32" ? 10000 : 80000).toString("utf8") + `\n\nFull result: ${path}`;
    }
    const command = job.replyTarget === undefined
      ? [...ocs, "send", job.channel, text, "--reply-to", String(job.seq)]
      : [...ocs, "dm", job.replyTarget, text];
    try {
      const result = await runProcess(command, { cwd: options.cwd, env: clean, timeout: 90000 });
      queue.finishReply(job.id, result.code);
    } catch { queue.finishReply(job.id, -1); }
    // 2/3 and timeouts are stored-only/unknown; never replay a possibly committed reply.
  };
  const execute = async (job: AgyJob) => {
    const command = [clean.OCS_AGY_BIN ?? "agy", "-p", agyPrompt(job.note), "--output-format", "json",
      "--print-timeout", `${options.timeout}s`];
    const conversation = queue.conversation(job.channel);
    if (conversation !== null) command.push("--conversation", conversation);
    if (options.model !== undefined) command.push("--model", options.model);
    try {
      const result = await runProcess(command, { cwd: options.cwd, env: clean, timeout: options.timeout * 1000 + 5000,
        child: (child) => { agent = child; } });
      const parsed = parseAgyResult(result.output);
      const success = !closing && result.code === 0 && result.reason === null && parsed.success;
      if (success && parsed.conversation !== null) queue.saveConversation(job.channel, parsed.conversation);
      const error = closing ? M.interrupted : result.reason === "timeout" ? M.taskTimeout : result.reason === "output-limit" ? M.outputLimit :
        parsed.error?.replace(/https?:\/\/\S+/g, "[URL omitted]").slice(0, 1500) ?? M.malformed;
      return { success, response: success ? parsed.response : M.taskFailed(error) };
    } catch (error) {
      return { success: false, response: M.taskFailed((error instanceof Error ? error.message : String(error)).slice(0, 1500)) };
    }
  };
  const consume = async () => {
    while (!closing) {
      const job = queue.next();
      if (job === null) break;
      publish("working");
      if (job.state === "queued") {
        const result = await execute(job);
        queue.complete(job.id, result.success, result.response);
        await deliver(job, result.response);
      } else {
        const response = job.response ?? M.interrupted;
        if (job.state === "interrupted") queue.complete(job.id, false, response);
        await deliver(job, response);
      }
    }
    if (!closing) publish("idle");
  };
  const kick = () => {
    if (drain !== null || closing) return;
    drain = consume().catch((error: unknown) => { console.error(String(error)); shutdown(); }).finally(() => { drain = null; });
  };
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.once("close", () => clients.delete(socket));
    socket.setTimeout(4000, () => socket.destroy());
    let data = Buffer.alloc(0);
    let answered = false;
    socket.on("data", (chunk: Buffer) => {
      if (answered) return;
      data = Buffer.concat([data, chunk]);
      if (data.length > AGY_FRAME_MAX_BYTES) { answered = true; socket.destroy(); return; }
      const newline = data.indexOf(10);
      if (newline < 0) return;
      answered = true;
      try {
        const input = JSON.parse(data.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
        if (typeof input.token !== "string" || !AGY_TOKEN_RE.test(input.token) ||
            !timingSafeEqual(Buffer.from(input.token), Buffer.from(token)) || closing) {
          socket.end(JSON.stringify({ ok: false, error: "invalid request" }) + "\n"); return;
        }
        if (input.op === "stop") {
          socket.end(JSON.stringify({ ok: true, job: "stop" }) + "\n", shutdown);
          return;
        }
        if (!validAgyJob(input)) throw new Error("invalid wake");
        const job = queue.submit({ channel: input.channel, seq: input.seq, note: input.note,
          ...(input.replyTarget === undefined ? {} : { replyTarget: input.replyTarget }) });
        socket.end(JSON.stringify({ ok: true, job }) + "\n");
        kick();
      } catch { socket.end(JSON.stringify({ ok: false, error: "request not committed" }) + "\n"); }
    });
    socket.on("error", () => {});
  });
  let stop!: () => void;
  const stopped = new Promise<void>((resolveStop) => { stop = resolveStop; });
  const shutdown = () => { if (closing) return; closing = true; if (agent !== null) killChildGroup(agent); stop(); };
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    queue.claim(process.pid, token); claimed = true;
    queue.recover(M.interrupted);
    await new Promise<void>((ready, reject) => { server.once("error", reject); server.listen(worker.socketPath, () => { server.removeListener("error", reject); ready(); }); });
    if (process.platform !== "win32") chmodSync(worker.socketPath, 0o600);
    publish();
    heartbeat = setInterval(() => { try { publish(); } catch { shutdown(); } }, 2000);
    process.once("SIGTERM", shutdown); process.once("SIGINT", shutdown);
    kick();
    await stopped;
    for (const client of clients) client.destroy();
    await new Promise<void>((closed) => server.close(() => closed()));
    if (drain !== null) await drain;
  } finally {
    clearInterval(heartbeat);
    process.removeListener("SIGTERM", shutdown); process.removeListener("SIGINT", shutdown);
    try {
      const path = join(agyDir(clean), "worker.json");
      if (JSON.parse(readFileSync(path, "utf8")).token === token) unlinkSync(path);
    } catch { /* never remove another runtime's record */ }
    if (process.platform !== "win32") {
      try { unlinkSync(worker.socketPath); } catch { /* already absent */ }
    }
    if (claimed) queue.release(token);
    queue.close();
  }
}

export async function startAgyWorker(options: AgyOptions, env: NodeJS.ProcessEnv): Promise<AgyWorker | null> {
  const running = findAgyWorker(env);
  if (running !== null) return running;
  assertAgyAddressAvailable(env);
  const dir = ensureAgyDirectory(env);
  const log = openSync(join(dir, "worker.log"), "a", 0o600);
  const [command, ...args] = selfCommand();
  try {
    const child = spawnDetached(command!, [...args, AGY_WORKER_COMMAND, "--cwd", options.cwd, "--timeout", String(options.timeout),
      ...(options.model === undefined ? [] : ["--model", options.model])], { cwd: options.cwd, env: agyEnvironment(env), stdio: ["ignore", log, log] });
    child.unref();
  } finally { closeSync(log); }
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const worker = findAgyWorker(env);
    if (worker !== null) return worker;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return null;
}

function assertAgyAddressAvailable(env: NodeJS.ProcessEnv): void {
  if (readOcsName("agy", env) !== null || listNativeSessions(env).some((session) => session.name?.toLowerCase() === "agy")) {
    throw new Error("agy address is already owned by another session; use its short id and rename it first");
  }
}
