// 「已读」证据只来自宿主自己的会话记录（src/seen-wakes.ts，docs/wake-protocol.md §7）。
// 改之前先跑一遍并做变异自检：把下面「守着」的检查改成 if (false)，对应用例必须变红。
import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inboxCursorState, listInboxThreads, type InboxIdentityContext } from "../src/inbox.ts";
import {
  CLAUDE_PROJECTS_DIR_ENV,
  parseSeenWake,
  PI_AGENT_SESSIONS_DIR_ENV,
  seenKey,
  seenWakes,
  seenWakesInLines,
  sessionRecordPath,
} from "../src/seen-wakes.ts";
import { appendMessage, readRoutedMessages } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const SESSION = "3b6c34fc-dc15-4272-949b-72b5c2c0b945";
const note = (seq: number, channel = "dm-x", extra = "") =>
  `[ocs wake] alice mentioned you in #${channel} (seq ${seq}${extra})\n\nbody ${seq}\n\nReply: ocs dm alice "<your reply>"`;
const wrapped = (text: string) => `<cross-session-message from="uds:/tmp/cc-socks/1.sock" from-name="alice" from-mode="prompting">\n${text}\n</cross-session-message>`;

describe("parseSeenWake", () => {
  test("accepts an inline note, English or Chinese, with an ocs wrapper and Claude's preamble", () => {
    expect(parseSeenWake(note(3), { allowWrapper: false })).toEqual({ channel: "dm-x", seq: 3 });
    expect(parseSeenWake("[ocs 唤醒] alice 在 #dm-y 提到了你（seq 9，回复 seq 2）\n\n正文", { allowWrapper: false })).toEqual({ channel: "dm-y", seq: 9 });
    expect(parseSeenWake("[ocs wake] New mention in #c (seq 4)\n\nx", { allowWrapper: false })).toEqual({ channel: "c", seq: 4 });
    expect(parseSeenWake(wrapped(note(5)), { allowWrapper: true })).toEqual({ channel: "dm-x", seq: 5 });
    expect(parseSeenWake(`Another Claude session sent a message:\n${wrapped(note(6))}`, { allowWrapper: true })).toEqual({ channel: "dm-x", seq: 6 });
    expect(parseSeenWake(`<channel source="ocs" from="alice" channel="dm-x" seq="7">\n${note(7)}`, { allowWrapper: true })).toEqual({ channel: "dm-x", seq: 7 });
    // 合并唤醒只证明它自己那条
    expect(parseSeenWake(note(8, "dm-x", ", plus 2 earlier unread from seq 6 — read the thread first"), { allowWrapper: false })).toEqual({ channel: "dm-x", seq: 8 });
  });

  test("rejects quoted headers, wrappers where none are allowed, and truncated previews", () => {
    expect(parseSeenWake(`see this: ${note(3)}`, { allowWrapper: false })).toBeNull();
    expect(parseSeenWake(`> ${note(3)}`, { allowWrapper: false })).toBeNull();
    expect(parseSeenWake(wrapped(note(3)), { allowWrapper: false })).toBeNull();
    expect(parseSeenWake(`two\nlines\n${wrapped(note(3))}`, { allowWrapper: true })).toBeNull();
    // 守着：正文被截成预览，对方只看到了前 512B，不算已读
    expect(parseSeenWake("[ocs wake] alice mentioned you in #dm-x (seq 3)\n\nprefix\n… (9000 bytes total; full text: ocs read dm-x)\n\nReply: x", { allowWrapper: false })).toBeNull();
  });
});

describe("seenWakesInLines", () => {
  const line = (value: unknown) => JSON.stringify(value);

  test("Claude: only queued_command attachments and user string turns count — not enqueue, tool output or replies", () => {
    const lines = [
      line({ type: "queue-operation", operation: "enqueue", content: wrapped(note(1)) }), // 守着：被扣留的只有 enqueue
      line({ type: "attachment", attachment: { type: "queued_command", prompt: wrapped(note(2)) } }),
      line({ type: "user", message: { role: "user", content: `<channel source="ocs" channel="dm-x" seq="3">\n${note(3)}` } }),
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: note(4) }] } }),
      line({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: note(5) }] } }),
      "not json [ocs wake]",
    ];
    expect([...seenWakesInLines("claude", lines)].sort()).toEqual([seenKey("dm-x", 2), seenKey("dm-x", 3)]);
  });

  test("Codex: user response items count; agent messages and events do not", () => {
    const lines = [
      line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: note(1) }] } }),
      line({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: note(2) }] } }),
      // 守着：developer / 系统注入的说明里引用了首行，也不是对方发来的消息
      line({ type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: note(4) }] } }),
      line({ type: "event_msg", payload: { type: "item_completed", item: { content: [{ type: "text", text: note(3) }] } } }),
    ];
    expect([...seenWakesInLines("codex", lines)]).toEqual([seenKey("dm-x", 1)]);
  });

  test("Pi: user messages count; tool results do not", () => {
    const lines = [
      line({ type: "message", message: { role: "user", content: [{ type: "text", text: note(1) }] } }),
      line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: note(2) }] } }),
    ];
    expect([...seenWakesInLines("pi", lines)]).toEqual([seenKey("dm-x", 1)]);
  });
});

