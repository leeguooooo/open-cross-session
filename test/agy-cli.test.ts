import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { findAgyWorker, wakeAgy } from "../src/agy.ts";
import { AGY_WORKER_COMMAND } from "../src/agy-worker.ts";
import { readMessages } from "../src/store.ts";
import { CLAUDE_NATIVE_SESSIONS_DIR_ENV } from "../src/claude-inject.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const FAKE = join(import.meta.dir, "fixtures", "agy-cli.ts");
const children: ReturnType<typeof Bun.spawn>[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) { child.kill("SIGTERM"); await child.exited; }
  for (const server of servers.splice(0)) server.close();
});
autoCleanupTempDirs();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function until<T>(read: () => T | null | false): Promise<T> {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null && value !== false) return value;
    await new Promise((wait) => setTimeout(wait, 20));
  }
  throw new Error("agy test condition not met");
}

async function fixture(delay = 0, withClaude = false) {
  const home = tempDir("ocs-agy-cli-");
  const binary = join(home, "fake-agy");
  const events = join(home, "events.jsonl");
  writeFileSync(binary, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(FAKE)} "$@"\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, OCS_HOME: home, OCS_NO_UPDATE_CHECK: "1", OCS_AGY_BIN: binary,
    OCS_AGY_TEST_LOG: events, OCS_AGY_TEST_DELAY: String(delay) };
  const frames: string[] = [];
  if (withClaude) {
    const peer = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
    children.push(peer);
    const sessions = join(home, "sessions");
    mkdirSync(sessions, { mode: 0o700 });
    const socketPath = join(home, "claude.sock");
    const server = createServer((socket) => {
      let frame = "";
      socket.on("data", (chunk) => { frame += chunk.toString("utf8"); });
      socket.on("end", () => { if (frame !== "") frames.push(frame); });
    });
    servers.push(server);
    await new Promise<void>((ready) => server.listen(socketPath, ready));
    chmodSync(socketPath, 0o600);
    writeFileSync(join(sessions, `${peer.pid}.json`), JSON.stringify({ pid: peer.pid,
      sessionId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", name: "reviewer", cwd: home, status: "idle", messagingSocketPath: socketPath }), { mode: 0o600 });
    env[CLAUDE_NATIVE_SESSIONS_DIR_ENV] = sessions;
  }
  const child = Bun.spawn([process.execPath, CLI, AGY_WORKER_COMMAND, "--cwd", home], { env, stdout: "ignore", stderr: "pipe" });
  children.push(child);
  try { await until(() => findAgyWorker(env)); }
  catch (error) {
    child.kill("SIGTERM"); await child.exited;
    throw new Error(`${String(error)}: ${await new Response(child.stderr).text()}`);
  }
  const run = async (args: string[]) => {
    const cli = Bun.spawn([process.execPath, CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
    const output = await new Response(cli.stdout).text();
    const error = await new Response(cli.stderr).text();
    return { output, error, code: await cli.exited };
  };
  const messages = (channel: string) => readMessages(channel, { env });
  return { home, env, events, run, messages, frames };
}

test("real CLI: DM, automatic reply, duplicate suppression and per-channel resume", async () => {
  const f = await fixture();
  const status = await f.run(["agy", "status", "--json"]);
  expect(status.output).not.toContain("token");
  expect(JSON.parse(status.output).target).toBe("agy");
  const sent = await f.run(["dm", "agy", "Review this code", "--as", "tester"]);
  expect(sent.code).toBe(0);
  expect(sent.output).toContain("durable task queue");
  const channel = /channel (dm-[a-z0-9_-]+)/.exec(sent.output)![1]!;
  await until(() => f.messages(channel).find((message) => message.from === "agy") ?? null);
  expect(f.messages(channel)[1]?.reply_to).toBe(1);
  expect(f.messages(channel)[1]?.body).toBe("FAKE_AGY_OK");
  await wakeAgy({ channel, seq: 1, note: "repeat wake" }, f.env);
  await f.run(["dm", "agy", "Continue the review", "--as", "tester"]);
  await until(() => f.messages(channel).filter((message) => message.from === "agy").length === 2 || false);
  const turns = readFileSync(f.events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(turns).toHaveLength(2);
  expect(turns[1].args).toContain("--conversation");
  expect(turns[1].args).toContain("11111111-1111-4111-8111-111111111111");
  expect(turns[0].identity).toBe("agy");
  expect(turns[0].codex).toBeNull();
  expect(turns[0].claude).toBeNull();
  const who = JSON.parse((await f.run(["who", "--json"])).output);
  expect(who.entries.find((entry: { kind: string }) => entry.kind === "agy").target).toBe("agy");
}, 30000);

test("real CLI: mentions queue behind an active turn and only start a second turn after it ends", async () => {
  const f = await fixture(700);
  const first = await f.run(["send", "team", "Task one @agy", "--as", "tester"]);
  expect(first.code).toBe(0);
  await until(() => findAgyWorker(f.env)?.status === "working" || false);
  const second = await f.run(["send", "team", "Task two @AGY", "--as", "tester"]);
  expect(second.code).toBe(0);
  await until(() => f.messages("team").filter((message) => message.from === "agy").length === 2 || false);
  expect(readFileSync(f.events, "utf8").trim().split("\n")).toHaveLength(2);
}, 30000);

test("real CLI: start/status/stop leaves no receiver and rejects invalid options", async () => {
  const f = await fixture();
  expect((await f.run(["agy", "start", "--cwd", f.home])).code).toBe(0);
  expect((await f.run(["agy", "start", "--timeout", "0"])).code).toBe(1);
  expect((await f.run(["agy", "status", "--cwd", f.home])).code).toBe(1);
  expect((await f.run(["agy", "stop"])).code).toBe(0);
  expect(findAgyWorker(f.env)).toBeNull();
  expect(JSON.parse((await f.run(["agy", "status", "--json"])).output)).toBeNull();
}, 30000);

test("real CLI: an automatic reply wakes a Claude author using its short address", async () => {
  const f = await fixture(0, true);
  const sent = await f.run(["dm", "agy", "Review and reply", "--as", "claude-aaaaaaaa"]);
  expect(sent.code).toBe(0);
  const frame = await until(() => f.frames[0] ?? null);
  expect(frame).toContain("FAKE_AGY_OK");
  expect(frame).toContain("agy");
}, 30000);


test("explicit batch makes one agy invocation and one automatic result", async () => {
  const f = await fixture();
  const path = join(f.home, "tasks.json");
  writeFileSync(path, JSON.stringify(["Inspect config", "Inspect tests", "Report combined findings"]));
  const sent = await f.run(["dm", "agy", "--batch", path, "--as", "tester", "--json"]);
  expect(sent.code).toBe(0);
  const { channel } = JSON.parse(sent.output);
  await until(() => f.messages(channel).find((message) => message.from === "agy") ?? null);
  const events = readFileSync(f.events, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events.length).toBe(1);
  const prompt = events[0].args[events[0].args.indexOf("-p") + 1];
  for (const item of ["Inspect config", "Inspect tests", "Report combined findings"]) expect(prompt).toContain(item);
  expect(f.messages(channel).length).toBe(2);
}, 30000);
