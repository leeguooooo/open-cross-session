// One-shot host for pi.test.ts. A child process keeps the generated extension's
// process.env and socket lifecycle isolated from Bun's parallel test files.

export {};

const [extensionPath, sessionId] = process.argv.slice(2);
if (extensionPath === undefined || sessionId === undefined) process.exit(2);

const handlers = new Map<string, (event: unknown, ctx: typeof context) => unknown>();
const sent: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }> = [];
const notices: string[] = [];
const api = {
  on(name: string, handler: (event: unknown, ctx: typeof context) => unknown) {
    handlers.set(name, handler);
  },
  getSessionName: () => "auth review",
  sendMessage(message: Record<string, unknown>, options: Record<string, unknown>) {
    sent.push({ message, options });
  },
};
const context = {
  mode: "tui",
  cwd: "/work/pi-auth",
  sessionManager: { getSessionId: () => sessionId },
  ui: {
    notify(message: string) { notices.push(message); },
    setStatus() {},
  },
};

const loaded = await import(extensionPath);
loaded.default(api);
await handlers.get("session_start")?.({}, context);
const deadline = Date.now() + 5_000;
while (sent.length === 0 && Date.now() < deadline) await Bun.sleep(10);
await handlers.get("session_shutdown")?.({}, context);
console.log(JSON.stringify({ sent, notices }));
process.exit(sent.length === 1 ? 0 : 1);
