import { describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();
import {
  appendDmMessage,
  appendMessage,
  extractMentions,
  isOcsMessage,
  lastSeq,
  loadCursor,
  readMessages,
  readRoutedMessages,
  saveCursor,
  OCS_HOME_ENV,
} from "../src/store.ts";

function freshEnv(): NodeJS.ProcessEnv {
  return { [OCS_HOME_ENV]: tempDir("ocs-store-") };
}

describe("stable DM channel bindings (#10)", () => {
  test("显式继承旧频道后续写原 seq，后续不带 --inherit 也继续用同一频道", () => {
    const env = freshEnv();
    appendMessage({ channel: "dm-old-history", from: "alice-aa", body: "one", env });
    appendMessage({ channel: "dm-old-history", from: "bob-bb", body: "two", env });
    const inherited = appendDmMessage({
      stableChannel: "dm-stable-pair",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-history",
      expectedLegacyAliases: ["alice", "bob"],
      from: "alice-new",
      body: "three",
      env,
    });
    expect(inherited).toMatchObject({ channel: "dm-old-history", bindingCreated: true });
    expect(inherited.message.seq).toBe(3);

    const continued = appendDmMessage({
      stableChannel: "dm-stable-pair",
      fallbackChannel: "dm-fallback",
      from: "bob-new",
      body: "four",
      env,
    });
    expect(continued).toMatchObject({ channel: "dm-old-history", bindingCreated: false });
    expect(continued.message.seq).toBe(4);
    expect(readMessages("dm-old-history", { env }).map((message) => message.body))
      .toEqual(["one", "two", "three", "four"]);
    expect(readMessages("dm-stable-pair", { env })).toEqual([]);
  });

  test("稳定新频道已有消息时非破坏性合并，已落盘绑定不得改指", () => {
    const env = freshEnv();
    appendMessage({ channel: "dm-old-a", from: "a-aa", body: "old a", env });
    appendMessage({ channel: "dm-old-a", from: "b-bb", body: "old b", env });
    appendMessage({ channel: "dm-old-b", from: "a-cc", body: "old a2", env });
    appendMessage({ channel: "dm-old-b", from: "b-dd", body: "old b2", env });
    appendMessage({
      channel: "dm-stable-used",
      from: "a-ee",
      from_identity: "name:a-ee",
      to_identity: "name:b-ff",
      body: "new a",
      env,
    });
    appendMessage({
      channel: "dm-stable-used",
      from: "b-ff",
      from_identity: "name:b-ff",
      to_identity: "name:a-ee",
      body: "new b",
      reply_to: 1,
      env,
    });
    const merged = appendDmMessage({
      stableChannel: "dm-stable-used",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-a",
      expectedLegacyAliases: ["a", "b"],
      from: "a-new",
      body: "after merge",
      env,
    });
    expect(merged.channel).toMatch(/^dm-[0-9a-f]{40}--merged-history$/);
    expect(merged.message.seq).toBe(5);
    const mergedMessages = readMessages(merged.channel, { env });
    expect(mergedMessages.map((message) => message.body))
      .toEqual(["old a", "old b", "new a", "new b", "after merge"]);
    expect(mergedMessages[3]!.reply_to).toBe(3);
    expect(readRoutedMessages(merged.channel, { env }).slice(2, 4)).toMatchObject([
      { from_identity: "name:a-ee", to_identity: "name:b-ff" },
      { from_identity: "name:b-ff", to_identity: "name:a-ee" },
    ]);
    expect(readMessages("dm-old-a", { env }).map((message) => message.body)).toEqual(["old a", "old b"]);
    expect(readMessages("dm-stable-used", { env }).map((message) => message.body)).toEqual(["new a", "new b"]);

    appendDmMessage({
      stableChannel: "dm-stable-bound",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-a",
      expectedLegacyAliases: ["a", "b"],
      from: "a",
      body: "bind",
      env,
    });
    expect(() => appendDmMessage({
      stableChannel: "dm-stable-bound",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-b",
      expectedLegacyAliases: ["a", "b"],
      from: "a",
      body: "must fail",
      env,
    })).toThrow("already bound");
  });

  test("没有稳定 workspace pair 时不允许 --inherit", () => {
    const env = freshEnv();
    appendMessage({ channel: "dm-old", from: "a", body: "old", env });
    expect(() => appendDmMessage({
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old",
      from: "a",
      body: "no",
      env,
    })).toThrow("uniquely addressable");
  });

  test("旧频道缺一方发言或包含第三个参与者时拒绝绑定", () => {
    const env = freshEnv();
    appendMessage({ channel: "dm-one-sided", from: "alice-aa", body: "only me", env });
    expect(() => appendDmMessage({
      stableChannel: "dm-stable-one-sided",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-one-sided",
      expectedLegacyAliases: ["alice", "bob"],
      from: "alice-new",
      body: "no",
      env,
    })).toThrow("no messages from workspace bob");

    appendMessage({ channel: "dm-three-people", from: "alice-aa", body: "a", env });
    appendMessage({ channel: "dm-three-people", from: "bob-bb", body: "b", env });
    appendMessage({ channel: "dm-three-people", from: "mallory-cc", body: "m", env });
    expect(() => appendDmMessage({
      stableChannel: "dm-stable-three",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-three-people",
      expectedLegacyAliases: ["alice", "bob"],
      from: "alice-new",
      body: "no",
      env,
    })).toThrow("unexpected participants: mallory-cc");
  });

  test("合并快照落盘但绑定丢失后，源频道增长仍可重试，不会永久冲突", () => {
    const env = freshEnv();
    appendMessage({ channel: "dm-old-crash", from: "a-aa", body: "old a", env });
    appendMessage({ channel: "dm-old-crash", from: "b-bb", body: "old b", env });
    appendMessage({ channel: "dm-stable-crash", from: "a-cc", body: "new a", env });
    const first = appendDmMessage({
      stableChannel: "dm-stable-crash",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-crash",
      expectedLegacyAliases: ["a", "b"],
      from: "a-dd",
      body: "first command",
      env,
    });
    const binding = join(env[OCS_HOME_ENV]!, "dm-bindings", "dm-stable-crash.json");
    unlinkSync(binding);
    appendMessage({ channel: "dm-stable-crash", from: "b-ee", body: "new b", env });
    const retried = appendDmMessage({
      stableChannel: "dm-stable-crash",
      fallbackChannel: "dm-fallback",
      inheritChannel: "dm-old-crash",
      expectedLegacyAliases: ["a", "b"],
      from: "a-ff",
      body: "retry command",
      env,
    });
    expect(retried.channel).not.toBe(first.channel);
    expect(readMessages(retried.channel, { env }).map((message) => message.body))
      .toEqual(["old a", "old b", "new a", "new b", "retry command"]);
  });
});

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
    const withIdentities = appendMessage({
      channel: "m",
      from: "a",
      from_identity: "name:a",
      to_identity: "name:b",
      body: "z",
      env,
    });
    // 经 JSON 往返（即读侧看到的形状）逐条校验
    expect(isOcsMessage(JSON.parse(JSON.stringify(plain)))).toBe(true);
    expect(isOcsMessage(JSON.parse(JSON.stringify(withReply)))).toBe(true);
    expect(isOcsMessage(JSON.parse(JSON.stringify(withIdentities)))).toBe(true);
    expect(readMessages("m", { env })[2]).toEqual(withIdentities);
    expect(readRoutedMessages("m", { env })[2]).toMatchObject({
      from_identity: "name:a",
      to_identity: "name:b",
    });
  });

  test("未知字段拒绝（校验表与字段表逐字镜像，多一个字段就红）", () => {
    const env = freshEnv();
    const m = JSON.parse(JSON.stringify(appendMessage({ channel: "m", from: "a", body: "x", env })));
    expect(isOcsMessage({ ...m, sneaky: 1 })).toBe(false);
  });

  test("DM 身份必须使用受支持的完整命名空间格式", () => {
    const env = freshEnv();
    expect(() => appendMessage({
      channel: "m",
      from: "a",
      from_identity: "workspace:not-a-hmac",
      to_identity: "name:b",
      body: "x",
      env,
    })).toThrow("invalid sender identity");
    expect(() => appendMessage({
      channel: "m",
      from: "a",
      from_identity: "name:a",
      body: "missing recipient",
      env,
    })).toThrow("must be provided together");
  });

  test("消息落盘后追加的 route 不能改写既有消息归属", () => {
    const env = freshEnv();
    appendMessage({ channel: "m", from: "a", body: "plain", env });
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    const { channelLogPath } = require("../src/store.ts") as typeof import("../src/store.ts");
    appendFileSync(
      channelLogPath("m", env),
      `${JSON.stringify({
        v: 1,
        type: "route",
        seq: 1,
        from_identity: "name:a",
        to_identity: "name:b",
      })}\n`,
    );
    expect(readRoutedMessages("m", { env })[0]).not.toHaveProperty("to_identity");
  });
});

