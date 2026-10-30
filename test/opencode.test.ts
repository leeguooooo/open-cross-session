import { afterEach, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { tempDir as makeTempDir, cleanupTempDirs } from "./tmp.ts";
import { listOpenCodeSessions, wakeOpenCodeSession, opencodeTargetName, openCodeShortId, opencodeInboxPathValid } from "../src/opencode.ts";
import { OPENCODE_PLUGIN_SOURCE, installOpenCodeIntegration, openCodePluginCurrent, openCodePluginPath } from "../src/opencode-plugin.ts";
import { resolveDmTarget, selfIdentity, resolveSelfName, selfNameOwner, canonicalWakeAddress } from "../src/roster.ts";
import { setOcsName, ocsNameFor, listOcsNames } from "../src/names.ts";
import { appendMessage, readRoutedMessages } from "../src/store.ts";
import { listInboxThreads } from "../src/inbox.ts";

const ID = "ses_MixedCase123456789";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); cleanupTempDirs(); });

// Run the shipped plugin source with host API fixtures and real private IPC.
async function host(prompt: (input: { sessionID: string; delivery: string; text: string }) => Promise<unknown> = async (x) => x) {
  const home = makeTempDir("ocs-oc-");
  const old = process.env.OCS_HOME;
  process.env.OCS_HOME = home;
  const path = join(home, "plugin.mjs");
  writeFileSync(path, OPENCODE_PLUGIN_SOURCE);
  const plugin = (await import(path)).default;
  const hooks = new Map<string, (event: { sessionID: string }) => Promise<void>>();
  const shellHooks: Array<(event: { env: Record<string, string> }) => void> = [];
  const tools: Array<{ id: string; execute: (input: unknown, ctx: { sessionID: string }) => Promise<unknown> }> = [
    { id: "bash", execute: async () => {
      await Bun.sleep(2);
      const event = { env: { CODEX_THREAD_ID: "inherited-codex" } };
      for (const hook of shellHooks) hook(event);
      return event.env;
    } },
  ];
  const cleanup = await plugin.setup({
    session: {
      get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, title: "Test", location: { directory: home } }),
      prompt,
      hook: async (name: string, fn: (event: { sessionID: string }) => Promise<void>) => { hooks.set(name, fn); return { dispose: async () => {} }; },
    },
    tool: { transform: async (fn: (editor: unknown) => void) => {
      fn({ list: () => tools, update: (id: string, update: (t: unknown) => void) => update(tools.find((t) => t.id === id)) });
      return { dispose: async () => {} };
    } },
    shell: { hook: async (_name: string, fn: (event: { env: Record<string, string> }) => void) => { shellHooks.push(fn); return { dispose: async () => {} }; } },
  });
  cleanups.push(cleanup);
  if (old === undefined) delete process.env.OCS_HOME; else process.env.OCS_HOME = old;
  return { home, hooks, tools, env: { OCS_HOME: home } };
}

test("shipped plugin registers exact session identity, queues one wake and cleans up", async () => {
  const admitted: unknown[] = [];
  const h = await host(async (input) => { admitted.push(input); return input; });
  await h.hooks.get("context")!({ sessionID: ID });
  const [session] = listOpenCodeSessions(h.env);
  expect(session?.session_id).toBe(ID);
  expect(session?.target).toBe(opencodeTargetName(ID));
  expect(resolveDmTarget(openCodeShortId(ID), h.env)).toMatchObject({ kind: "opencode", identity: `opencode:${ID}` });
  expect(await wakeOpenCodeSession(session!, "[ocs wake] peer said hello")).toEqual({ ok: true, sessionId: ID, delivery: "queued" });
  expect(admitted).toEqual([{ sessionID: ID, text: "[ocs wake] peer said hello", delivery: "queue", metadata: { source: "ocs", transport: "local-ipc" } }]);
  // Native API says queue, while the OCS local protocol says queued.
  await cleanups.pop()!();
  expect(listOpenCodeSessions(h.env)).toEqual([]);
});

