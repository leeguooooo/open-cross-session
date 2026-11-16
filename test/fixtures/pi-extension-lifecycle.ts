// Lifecycle host for the #76 tests in pi.test.ts. Runs in a child process so the generated
// extension's process.env, timers and sockets stay isolated from Bun's parallel test files.
//
//   foreign  — a TUI session starts; then a second, non-TUI session in the same process (same
//              cached module, a different extension API object) starts and shuts down. The TUI's
//              registration, inbox and OCS_PI_SESSION_ID must survive.
//   stale    — two module instances (as after an extension reload whose old instance was never
//              shut down) both register the same session in the same process; the old one then
//              shuts down. The newer registration and inbox must survive.
//   heal     — a TUI session starts; the test deletes its registration and socket, and this host
//              drops OCS_PI_SESSION_ID; the periodic check must recreate all three.
//
// Each run waits for one wake (the test sends it), then shuts the TUI down and prints JSON.

export {};

const [extensionPath, sessionId, scenario] = process.argv.slice(2);
if (extensionPath === undefined || sessionId === undefined || scenario === undefined) process.exit(2);

type Handler = (event: unknown, ctx: Context) => unknown;
interface Context {
  mode: string;
  cwd: string;
  sessionManager: { getSessionId: () => string };
  ui: { notify(message: string): void; setStatus(key: string, text: string | undefined): void };
}

const sent: Array<Record<string, unknown>> = [];
const notices: string[] = [];
const statuses: Array<string | null> = [];

function makeApi() {
  const handlers = new Map<string, Handler[]>();
  const api = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    getSessionName: () => "auth review",
    sendMessage(message: Record<string, unknown>) {
      sent.push(message);
    },
  };
  const emit = async (name: string, ctx: Context) => {
    for (const handler of handlers.get(name) ?? []) await handler({}, ctx);
  };
  return { api, emit };
}

function context(mode: string, id: string, track: boolean): Context {
  return {
    mode,
    cwd: "/work/pi-auth",
    sessionManager: { getSessionId: () => id },
    ui: {
      notify(message: string) { notices.push(message); },
      setStatus(_key: string, text: string | undefined) { if (track) statuses.push(text ?? null); },
    },
  };
}

const tui = context("tui", sessionId, true);
const first = makeApi();
const moduleA = await import(extensionPath);
moduleA.default(first.api);
await first.emit("session_start", tui);

let envAfterForeign: string | null = null;
let finalOwner = first;
let registeredBeforeOldShutdown: string[] = [];
if (scenario === "foreign") {
  const sibling = makeApi();
  moduleA.default(sibling.api);
  const other = context("print", "99999999-8888-4777-8666-555555555555", false);
  await sibling.emit("session_start", other);
  await sibling.emit("session_shutdown", other);
  envAfterForeign = process.env.OCS_PI_SESSION_ID ?? null;
} else if (scenario === "stale") {
  // A fresh module instance, as Pi's loader produces after clearing its extension cache.
  const moduleB = await import(`${extensionPath}?reload`);
  const second = makeApi();
  moduleB.default(second.api);
  await second.emit("session_start", tui);
  // both instances are live: the old one's check (on agent events and its timer) must not take
  // the registration back
  await first.emit("agent_end", tui);
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const dir = join(process.env.OCS_HOME!, "pi-sessions");
  registeredBeforeOldShutdown = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => (JSON.parse(readFileSync(join(dir, file), "utf8")) as { socket_path: string }).socket_path);
  await first.emit("session_shutdown", tui);
  finalOwner = second;
}
// The scenario's setup is done: the test may look at the files now.
console.error("ready");
if (scenario === "heal") {
  // The test removes the files; this host can only drop its own environment.
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
  });
  delete process.env.OCS_PI_SESSION_ID;
  console.error("dropped");
}

const deadline = Date.now() + 8_000;
while (sent.length === 0 && Date.now() < deadline) await Bun.sleep(10);
const envAtWake = process.env.OCS_PI_SESSION_ID ?? null;
await finalOwner.emit("session_shutdown", tui);
console.log(JSON.stringify({ sent, notices, statuses, envAfterForeign, envAtWake, registeredBeforeOldShutdown }));
process.exit(sent.length === 1 ? 0 : 1);
