import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findAgyWorker } from "../src/agy.ts";
import { readMessages } from "../src/store.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

autoCleanupTempDirs();
const windowsTest = process.platform === "win32" ? test : test.skip;
const receivers: NodeJS.ProcessEnv[] = [];
const CLI = process.env.OCS_TEST_BINARY!;
async function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  const proc = Bun.spawn([CLI, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  return { output, error, code };
}
afterEach(async () => {
  for (const env of receivers.splice(0)) await run(env, "agy", "stop");
});
async function until<T>(read: () => T | null): Promise<T> {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== null) return value;
    await Bun.sleep(50);
  }
  throw new Error("Windows agy smoke condition timed out");
}
async function fixture(extra: NodeJS.ProcessEnv = {}) {
  expect(CLI).toBeTruthy();
  expect(process.env.OCS_TEST_AGY_BINARY).toBeTruthy();
  const home = tempDir("ocs-agy-win-");
  const env = { ...process.env, OCS_HOME: home, OCS_NAME: "tester", OCS_LANG: "en", OCS_NO_UPDATE_CHECK: "1",
    OCS_AGY_BIN: process.env.OCS_TEST_AGY_BINARY, OCS_AGY_TEST_LOG: join(home, "events.jsonl"), ...extra };
  receivers.push(env);
  const started = await run(env, "agy", "start", "--cwd", home);
  expect(started.error).toBe("");
  expect(started.code).toBe(0);
  expect(findAgyWorker(env)?.socketPath).toMatch(/^\\\\\.\\pipe\\ocs-agy-/);
  return { home, env };
}

windowsTest("compiled Windows receiver: queue, Unicode, reply, channel resume and graceful stop", async () => {
  const { home, env } = await fixture();
  const send = await run(env, "dm", "agy", "检查中文任务", "--as", "tester", "--json");
  expect(send.code).toBe(0);
  const { channel } = JSON.parse(send.output);
  const replies = () => readMessages(channel, { env }).filter((m) => m.from === "agy");
  await until(() => replies().length === 1 ? true : null);
  expect(replies()[0]?.body).toBe("FAKE_AGY_OK");
  expect(replies()[0]?.reply_to).toBe(1);
  expect((await run(env, "dm", "agy", "Continue", "--as", "tester")).code).toBe(0);
  await until(() => replies().length === 2 ? true : null);
  const events = readFileSync(env.OCS_AGY_TEST_LOG!, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  expect(events).toHaveLength(2);
  expect(events[0].args.join(" ")).toContain("检查中文任务");
  expect(events[1].args).toContain("--conversation");
  expect(events[0].identity).toBe("agy");
  expect(JSON.parse((await run(env, "agy", "status", "--json")).output).target).toBe("agy");
  expect((await run(env, "agy", "stop")).code).toBe(0);
  expect(findAgyWorker(env)).toBeNull();
  expect(existsSync(join(home, "agy", "worker.json"))).toBe(false);
}, 60000);

windowsTest("Windows long replies fit CreateProcess and retain the full result in a file", async () => {
  const { env } = await fixture({ OCS_AGY_TEST_LARGE: "1" });
  const send = await run(env, "dm", "agy", "Large reply", "--as", "tester", "--json");
  expect(send.code).toBe(0);
  const { channel } = JSON.parse(send.output);
  const reply = await until(() => readMessages(channel, { env }).find((m) => m.from === "agy") ?? null);
  expect(Buffer.byteLength(reply.body)).toBeLessThan(12000);
  const path = reply.body.split("Full result: ")[1]!;
  expect(readFileSync(path, "utf8")).toBe("结果".repeat(20000));
}, 45000);

windowsTest("Windows stop during a task kills the child and restart never replays it", async () => {
  const { home, env } = await fixture({ OCS_AGY_TEST_DELAY: "60000" });
  expect((await run(env, "dm", "agy", "Long task", "--as", "tester")).code).toBe(0);
  const event = await until(() => {
    try { return JSON.parse(readFileSync(env.OCS_AGY_TEST_LOG!, "utf8").trim()); } catch { return null; }
  });
  expect((await run(env, "agy", "stop")).code).toBe(0);
  expect(() => process.kill(event.pid, 0)).toThrow();
  expect((await run(env, "agy", "start", "--cwd", home)).code).toBe(0);
  await Bun.sleep(300);
  expect(readFileSync(env.OCS_AGY_TEST_LOG!, "utf8").trim().split("\n")).toHaveLength(1);
}, 45000);