test("concurrent tools receive invocation-scoped identity, preserving case", async () => {
  const h = await host();
  const ids = [ID, "ses_OtherSession987654"];
  const outputs = await Promise.all(ids.map((sessionID) => h.tools[0]!.execute({}, { sessionID })));
  expect(outputs).toEqual(ids.map((id) => expect.objectContaining({ OCS_OPENCODE_SESSION_ID: id, OCS_HOME: h.home, CODEX_THREAD_ID: undefined })));
  expect(process.env.OCS_OPENCODE_SESSION_ID).toBeUndefined();
  for (const id of ids) {
    const env = { ...h.env, OCS_OPENCODE_SESSION_ID: id };
    expect(resolveSelfName(env)).toBe(opencodeTargetName(id));
    expect(selfNameOwner(env)).toEqual({ kind: "opencode", id });
    expect(selfIdentity(opencodeTargetName(id))).toBe(`opencode:${id}`);
  }
});

test("rename, canonical mention and routed inbox keep the full case-sensitive session id", async () => {
  const h = await host();
  await h.hooks.get("context")!({ sessionID: ID });
  const owner = { kind: "opencode", id: ID } as const;
  expect(setOcsName("open-review", owner, { env: h.env }).ok).toBe(true);
  expect(ocsNameFor(owner, listOcsNames(h.env))?.id).toBe(ID);
  expect(resolveDmTarget("open-review", h.env)?.identity).toBe(`opencode:${ID}`);
  expect(canonicalWakeAddress("open-review", h.env)).toBe(opencodeTargetName(ID));
  appendMessage({ channel: "dm-test", from: "peer", body: "hello", from_identity: "name:peer", to_identity: `opencode:${ID}`, env: h.env });
  expect(readRoutedMessages("dm-test", { env: h.env })[0]?.to_identity).toBe(`opencode:${ID}`);
  expect(listInboxThreads({ primaryName: opencodeTargetName(ID), identities: [`opencode:${ID}`], mentionNames: [] }, h.env)).toHaveLength(1);
});

test("post-admission exception stays unknown and is never replayed", async () => {
  let calls = 0;
  const h = await host(async () => { calls++; throw new Error("response lost after commit"); });
  await h.hooks.get("context")!({ sessionID: ID });
  const [session] = listOpenCodeSessions(h.env);
  expect(await wakeOpenCodeSession(session!, "hello")).toMatchObject({ ok: false, reason: "unknown-outcome" });
  expect(calls).toBe(1);
});

test("rejects unsafe registrations and validates Windows pipe identity", async () => {
  const h = await host();
  await h.hooks.get("context")!({ sessionID: ID });
  const [s] = listOpenCodeSessions(h.env);
  const file = join(h.home, "opencode-sessions", `${ID}.${process.pid}.json`);
  if (process.platform !== "win32") {
    chmodSync(file, 0o644);
    expect(listOpenCodeSessions(h.env)).toEqual([]);
    chmodSync(file, 0o600);
  }
  writeFileSync(file, JSON.stringify({ ...s, pid: 2147483647 }));
  expect(listOpenCodeSessions(h.env)).toEqual([]);
  const hash = createHash("sha256").update(ID).digest("hex").slice(0, 24);
  const pipe = `\\\\.\\pipe\\ocs-opencode-${hash}-4242-${"ab".repeat(16)}`;
  expect(opencodeInboxPathValid(pipe, ID, 4242, {}, "win32")).toBe(true);
  expect(opencodeInboxPathValid(pipe, ID, 4243, {}, "win32")).toBe(false);
  expect(opencodeInboxPathValid(pipe, ID.toLowerCase(), 4242, {}, "win32")).toBe(false);
});

test("installer writes plugin and skill without editing other OpenCode configuration", () => {
  const home = makeTempDir("ocs-oc-install-");
  const env = { OPENCODE_CONFIG_DIR: join(home, "config") };
  mkdirSync(env.OPENCODE_CONFIG_DIR, { recursive: true });
  const config = join(env.OPENCODE_CONFIG_DIR, "opencode.jsonc");
  writeFileSync(config, "// my config\n{}");
  const installed = installOpenCodeIntegration("skill", env, home);
  expect(openCodePluginCurrent(env, home)).toBe(true);
  expect(installed.pluginPath).toBe(openCodePluginPath(env, home));
  expect(readFileSync(installed.skillPath, "utf8")).toBe("skill");
  expect(readFileSync(config, "utf8")).toBe("// my config\n{}");
});