describe("session record lookup", () => {
  test("finds the session's own file and refuses symlinks", () => {
    const root = tempDir("ocs-seen-");
    const projects = join(root, "projects");
    mkdirSync(join(projects, "-repo"), { recursive: true });
    const env = { ...process.env, [CLAUDE_PROJECTS_DIR_ENV]: projects, [PI_AGENT_SESSIONS_DIR_ENV]: join(root, "pi") };
    const transcript = join(projects, "-repo", `${SESSION}.jsonl`);
    writeFileSync(transcript, JSON.stringify({ type: "attachment", attachment: { type: "queued_command", prompt: wrapped(note(2)) } }) + "\n");
    expect(sessionRecordPath({ kind: "claude", sessionId: SESSION }, env)).toBe(transcript);
    expect([...seenWakes({ kind: "claude", sessionId: SESSION }, env)]).toEqual([seenKey("dm-x", 2)]);
    // 守着：符号链接不信（指向别人的记录就能伪造已读）
    const other = "11111111-2222-4333-8444-555555555555";
    symlinkSync(transcript, join(projects, "-repo", `${other}.jsonl`));
    expect(sessionRecordPath({ kind: "claude", sessionId: other }, env)).toBeNull();
    expect(sessionRecordPath({ kind: "claude", sessionId: "../../etc/passwd" }, env)).toBeNull();
    mkdirSync(join(root, "pi", "--repo--"), { recursive: true });
    const piFile = join(root, "pi", "--repo--", `2026-11-06T00-00-00-000Z_${SESSION}.jsonl`);
    writeFileSync(piFile, "");
    expect(sessionRecordPath({ kind: "pi", sessionId: SESSION.toUpperCase() }, env)).toBe(piFile);
    expect(seenWakes(null, env).size).toBe(0);
  });
});

describe("inbox with seen evidence", () => {
  const ALICE = `workspace:${"a".repeat(64)}`;
  const BOB = `workspace:${"b".repeat(64)}`;
  const base = (): { env: NodeJS.ProcessEnv; bob: InboxIdentityContext } => ({
    env: { OCS_HOME: tempDir("ocs-seen-inbox-") },
    bob: { primaryName: "bob", identities: ["name:bob", BOB], mentionNames: ["bob"] },
  });
  const fromAlice = (env: NodeJS.ProcessEnv, body: string) =>
    appendMessage({ channel: "dm-ab", from: "alice", from_identity: ALICE, to_identity: BOB, body, env });

  test("seen wakes are not unread, and the cursor moves only over the seen prefix", () => {
    const { env, bob } = base();
    for (const body of ["one", "two", "three", "four"]) fromAlice(env, body);
    // 1、2 看过，3 没看过（比如被扣留），4 看过
    const seen = new Set([seenKey("dm-ab", 1), seenKey("dm-ab", 2), seenKey("dm-ab", 4)]);
    const threads = listInboxThreads({ ...bob, seen }, env);
    expect(threads).toEqual([expect.objectContaining({ channel: "dm-ab", unread: 1, lastSeq: 3 })]);
    // 守着：游标停在没看过的 3 前面，不能跳到 4
    expect(inboxCursorState("dm-ab", readRoutedMessages("dm-ab", { env }), bob, env).cursor).toBe(2);
    // 证据滚出了记录尾部窗口：已落盘的游标仍然记得 1、2
    expect(listInboxThreads(bob, env)).toEqual([expect.objectContaining({ unread: 2 })]);
  });

  test("without evidence nothing changes and no cursor is written", () => {
    const { env, bob } = base();
    fromAlice(env, "one");
    expect(listInboxThreads({ ...bob, seen: new Set() }, env)).toEqual([expect.objectContaining({ unread: 1 })]);
    expect(listInboxThreads({ ...bob, seen: new Set([seenKey("dm-other", 1)]) }, env)).toEqual([expect.objectContaining({ unread: 1 })]);
    expect(inboxCursorState("dm-ab", readRoutedMessages("dm-ab", { env }), bob, env).cursor).toBe(0);
  });

  test("evidence for another channel never writes a cursor here (a cursor would mean joining it)", () => {
    const { env, bob } = base();
    appendMessage({ channel: "general", from: "carol", body: "not for bob", env });
    listInboxThreads({ ...bob, seen: new Set([seenKey("dm-elsewhere", 1)]) }, env);
    expect(inboxCursorState("general", readRoutedMessages("general", { env }), bob, env).cursor).toBe(0);
  });
});