describe("extractMentions", () => {
  test("去重、允许 . _ -，邮箱 / SSH remote 里的 @ 不触发唤醒", () => {
    expect(extractMentions("hi @bob @bob (@al.ice-1) email a@b git@github.com:x/y ssh://git@host:2222/x"))
      .toEqual(["bob", "al.ice-1"]);
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

describe("codex-ping 审查发现的两条不可读路径（回归）", () => {
  test("非法 reply_to 在写入前被拒绝，绝不写出读侧拒绝的行", () => {
    const env = freshEnv();
    expect(() => appendMessage({ channel: "c", from: "a", body: "x", reply_to: NaN, env })).toThrow(/invalid reply_to/);
    expect(() => appendMessage({ channel: "c", from: "a", body: "x", reply_to: 0, env })).toThrow(/invalid reply_to/);
    expect(() => appendMessage({ channel: "c", from: "a", body: "x", reply_to: 1.5, env })).toThrow(/invalid reply_to/);
    expect(readMessages("c", { env })).toEqual([]); // 一条都没写进去
  });

  test("崩溃残留的无换行半行被封口，下一条消息完整可读", () => {
    const env = freshEnv();
    appendMessage({ channel: "c", from: "a", body: "one", env });
    const fs = require("node:fs") as typeof import("node:fs");
    const { channelLogPath } = require("../src/store.ts") as typeof import("../src/store.ts");
    // 模拟写入中断：半行、无换行结尾
    fs.appendFileSync(channelLogPath("c", env), '{"v":1,"seq":2,"ts":"2026-');
    const next = appendMessage({ channel: "c", from: "a", body: "two", env });
    const all = readMessages("c", { env });
    expect(all.map((m) => m.body)).toEqual(["one", "two"]);
    expect(all[1]!.seq).toBe(next.seq); // 新消息独立成行，没被半行吞掉
  });
});

describe("codex-ping 审查 #7/#9 回归", () => {
  test("空内容的陈锁（写 pid 前崩溃）过锁龄后可被抢占，不再永久死锁", () => {
    const env = freshEnv();
    const fs = require("node:fs") as typeof import("node:fs");
    const { join } = require("node:path") as typeof import("node:path");
    const { ocsHome } = require("../src/store.ts") as typeof import("../src/store.ts");
    const dir = join(ocsHome(env), "channels");
    fs.mkdirSync(dir, { recursive: true });
    const lockPath = join(dir, "dev.lock");
    fs.writeFileSync(lockPath, ""); // openSync 后、写 pid 前崩溃的残骸
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);
    expect(appendMessage({ channel: "dev", from: "a", body: "x", env }).seq).toBe(1);
  });

  test("日志不可读（EACCES）必须炸，不许伪装成空频道", () => {
    const env = freshEnv();
    appendMessage({ channel: "dev", from: "a", body: "secret", env });
    const fs = require("node:fs") as typeof import("node:fs");
    const { channelLogPath } = require("../src/store.ts") as typeof import("../src/store.ts");
    fs.chmodSync(channelLogPath("dev", env), 0o000);
    try {
      expect(() => readMessages("dev", { env })).toThrow();
    } finally {
      fs.chmodSync(channelLogPath("dev", env), 0o600);
    }
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