test("real CLI: short address, batch, no-wake, mentions, reply and inbox share one identity", async () => {
  const admitted: Array<{ text: string }> = [];
  const h = await host(async (input) => { admitted.push(input); return input; });
  await h.hooks.get("context")!({ sessionID: ID });
  const env = {
    PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE,
    HOME: h.home, OCS_HOME: h.home, CODEX_HOME: join(h.home, "codex"),
    OCS_CLAUDE_NATIVE_SESSIONS_DIR: join(h.home, "claude"),
    OCS_NO_UPDATE_CHECK: "1", OCS_LANG: "en", OCS_NO_RECEIPTS: "1",
  };
  async function cli(args: string[], self = false) {
    const proc = Bun.spawn([process.execPath, join(import.meta.dir, "../src/cli.ts"), ...args], {
      env: { ...env, ...(self ? { OCS_OPENCODE_SESSION_ID: ID } : {}) }, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    return JSON.parse(out);
  }
  const who = await cli(["whoami", "--json"], true);
  expect(who).toMatchObject({ host: "opencode", sessionId: ID });
  expect(who.addresses).toContain(openCodeShortId(ID));
  const batch = join(h.home, "batch.json");
  writeFileSync(batch, JSON.stringify(["task one", "task two"]));
  const sent = await cli(["dm", openCodeShortId(ID), "--batch", batch, "--as", "peer", "--json"]);
  expect(sent.wake).toBe("accepted");
  expect(admitted).toHaveLength(1);
  expect(admitted[0]!.text).toContain("task one");
  expect(admitted[0]!.text).toContain("task two");
  const quiet = await cli(["dm", opencodeTargetName(ID), "quiet", "--no-wake", "--as", "peer", "--json"]);
  expect(quiet.wake).toBe("skipped");
  expect(admitted).toHaveLength(1);
  expect(await cli(["inbox", "--json"], true)).toMatchObject([{ channel: sent.channel, unread: 2 }]);
  await cli(["send", "mentions", `@${openCodeShortId(ID)} hello`, "--as", "peer", "--json"]);
  expect(admitted).toHaveLength(2);
  await cli(["send", sent.channel, "answer", "--reply-to", "1", "--no-wake", "--json"], true);
  // Replying to seq 1 leaves the later quiet message unread.
  expect(await cli(["inbox", "--json"], true)).toContainEqual(expect.objectContaining({ channel: sent.channel, unread: 1 }));
  await cli(["send", sent.channel, "follow up", "--as", "peer", "--reply-to", "3", "--json"]);
  expect(admitted).toHaveLength(3);
  await cli(["read", sent.channel, "--json"], true);
  expect((await cli(["inbox", "--json"], true)).some((t: { channel: string }) => t.channel === sent.channel)).toBe(false);
}, 20000);


test("plugin rejects a wrong token or session without invoking native admission", async () => {
  let calls = 0;
  const h = await host(async (input) => { calls++; return input; });
  await h.hooks.get("context")!({ sessionID: ID });
  const [session] = listOpenCodeSessions(h.env);
  for (const overrides of [{ token: "b".repeat(64) }, { session_id: "ses_wrong" }]) {
    const ack = await new Promise<string>((resolve, reject) => {
      const socket = connect(session!.socket_path);
      socket.setTimeout(2000, () => { socket.destroy(); reject(new Error("no rejection")); });
      socket.on("error", reject);
      socket.on("connect", () => socket.write(JSON.stringify({ v: 1, type: "wake", session_id: ID,
        token: session!.token, note: "hello", ...overrides }) + "\n"));
      socket.once("data", (data) => { socket.destroy(); resolve(data.toString()); });
    });
    expect(JSON.parse(ack)).toMatchObject({ ok: false });
  }
  expect(calls).toBe(0);
});
