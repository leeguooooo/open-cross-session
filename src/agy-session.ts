// Interactive Antigravity CLI windows (#89, docs/agy.md "Interactive windows").
//
// Discovery: an interactive agy process holds <app data>/presence/<conversation>.lock; the
// conversation id is the file name. Delivery: `agy agentapi send-message` through that window's
// OWN language server. Its loopback address and CSRF token exist only in the window's tool
// shells, so a window becomes DM-able after its agent runs ocs once (self-registration below).
//
// ACP sessions (`agy acp`, e.g. Orca Bot): no presence lock and no tty. The process that hosts a
// loaded session holds <app data>/brain/<conversation> open as a directory (with
// --process-per-session that is the `agy acp --worker` child), its tool shells get
// ANTIGRAVITY_LS_ADDRESS with an empty CSRF token, and agentapi send-message into that server
// runs a turn whose output streams to the ACP client as session/update (probed on agy 1.5.16).
// The brain-dir holder takes the place of the presence lock in every proof below.
//
// Invariants (CLAUDE.md iron rule 17):
//   * agentapi echoes success for any id, even one no server owns (probed against agy 1.4.7 /
//     1.5.16), so its reply is never the liveness proof. Before every send, re-prove: the
//     registered pid (same start time) holds that conversation's presence lock, is an
//     interactive `agy` with a tty, and is the listener on the registered loopback port.
//     Anything else = unavailable with zero bytes sent.
//   * Only ever use the server of the process that holds the conversation; another
//     window's server accepts the request and silently drops it.
//   * Exit 0 with a matching echo = accepted (not read). A spawn that ran and then timed out,
//     or returned anything unexpected = unknown-outcome; never resend.
//   * The host frames the text as <SYSTEM_MESSAGE> "important information" and does not
//     escape it, so the note's uppercase pseudo-tags are neutralized here (rule 7).
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { psTable } from "./codex-queue.ts";
import { ocsHome } from "./store.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FULL_TARGET_RE = /^agy-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
export const AGY_SHORT_TARGET_RE = /^agy-([0-9a-f]{8})$/i;
const LS_ADDRESS_RE = /^(?:localhost|127\.0\.0\.1):(\d{1,5})$/;
const TOKEN_RE = /^[A-Za-z0-9-]{16,128}$/;
export const AGY_WINDOW_WAKE_TIMEOUT_MS = 15000;
const PROBE_TIMEOUT_MS = 3000;
const NOTE_MAX_BYTES = 5120;
/** agy subcommands; any of these as argv[1] is not an interactive window. */
const SUBCOMMANDS = new Set(["acp", "agent", "agents", "agentapi", "changelog", "help", "install", "mcp", "mic-serve", "models",
  "plugin", "plugins", "remote-control", "update"]);

export const isAgyConversationId = (id: string): boolean => UUID.test(id);
/** Canonical address: the full conversation id, so sender name and DM identity never drift. */
export function agyWindowTargetName(id: string): string { return "agy-" + id.toLowerCase(); }
export function agyWindowShortId(id: string): string { return "agy-" + id.slice(0, 8).toLowerCase(); }
export function agyConversationIdFromTarget(target: string): string | null {
  const m = FULL_TARGET_RE.exec(target);
  return m === null ? null : m[1]!.toLowerCase();
}

export interface AgyProc { pid: number; ppid: number; tty: string; comm: string; args: string; start: string; }
/** acp: an `agy acp` session (proved by its brain dir), not an interactive window. */
export interface AgyWindow { conversationId: string; pid: number; cwd: string | null; registered: boolean; acp?: true; }
interface Registration { v: 1; pid: number; start: string; lsAddress: string; token: string; exe: string | null; registeredAt: string; }
export interface AgyWindowDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** conversation id → REG holder pids of <presence>/<id>.lock; null = the probe itself failed. */
  lockHolders?: (presenceDir: string) => Map<string, number[]> | null;
  /** conversation id → pids holding <brain>/<id> open as a directory; null = the probe itself failed. */
  brainHolders?: (brainDir: string) => Map<string, number[]> | null;
  proc?: (pid: number) => AgyProc | null;
  listener?: (pid: number, port: number) => boolean;
  cwdOf?: (pid: number) => string | null;
  /** pid → {ppid, comm}: the ancestor walk for "which host am I running under". */
  ancestors?: () => ReadonlyMap<number, { ppid: number; comm: string }>;
  alive?: (pid: number) => boolean;
  run?: (exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) =>
    { status: number | null; stdout: string; stderr?: string; error?: string; started: boolean };
}

