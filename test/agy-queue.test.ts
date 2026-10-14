import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AgyQueue } from "../src/agy-queue.ts";
import { appendMessage } from "../src/store.ts";
import { agyEnvironment, parseAgyResult } from "../src/agy-worker.ts";
import { agyMessages } from "../src/i18n-agy.ts";
import { tempDir, autoCleanupTempDirs } from "./tmp";

autoCleanupTempDirs();
const queues: AgyQueue[] = [];
afterEach(() => { for (const queue of queues.splice(0)) queue.close(); });
function fixture() {
  const env = { OCS_HOME: tempDir("ocs-agy-q-") };
  const message = appendMessage({ channel: "test", from: "claude-test", body: "Review", env });
  const queue = new AgyQueue(env); queues.push(queue);
  return { env, queue, input: { channel: "test", seq: message.seq, note: "Review" } };
}

test("only committed messages are accepted; duplicate wakes never repeat a completed task", () => {
  const { queue, input } = fixture();
  const id = queue.submit(input);
  expect(queue.submit(input)).toBe(id);
  expect(queue.next()?.id).toBe(id);
  queue.complete(id, true, "done");
  expect(queue.beginReply(id)).toBe(true);
  queue.finishReply(id, 0);
  expect(queue.submit(input)).toBe(id);
  expect(queue.next()).toBeNull();
  expect(() => queue.submit({ ...input, seq: 999 })).toThrow("message missing");
});

test("execution is recorded before invoking agy, and crash recovery never runs it again", () => {
  const { queue, input } = fixture();
  const id = queue.submit(input);
  queue.next();
  queue.recover("outcome unknown");
  const recovered = queue.next()!;
  expect(recovered.state).toBe("interrupted");
  expect(recovered.response).toBe("outcome unknown");
  queue.complete(id, false, recovered.response!);
  queue.beginReply(id); queue.finishReply(id, 2);
  expect(queue.next()).toBeNull();
});

test("a response is resumed only before sending; an in-flight response is never replayed", () => {
  const { queue, input } = fixture();
  const id = queue.submit(input);
  queue.next(); queue.complete(id, true, "done");
  expect(queue.next()?.state).toBe("completed");
  queue.beginReply(id);
  queue.recover("unknown");
  expect(queue.next()).toBeNull();
});

test("queued tasks and per-channel conversation IDs survive reopening the database", () => {
  const { env, queue, input } = fixture();
  const id = queue.submit(input);
  queue.saveConversation("test", "11111111-1111-4111-8111-111111111111");
  const reopened = new AgyQueue(env); queues.push(reopened);
  expect(reopened.next()?.id).toBe(id);
  expect(reopened.conversation("test")).toBe("11111111-1111-4111-8111-111111111111");
  expect(reopened.conversation("other")).toBeNull();
});

test("two receiver processes cannot claim one queue", () => {
  const { queue } = fixture();
  queue.claim(process.pid, "a");
  expect(() => queue.claim(process.pid, "b")).toThrow("already running");
  queue.release("b");
  expect(() => queue.claim(process.pid, "b")).toThrow("already running");
  queue.release("a");
  expect(() => queue.claim(process.pid, "b")).not.toThrow();
});

test("private state directory and database refuse symlinks", () => {
  const home = tempDir("ocs-agy-link-");
  const elsewhere = tempDir("ocs-agy-target-");
  symlinkSync(elsewhere, join(home, "agy"));
  expect(() => new AgyQueue({ OCS_HOME: home })).toThrow("private");
  const other = tempDir("ocs-agy-db-");
  mkdirSync(join(other, "agy"), { mode: 0o700 });
  writeFileSync(join(other, "target"), "");
  symlinkSync(join(other, "target"), join(other, "agy", "jobs.sqlite3"));
  expect(() => new AgyQueue({ OCS_HOME: other })).toThrow("unsafe");
});

test("final JSON parsing ignores progress and refuses invalid conversation IDs", () => {
  const result = parseAgyResult('progress\n{"status":"SUCCESS","response":"完成","conversation_id":"unsafe --flag"}\n');
  expect(result.success).toBe(true);
  expect(result.response).toBe("完成");
  expect(result.conversation).toBeNull();
  expect(parseAgyResult("not JSON").success).toBe(false);
});

test("worker commands have their own identity without changing auth or permission settings", () => {
  const env = agyEnvironment({ CODEX_THREAD_ID: "other", CLAUDECODE: "1", OCS_NAME: "other", SSH_CONNECTION: "ssh",
    DBUS_SESSION_BUS_ADDRESS: "bus", ANTHROPIC_API_KEY: "existing", CODEX_HOME: "/custom/codex", CLAUDE_CONFIG_DIR: "/custom/claude" });
  expect(env.CODEX_THREAD_ID).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.OCS_NAME).toBe("agy");
  expect(env.DBUS_SESSION_BUS_ADDRESS).toBe("bus");
  expect(env.SSH_CONNECTION).toBe("ssh");
  expect(env.ANTHROPIC_API_KEY).toBe("existing");
  expect(env.CODEX_HOME).toBe("/custom/codex");
  expect(env.CLAUDE_CONFIG_DIR).toBe("/custom/claude");
  expect(Object.keys(agyMessages("en"))).toEqual(Object.keys(agyMessages("zh")));
});
