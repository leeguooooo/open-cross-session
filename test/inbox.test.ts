import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inboxCursorState,
  listInboxThreads,
  saveInboxCursor,
  type InboxIdentityContext,
} from "../src/inbox.ts";
import { appendMessage, readRoutedMessages, saveCursor } from "../src/store.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const ALICE = `workspace:${"a".repeat(64)}`;
const BOB = `workspace:${"b".repeat(64)}`;
const MALLORY = `workspace:${"c".repeat(64)}`;

function fixture(): { env: NodeJS.ProcessEnv; bob: InboxIdentityContext } {
  const home = tempDir("ocs-inbox-");
  return {
    env: { OCS_HOME: home },
    bob: {
      primaryName: "bob-new",
      identities: ["name:bob-new", BOB],
      mentionNames: ["bob-new", "bob-workspace"],
    },
  };
}

describe("lightweight inbox", () => {
  test("只列显式投给当前稳定身份的 DM，不猜测或泄露别人的私信", () => {
    const { env, bob } = fixture();
    appendMessage({
      channel: "dm-alice-bob",
      from: "alice-old",
      from_identity: ALICE,
      to_identity: BOB,
      body: "for bob",
      env,
    });
    appendMessage({
      channel: "dm-alice-mallory",
      from: "alice-old",
      from_identity: ALICE,
      to_identity: MALLORY,
      body: "private for mallory",
      env,
    });
    appendMessage({
      channel: "dm-legacy-unknown",
      from: "someone",
      body: "old DM with no ownership evidence",
      env,
    });

    expect(listInboxThreads(bob, env)).toEqual([expect.objectContaining({
      channel: "dm-alice-bob",
      unread: 1,
      lastFrom: "alice-old",
    })]);
  });

  test("稳定身份 cursor 跨会话改名续用，且自己的消息不算未读", () => {
    const { env, bob } = fixture();
    appendMessage({
      channel: "dm-thread",
      from: "alice-old",
      from_identity: ALICE,
      to_identity: BOB,
      body: "first",
      env,
    });
    appendMessage({
      channel: "dm-thread",
      from: "bob-old",
      from_identity: BOB,
      to_identity: ALICE,
      body: "my reply before restart",
      env,
    });
    const messages = readRoutedMessages("dm-thread", { env });
    const firstState = inboxCursorState("dm-thread", messages, bob, env);
    saveInboxCursor("dm-thread", firstState.consumers, 2, env);

    appendMessage({
      channel: "dm-thread",
      from: "alice-new",
      from_identity: ALICE,
      to_identity: BOB,
      body: "after restart",
      env,
    });
    const restarted = { ...bob, primaryName: "bob-newer", mentionNames: ["bob-newer"] };
    expect(listInboxThreads(restarted, env)).toEqual([expect.objectContaining({
      channel: "dm-thread",
      unread: 1,
      lastSeq: 3,
    })]);
  });

  test("普通频道只在已有 cursor 或被明确提及时进入 inbox", () => {
    const { env, bob } = fixture();
    appendMessage({ channel: "dev", from: "alice", body: "hello @bob-workspace", env });
    appendMessage({ channel: "random", from: "alice", body: "not for bob", env });
    appendMessage({ channel: "joined", from: "alice", body: "old", env });
    saveCursor("joined", bob.primaryName, 1, env);
    appendMessage({ channel: "joined", from: "alice", body: "new update", env });

    expect(listInboxThreads(bob, env).map((thread) => [thread.channel, thread.unread]).sort())
      .toEqual([["dev", 1], ["joined", 1]]);
  });
});