function sysEnv(): NodeJS.ProcessEnv { return { PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin", LC_ALL: "C" }; }

export function agyAppDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OCS_AGY_APP_DATA_DIR;
  if (typeof override === "string" && isAbsolute(override)) return override;
  return join(env.HOME && isAbsolute(env.HOME) ? env.HOME : homedir(), ".gemini", "antigravity-cli");
}
export function agyWindowsDir(env: NodeJS.ProcessEnv = process.env): string { return join(ocsHome(env), "agy-windows"); }

function defaultProc(pid: number): AgyProc | null {
  const r = spawnSync("ps", ["-o", "ppid=,tty=,lstart=,comm=", "-p", String(pid)], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: sysEnv() });
  const a = spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: sysEnv() });
  // lstart is five fields: "Wed Nov 25 10:45:58 2026"; comm (a path on macOS) may contain spaces.
  const m = /^\s*(\d+)\s+(\S+)\s+(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(.+?)\s*$/.exec(r.stdout ?? "");
  if (m === null || a.status !== 0) return null;
  return { pid, ppid: Number(m[1]), tty: m[2]!, start: m[3]!, comm: m[4]!, args: (a.stdout ?? "").trim() };
}

function defaultLockHolders(dir: string): Map<string, number[]> | null { return holdersIn(dir, "REG", /^([0-9a-f-]{36})\.lock$/i); }
function defaultBrainHolders(dir: string): Map<string, number[]> | null { return holdersIn(dir, "DIR", /^([0-9a-f-]{36})$/i); }

function holdersIn(dir: string, type: "REG" | "DIR", nameRe: RegExp): Map<string, number[]> | null {
  const r = spawnSync("lsof", ["-n", "-P", "-F", "pftn", "+d", dir], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: sysEnv() });
  if (r.error !== undefined || r.signal !== null) return null; // exit 1 = nobody holds anything
  const out = new Map<string, number[]>();
  let pid: number | null = null;
  let reg = false;
  for (const line of (r.stdout ?? "").split("\n")) {
    const tag = line[0];
    if (tag === "p") { const n = Number(line.slice(1)); pid = Number.isSafeInteger(n) && n > 0 ? n : null; }
    else if (tag === "f") reg = false;
    else if (tag === "t") reg = line.slice(1) === type;
    else if (tag === "n" && pid !== null && reg) {
      const m = nameRe.exec(basename(line.slice(1)));
      if (m === null || !UUID.test(m[1]!)) continue;
      const id = m[1]!.toLowerCase();
      const list = out.get(id) ?? [];
      if (!list.includes(pid)) list.push(pid);
      out.set(id, list);
    }
  }
  return out;
}

function defaultListener(pid: number, port: number): boolean {
  const r = spawnSync("lsof", ["-n", "-P", "-a", "-p", String(pid), "-iTCP:" + port, "-sTCP:LISTEN", "-F", "pn"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: sysEnv() });
  if (r.error !== undefined || r.signal !== null) return false;
  const lines = (r.stdout ?? "").split("\n");
  return lines.includes("p" + pid) && lines.some((l) => /^n(?:127\.0\.0\.1|\[::1\]|localhost):\d+$/.test(l) && l.endsWith(":" + port));
}

function defaultCwd(pid: number): string | null {
  const r = spawnSync("lsof", ["-n", "-P", "-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, env: sysEnv() });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("n/"));
  return line === undefined ? null : line.slice(1);
}

function defaultAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; } // EPERM = another user's process
}

