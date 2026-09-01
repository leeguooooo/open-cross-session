import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendMessage,
  extractMentions,
  isOcsMessage,
  lastSeq,
  loadCursor,
  readMessages,
  saveCursor,
  OCS_HOME_ENV,
} from "../src/store.ts";

function freshEnv(): NodeJS.ProcessEnv {
  return { [OCS_HOME_ENV]: mkdtempSync(join(tmpdir(), "ocs-store-")) };
}

describe("appendMessage / readMessages", () => {
  test("seq 从 1 单调递增，读回顺序与内容一致", () => {
    const env = freshEnv();
    const a = appendMessage({ channel: "dev", from: "alice", body: "hello @bob", env });
    const b = appendMessage({ channel: "dev", from: "bob", body: "hi", reply_to: a.seq, env });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.reply_to).toBe(1);
    const all = readMessages("dev", { env });
    expect(all.map((m) => m.seq)).toEqual([1, 2]);
    expect(all[0]!.mentions).toEqual(["bob"]);
  });

  test("since 过滤 + 坏行/异构行跳过而不毒化频道", () => {
    const env = freshEnv();
    appendMessage({ channel: "dev", from: "a", body: "one", env });
    appendMessage({ channel: "dev", from: "a", body: "two", env });
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    const { channelLogPath } = require("../src/store.ts") as typeof import("../src/store.ts");
    appendFileSync(channelLogPath("dev", env), "not-json\n{\"v\":99}\n");
    appendMessage({ channel: "dev", from: "a", body: "three", env });
    expect(readMessages("dev", { since: 1, env }).map((m) => m.body)).toEqual(["two", "three"]);
  });

  test("频道隔离；非法频道名/发送者名拒绝", () => {
    const env = freshEnv();
    appendMessage({ channel: "one", from: "a", body: "x", env });
    expect(readMessages("two", { env })).toEqual([]);
    expect(() => appendMessage({ channel: "Bad Channel!", from: "a", body: "x", env })).toThrow();
    expect(() => appendMessage({ channel: "ok", from: "bad name", body: "x", env })).toThrow();
  });

  test("并发 append 不丢序（同进程模拟多写者交错）", () => {
    const env = freshEnv();
    for (let i = 0; i < 50; i++) {
      appendMessage({ channel: "busy", from: "w1", body: `m${i}`, env });
    }
    const seqs = readMessages("busy", { env }).map((m) => m.seq);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(lastSeq("busy", env)).toBe(50);
  });
});

describe("isOcsMessage 镜像铁律（上游 #622 教训）", () => {
  test("写入方产出的每条消息必须通过校验", () => {
    const env = freshEnv();
    const plain = appendMessage({ channel: "m", from: "a", body: "x @b", env });
    const withReply = appendMessage({ channel: "m", from: "a", body: "y", reply_to: 1, env });
    // 经 JSON 往返（即读侧看到的形状）逐条校验
    expect(isOcsMessage(JSON.parse(JSON.stringify(plain)))).toBe(true);
    expect(isOcsMessage(JSON.parse(JSON.stringify(withReply)))).toBe(true);
  });

  test("未知字段拒绝（校验表与字段表逐字镜像，多一个字段就红）", () => {
    const env = freshEnv();
    const m = JSON.parse(JSON.stringify(appendMessage({ channel: "m", from: "a", body: "x", env })));
    expect(isOcsMessage({ ...m, sneaky: 1 })).toBe(false);
  });
});

describe("extractMentions", () => {
  test("去重、允许 . _ -，忽略非法字符后缀", () => {
    expect(extractMentions("hi @bob @bob @al.ice-1 email a@b")).toEqual(["bob", "al.ice-1", "b"]);
    expect(extractMentions("no mentions")).toEqual([]);
  });
});

describe("seq 单一真值源 = 日志（review 修复回归）", () => {
  test("日志被外部写入更高 seq 后，分配从日志尾继续，绝不复用", () => {
    const env = freshEnv();
    appendMessage({ channel: "dev", from: "a", body: "one", env });
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    const { channelLogPath } = require("../src/store.ts") as typeof import("../src/store.ts");
    // 模拟另一写入者（或崩溃残留）：日志里已有 seq 5
    appendFileSync(
      channelLogPath("dev", env),
      `${JSON.stringify({ v: 1, seq: 5, ts: "2026-01-01T00:00:00Z", from: "x", body: "oob", mentions: [] })}\n`,
    );
    const next = appendMessage({ channel: "dev", from: "a", body: "two", env });
    expect(next.seq).toBe(6);
    // 全部可读，无遮蔽
    expect(readMessages("dev", { env }).map((m) => m.seq)).toEqual([1, 5, 6]);
  });

  test("死持有者的陈锁被安全抢占（rename 认领）", () => {
    const env = freshEnv();
    const fs = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { ocsHome } = require("../src/store.ts") as typeof import("../src/store.ts");
    const dir = join(ocsHome(env), "channels");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "dev.lock");
    fs.writeFileSync(lockPath, "999999999"); // 不存在的 pid → ESRCH
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old); // 锁龄过门槛
    const m = appendMessage({ channel: "dev", from: "a", body: "through", env });
    expect(m.seq).toBe(1);
  });

  test("活持有者的锁不可抢，等待方超时报错", () => {
    const env = { ...freshEnv(), OCS_LOCK_TIMEOUT_MS: "200" };
    const fs = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { ocsHome } = require("../src/store.ts") as typeof import("../src/store.ts");
    const dir = join(ocsHome(env), "channels");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "dev.lock");
    fs.writeFileSync(lockPath, String(process.pid)); // 自己＝活着的持有者
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old); // 就算锁很老，pid 活着也不许抢
    expect(() => appendMessage({ channel: "dev", from: "a", body: "x", env })).toThrow(
      /lock timeout/,
    );
  });
});

describe("cursor", () => {
  test("首读为 0；推进只进不退；消费者互不影响", () => {
    const env = freshEnv();
    expect(loadCursor("c", "alice", env)).toBe(0);
    saveCursor("c", "alice", 5, env);
    saveCursor("c", "alice", 3, env);
    expect(loadCursor("c", "alice", env)).toBe(5);
    expect(loadCursor("c", "bob", env)).toBe(0);
  });
});