function defaultRun(exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) {
  const r = spawnSync(exe, args, { encoding: "utf8", timeout: timeoutMs, env, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  // ENOENT / EACCES: nothing started, so nothing was sent.
  const started = r.error === undefined || (code !== "ENOENT" && code !== "EACCES");
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "",
    ...(r.error !== undefined ? { error: String(code ?? r.error) } : r.signal !== null ? { error: "killed by " + r.signal } : {}), started };
}

/** Interactive TUI only: print mode (-p/--print/--prompt) and subcommands hold presence locks too. */
export function isInteractiveAgy(p: AgyProc): boolean {
  if (basename(p.comm).replace(/\.exe$/i, "") !== "agy") return false;
  if (p.tty === "??" || p.tty === "?" || p.tty === "") return false;
  const argv = p.args.split(/\s+/).slice(1);
  if (argv.length > 0 && SUBCOMMANDS.has(argv[0]!)) return false;
  return !argv.some((a) => a === "-p" || a === "--print" || a === "--prompt" || a.startsWith("--print=") || a.startsWith("--prompt="));
}

/** An ACP stdio server (or its per-session worker). It has no tty; its sessions are proved by brain-dir holding. */
export function isAcpAgy(p: AgyProc): boolean {
  if (basename(p.comm).replace(/\.exe$/i, "") !== "agy") return false;
  const argv = p.args.split(/\s+/).slice(1);
  return argv[0] === "acp" && !argv.some((a) => a === "--login" || a === "-h" || a === "--help");
}
const hostKindOk = (p: AgyProc, acp: boolean): boolean => acp ? isAcpAgy(p) : isInteractiveAgy(p);
/** Exactly one agy ACP process holds this conversation's brain dir; other holders (indexers, shells) don't count. */
function acpOwner(holders: Map<string, number[]> | null, id: string, proc: (pid: number) => AgyProc | null,
  cache = new Map<number, AgyProc | null>()): AgyProc | null {
  const owners: AgyProc[] = [];
  for (const pid of holders?.get(id) ?? []) {
    if (!cache.has(pid)) cache.set(pid, proc(pid));
    const p = cache.get(pid)!;
    if (p !== null && isAcpAgy(p)) owners.push(p);
  }
  return owners.length === 1 ? owners[0]! : null;
}

function ownedPath(path: string, dir: boolean): boolean {
  try {
    const s = lstatSync(path);
    if (s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile() || s.size > 4096)) return false;
    if (process.platform === "win32") return true;
    return (s.mode & 0o077) === 0 && (typeof process.getuid !== "function" || s.uid === process.getuid());
  } catch { return false; }
}

function readRegistration(pid: number, env: NodeJS.ProcessEnv): Registration | null {
  const dir = agyWindowsDir(env);
  const path = join(dir, pid + ".json");
  if (!ownedPath(dir, true) || !ownedPath(path, false)) return null;
  try {
    const r = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (r.v !== 1 || r.pid !== pid || typeof r.start !== "string" || r.start.length === 0 || r.start.length > 64 ||
        typeof r.lsAddress !== "string" || !LS_ADDRESS_RE.test(r.lsAddress) ||
        typeof r.token !== "string" || !(r.token === "" || TOKEN_RE.test(r.token)) ||
        !(r.exe === null || (typeof r.exe === "string" && isAbsolute(r.exe))) || typeof r.registeredAt !== "string") return null;
    return r as unknown as Registration;
  } catch { return null; }
}

function writeRegistration(reg: Registration, env: NodeJS.ProcessEnv): void {
  const dir = agyWindowsDir(env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!ownedPath(dir, true)) throw new Error("unsafe agy-windows directory");
  const path = join(dir, reg.pid + ".json");
  const tmp = path + "." + process.pid + ".tmp";
  writeFileSync(tmp, JSON.stringify(reg) + "\n", { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** Nearest host ancestor wins: agents launched from an agy shell inherit ANTIGRAVITY_* too. */
function nearestAgyAncestor(proc: (pid: number) => AgyProc | null, env: NodeJS.ProcessEnv, start: number,
  ancestors?: AgyWindowDeps["ancestors"]): AgyProc | null {
  const table = ancestors === undefined ? psTable(env) : ancestors();
  let pid = start;
  for (let depth = 0; depth < 64 && pid > 1; depth++) {
    const p = table.get(pid);
    if (p === undefined) return null;
    const name = basename(p.comm).replace(/\.exe$/i, "");
    if (name === "agy") return proc(pid);
    if (/^(codex|codex-cxs|claude|pi|pi-rpc|hermes|opencode)$/.test(name) || /^grok(?:-\d[^/]*)?$/.test(name) ||
        /\/(?:ChatGPT|Claude)\.app\//.test(p.comm)) return null;
    if (p.ppid === pid) return null;
    pid = p.ppid;
  }
  return null;
}

/** Conversation id of the agy window this ocs runs in (its tool shell), or null. */
export function selfAgyConversationId(env: NodeJS.ProcessEnv = process.env, deps: AgyWindowDeps = {}, start = process.ppid): string | null {
  const id = env.ANTIGRAVITY_CONVERSATION_ID;
  // The headless receiver's jobs are `agy -p` children with OCS_NAME=agy: they are the receiver.
  if (env.ANTIGRAVITY_AGENT !== "1" || typeof id !== "string" || !UUID.test(id) || env.OCS_NAME === "agy") return null;
  if ((deps.platform ?? process.platform) === "win32") return null;
  // Same exclusions as discovery: an `agy -p` job or a subcommand is not a window and cannot take window DMs.
  const host = nearestAgyAncestor(deps.proc ?? defaultProc, env, start, deps.ancestors);
  return host === null || !(isInteractiveAgy(host) || isAcpAgy(host)) ? null : id.toLowerCase();
}

/**
 * Called on every ocs invocation inside an agy tool shell. Records the window's server address and
 * token, keyed by pid + start time, only when the window provably owns the conversation.
 */
export function registerSelfAgyWindow(env: NodeJS.ProcessEnv = process.env, deps: AgyWindowDeps = {}, start = process.ppid): AgyWindow | null {
  const id = env.ANTIGRAVITY_CONVERSATION_ID;
  const address = env.ANTIGRAVITY_LS_ADDRESS;
  const token = env.ANTIGRAVITY_CSRF_TOKEN;
  if (env.ANTIGRAVITY_AGENT !== "1" || typeof id !== "string" || !UUID.test(id) || env.OCS_NAME === "agy") return null;
  if (typeof address !== "string" || !LS_ADDRESS_RE.test(address) || typeof token !== "string") return null;
  if ((deps.platform ?? process.platform) === "win32") return null;
  const proc = deps.proc ?? defaultProc;
  const host = nearestAgyAncestor(proc, env, start, deps.ancestors);
  if (host === null) return null;
  const conversation = id.toLowerCase();
  const acp = isAcpAgy(host);
  if (acp) {
    // ACP servers run with an empty CSRF token; an interactive window always has one.
    if (token !== "" && !TOKEN_RE.test(token)) return null;
    const holders = (deps.brainHolders ?? defaultBrainHolders)(join(agyAppDataDir(env), "brain"));
    if (acpOwner(holders, conversation, proc, new Map([[host.pid, host]]))?.pid !== host.pid) return null;
  } else {
    if (!isInteractiveAgy(host) || !TOKEN_RE.test(token)) return null;
    const holders = (deps.lockHolders ?? defaultLockHolders)(join(agyAppDataDir(env), "presence"));
    if (holders === null || holders.get(conversation)?.length !== 1 || holders.get(conversation)![0] !== host.pid) return null;
  }
  const port = Number(LS_ADDRESS_RE.exec(address)![1]);
  if (!(deps.listener ?? defaultListener)(host.pid, port)) return null;
  const exe = typeof env.ANTIGRAVITY_AGENTAPI_EXE === "string" && isAbsolute(env.ANTIGRAVITY_AGENTAPI_EXE) &&
    basename(env.ANTIGRAVITY_AGENTAPI_EXE) === "agy" ? env.ANTIGRAVITY_AGENTAPI_EXE : isAbsolute(host.comm) ? host.comm : null;
  const current = readRegistration(host.pid, env);
  if (current === null || current.start !== host.start || current.lsAddress !== address || current.token !== token || current.exe !== exe) {
    try {
      writeRegistration({ v: 1, pid: host.pid, start: host.start, lsAddress: address, token, exe, registeredAt: new Date().toISOString() }, env);
    } catch { return null; }
  }
  return { conversationId: conversation, pid: host.pid, cwd: (deps.cwdOf ?? defaultCwd)(host.pid), registered: true, ...(acp ? { acp: true as const } : {}) };
}

function pruneRegistrations(live: ReadonlySet<number>, env: NodeJS.ProcessEnv, alive: (pid: number) => boolean): void {
  let names: string[];
  try { names = readdirSync(agyWindowsDir(env)); } catch { return; }
  for (const name of names) {
    const m = /^(\d+)\.json$/.exec(name);
    if (m === null || live.has(Number(m[1])) || alive(Number(m[1]))) continue;
    try { unlinkSync(join(agyWindowsDir(env), name)); } catch { /* concurrent prune */ }
  }
}

/** Live interactive windows and ACP sessions. registered = DM-able; otherwise identify-only. */
export function listAgyWindows(deps: AgyWindowDeps = {}): { windows: AgyWindow[]; reason?: string } {
  const env = deps.env ?? process.env;
  if ((deps.platform ?? process.platform) === "win32") return { windows: [], reason: "interactive agy windows are not supported on Windows" };
  const isDir = (dir: string): boolean => { try { return lstatSync(dir).isDirectory(); } catch { return false; } };
  const presence = join(agyAppDataDir(env), "presence");
  const brain = join(agyAppDataDir(env), "brain");
  const proc = deps.proc ?? defaultProc;
  const alive = deps.alive ?? defaultAlive;
  const procs = new Map<number, AgyProc | null>();
  const procOf = (pid: number): AgyProc | null => {
    if (!procs.has(pid)) procs.set(pid, alive(pid) ? proc(pid) : null);
    return procs.get(pid)!;
  };
  const windows: AgyWindow[] = [];
  const add = (id: string, p: AgyProc, acp: boolean): void => {
    const reg = readRegistration(p.pid, env);
    // DM-able only while the registered server still listens: `who` must not promise what the send-time check refuses.
    const registered = reg !== null && reg.start === p.start && (acp || reg.token !== "") &&
      (deps.listener ?? defaultListener)(p.pid, Number(LS_ADDRESS_RE.exec(reg.lsAddress)![1]));
    windows.push({ conversationId: id, pid: p.pid, cwd: (deps.cwdOf ?? defaultCwd)(p.pid), registered, ...(acp ? { acp: true as const } : {}) });
  };
  const reasons: string[] = [];
  if (isDir(presence)) {
    const holders = (deps.lockHolders ?? defaultLockHolders)(presence);
    if (holders === null) reasons.push("lsof unavailable; cannot prove which agy windows are open");
    for (const [id, pids] of holders ?? []) {
      if (pids.length !== 1) continue; // two holders of one conversation: refuse to pick
      const p = procOf(pids[0]!);
      if (p !== null && isInteractiveAgy(p)) add(id, p, false);
    }
  }
  if (isDir(brain)) {
    const holders = (deps.brainHolders ?? defaultBrainHolders)(brain);
    if (holders === null) { if (reasons.length === 0) reasons.push("lsof unavailable; cannot prove which agy ACP sessions are open"); }
    else for (const id of holders.keys()) {
      if (windows.some((w) => w.conversationId === id)) continue;
      const owner = acpOwner(holders, id, procOf, procs);
      if (owner !== null) add(id, owner, true);
    }
  }
  pruneRegistrations(new Set(windows.map((w) => w.pid)), env, alive);
  return reasons.length > 0 ? { windows, reason: reasons[0]! } : { windows };
}

/** `agy-<8hex>` → the one live window with that prefix; several = ambiguous; none = null. */
export function resolveAgyShortTarget(target: string, deps: AgyWindowDeps = {}): { id: string } | { ambiguous: AgyWindow[] } | null {
  const m = AGY_SHORT_TARGET_RE.exec(target);
  if (m === null) return null;
  const matches = listAgyWindows(deps).windows.filter((w) => w.conversationId.startsWith(m[1]!.toLowerCase()));
  if (matches.length > 1) return { ambiguous: matches };
  return matches.length === 1 ? { id: matches[0]!.conversationId } : null;
}

/** The host wraps the text in <SYSTEM_MESSAGE> and does not escape it. */
export function neutralizeAgyNote(note: string): string {
  return note.replace(/<(\/?)([A-Z][A-Z0-9_]*)(?=[\s>/]|$)/g, "‹$1$2");
}

export type AgyWindowWakeResult = { ok: true } |
  { ok: false; reason: "unavailable" | "not-open" | "unregistered" | "failed" | "unknown-outcome"; detail?: string };

export function wakeAgyWindow(conversationId: string, note: string, deps: AgyWindowDeps = {}): AgyWindowWakeResult {
  const env = deps.env ?? process.env;
  const id = conversationId.toLowerCase();
  // Measure what is actually sent: neutralizing turns "<" (1 byte) into "‹" (3 bytes).
  const safeNote = neutralizeAgyNote(note);
  const bytes = Buffer.byteLength(safeNote, "utf8");
  if (!UUID.test(id) || bytes === 0 || bytes > NOTE_MAX_BYTES) return { ok: false, reason: "failed", detail: "invalid agy conversation or wake payload" };
  if ((deps.platform ?? process.platform) === "win32") return { ok: false, reason: "unavailable", detail: "interactive agy windows are not supported on Windows" };
  const listed = listAgyWindows(deps);
  const window = listed.windows.find((w) => w.conversationId === id);
  if (window === undefined) return { ok: false, reason: listed.reason === undefined ? "not-open" : "unavailable", ...(listed.reason ? { detail: listed.reason } : {}) };
  const p = (deps.proc ?? defaultProc)(window.pid);
  const reg = readRegistration(window.pid, env);
  if (!window.registered) return reg !== null && p !== null && reg.start === p.start
    ? { ok: false, reason: "unavailable", detail: "window's local server is not listening on its registered port" }
    : { ok: false, reason: "unregistered" };
  if (p === null || reg === null || reg.start !== p.start || !hostKindOk(p, window.acp === true))
    return { ok: false, reason: "unavailable", detail: "window changed since discovery" };
  const port = Number(LS_ADDRESS_RE.exec(reg.lsAddress)![1]);
  if (!(deps.listener ?? defaultListener)(window.pid, port)) return { ok: false, reason: "unavailable", detail: "window's local server is not listening on its registered port" };
  const exe = reg.exe ?? (isAbsolute(p.comm) ? p.comm : null);
  if (exe === null || basename(exe) !== "agy") return { ok: false, reason: "unavailable", detail: "cannot locate the agy executable" };
  // Only the address and token: the child must not inherit this shell's identity variables.
  const childEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: env.HOME ?? homedir(),
    ANTIGRAVITY_LS_ADDRESS: reg.lsAddress, ANTIGRAVITY_CSRF_TOKEN: reg.token };
  const r = (deps.run ?? defaultRun)(exe, ["agentapi", "send-message", "--title=ocs", id, safeNote], childEnv, AGY_WINDOW_WAKE_TIMEOUT_MS);
  if (!r.started) return { ok: false, reason: "unavailable", detail: r.error ?? "agy did not start" };
  type Reply = { response?: { sendMessage?: { recipientId?: unknown } }; error?: unknown } | null;
  const parse = (text: string): Reply => { try { return JSON.parse(text.slice(text.indexOf("{"))) as Reply; } catch { return null; } };
  // Success is read from stdout only: a stray stderr line must not turn an accepted send into unknown.
  const reply = parse(r.stdout);
  if (r.error === undefined && r.status === 0 && reply?.error === undefined && reply?.response?.sendMessage?.recipientId === id) return { ok: true };
  const errorReply = reply?.error !== undefined ? reply : parse(r.stderr ?? "");
  const error = typeof errorReply?.error === "string" ? errorReply.error : "";
  // Rejected before the handler ran: the request carried no message into the conversation.
  if (r.error === undefined && /Unauthenticated|connection refused|is not set|no such host/i.test(error)) return { ok: false, reason: "unavailable", detail: error.slice(0, 200) };
  return { ok: false, reason: "unknown-outcome", detail: (r.error ?? (error || "unexpected agentapi reply")).slice(0, 200) };
}
