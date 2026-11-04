import { describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  codexActiveTurnId,
  codexReceiverCursor,
  coalescedWakeInput,
  deferCodexWakeIfBusy,
  loadDeferredCodexWake,
  runCodexWakeWatch,
  type CoalescedDeliver,
} from "../src/codex-defer.ts";
import { identityCursorConsumer } from "../src/inbox.ts";
import { appendMessage, saveCursor } from "../src/store.ts";
import { wakeNote } from "../src/wake.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

const THREAD = "01a11176-9a71-71c1-94df-c9a134c96a1b";
const CHANNEL = "dm-test";

function env(): NodeJS.ProcessEnv & { rollout: string } {
  const codexHome = tempDir("ocs-defer-codex-");
  const day = join(codexHome, "sessions", "2026", "10", "06");
  mkdirSync(day, { recursive: true });
  const rollout = join(day, `rollout-2026-10-06T22-45-48-${THREAD}.jsonl`);
  writeFileSync(rollout, "");
  return { OCS_HOME: tempDir("ocs-defer-home-"), CODEX_HOME: codexHome, rollout };
}

function lifecycle(path: string, type: "task_started" | "task_complete" | "turn_aborted", turn: string): void {
  appendFileSync(
    path,
    `${JSON.stringify({ timestamp: "2026-10-06T13:00:00Z", type: "event_msg", payload: { type, turn_id: turn } })}\n`,
  );
}

function post(e: NodeJS.ProcessEnv, body: string): number {
  return appendMessage({ channel: CHANNEL, from: "claude-a", body, env: e }).seq;
}

const wake = (seq: number) => ({ channel: CHANNEL, seq, from: "claude-a", body: `m${seq}`, lang: "en" as const });

describe("codex-defer：回合判定", () => {
  test("最后一个生命周期事件是 task_started = 正忙，返回 turn id", () => {
    const e = env();
    expect(codexActiveTurnId(THREAD, e)).toBeNull(); // 空 rollout = 空闲
    lifecycle(e.rollout, "task_started", "turn-1");
    expect(codexActiveTurnId(THREAD, e)).toBe("turn-1");
    lifecycle(e.rollout, "task_complete", "turn-1");
    expect(codexActiveTurnId(THREAD, e)).toBeNull();
    lifecycle(e.rollout, "task_started", "turn-2");
    lifecycle(e.rollout, "turn_aborted", "turn-2");
    expect(codexActiveTurnId(THREAD, e)).toBeNull();
  });

  test("#67: codex 0.163 把 turn_attribution 写在 turn_id 前面，仍能取到 turn id", () => {
    const e = env();
    // 逐字取自 codex 0.163.0 的 rollout（只换了 id）
    appendFileSync(
      e.rollout,
      `{"timestamp":"2026-11-04T01:51:30.174Z","ordinal":314,"type":"event_msg","payload":{"type":"task_started","turn_attribution":{"turn_id":"turn-163","turn_trigger":"queue","parent_turn_id":null,"initiating_agent_path":null,"root_turn_id":"turn-163"},"turn_id":"turn-163","root_turn_id":"turn-163","started_at":1793757090,"model_context_window":828400,"collaboration_mode_kind":"default"}}\n`,
    );
    expect(codexActiveTurnId(THREAD, e)).toBe("turn-163");
    // 没带 turn_id 的旧格式仍是「忙但不能 steer」，且不会借用下一行的 id
    appendFileSync(e.rollout, `{"type":"event_msg","payload":{"type":"task_started"}}\n{"type":"event_msg","payload":{"type":"item_completed","turn_id":"other"}}\n`);
    expect(codexActiveTurnId(THREAD, e)).toBe("");
  });

  test("长回合：task_started 之后超过一个读块的事件仍能找到", () => {
    const e = env();
    lifecycle(e.rollout, "task_started", "turn-long");
    const filler = `${JSON.stringify({ type: "event_msg", payload: { type: "item_completed", x: "y".repeat(1000) } })}\n`;
    appendFileSync(e.rollout, filler.repeat(700)); // ~700KB > 256KB 块
    expect(codexActiveTurnId(THREAD, e)).toBe("turn-long");
  });
});

describe("codex-defer：入队闸门", () => {
  test("空闲且无积压：不拦，调用方立即投递", () => {
    const e = env();
    let spawned = 0;
    const r = deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(1), env: e, isBusy: () => false, spawnWatcher: () => spawned++ });
    expect(r).toEqual({ deferred: false });
    expect(spawned).toBe(0);
  });

  test("正忙：并入积压，同一对（接收方, 频道）只派一个等待器", () => {
    const e = env();
    let spawned = 0;
    const opts = { threadId: THREAD, env: e, isBusy: () => true, spawnWatcher: () => { spawned++; } };
    expect(deferCodexWakeIfBusy({ ...opts, wakeInput: wake(12) })).toEqual({ deferred: true, spawned: true, pending: 1 });
    expect(deferCodexWakeIfBusy({ ...opts, wakeInput: wake(15) })).toEqual({ deferred: true, spawned: false, pending: 2 });
    // 有积压时即使目标看起来空闲也并进去：等待器马上就会投，单独再发一条就重复了
    expect(deferCodexWakeIfBusy({ ...opts, isBusy: () => false, wakeInput: wake(17) }).deferred).toBe(true);
    expect(spawned).toBe(1);
    expect(loadDeferredCodexWake(THREAD, CHANNEL, e)!.pending.map((p) => p.seq)).toEqual([12, 15, 17]);
  });

  test("跨频道相同 seq 互不影响", () => {
    const e = env();
    const opts = { threadId: THREAD, env: e, isBusy: () => true, spawnWatcher: () => {} };
    deferCodexWakeIfBusy({ ...opts, wakeInput: wake(3) });
    deferCodexWakeIfBusy({ ...opts, wakeInput: { ...wake(3), channel: "dm-other" } });
    expect(loadDeferredCodexWake(THREAD, CHANNEL, e)!.pending.map((p) => p.seq)).toEqual([3]);
    expect(loadDeferredCodexWake(THREAD, "dm-other", e)!.pending.map((p) => p.seq)).toEqual([3]);
  });

  test("ocs 自己的通知（rawNote）不拦", () => {
    const e = env();
    const r = deferCodexWakeIfBusy({
      threadId: THREAD,
      wakeInput: { ...wake(1), rawNote: "[ocs delivery notice] x" },
      env: e,
      isBusy: () => true,
      spawnWatcher: () => {},
    });
    expect(r.deferred).toBe(false);
  });
});

describe("codex-defer：合并唤醒", () => {
  test("只提醒还没读的；多条时头部写明前面还有几条", () => {
    const e = env();
    const seqs = [post(e, "a"), post(e, "b"), post(e, "c"), post(e, "d")];
    saveCursor(CHANNEL, THREAD, seqs[0]!, e); // 接收方读到第 1 条
    const batch = seqs.map((seq) => ({ seq, from: "claude-a", deferredAt: "x" }));
    const built = coalescedWakeInput({ threadId: THREAD, channel: CHANNEL, lang: "en" }, batch, e, Date.now())!;
    expect(built.seqs).toEqual(seqs.slice(1));
    expect(built.alreadyRead).toEqual([seqs[0]!]);
    expect(built.wakeInput.body).toBe("d");
    const note = wakeNote({ ...built.wakeInput, receiver: "codex-01a11176", implicitReceiver: true });
    expect(note.split("\n")[0]).toMatch(/\(seq 4, plus 2 earlier unread from seq 2 — read the thread first, \d+s ago\)$/);
  });

  test("全部读过（任务里 ocs read 过）= 什么都不发", () => {
    const e = env();
    const seqs = [post(e, "a"), post(e, "b")];
    // DM 读游标按 codex 身份记
    saveCursor(CHANNEL, identityCursorConsumer(`codex:${THREAD}`), seqs[1]!, e);
    expect(codexReceiverCursor(THREAD, CHANNEL, e)).toBe(seqs[1]!);
    const batch = seqs.map((seq) => ({ seq, from: "claude-a", deferredAt: "x" }));
    expect(coalescedWakeInput({ threadId: THREAD, channel: CHANNEL, lang: "en" }, batch, e)).toBeNull();
  });

  test("合并头在降级阶梯里永不被砍", () => {
    const note = wakeNote({
      channel: CHANNEL,
      seq: 9,
      from: "x".repeat(64),
      body: "b",
      receiver: "r",
      earlier: { count: 3, firstSeq: 5 },
      lang: "zh",
    });
    expect(note).toContain("前面还有 3 条未读（从 seq 5 起），先读线程");
  });
});

describe("codex-defer：等待器", () => {
  function deliverSpy(): { calls: Array<{ seq: number; earlier?: unknown }>; deliver: CoalescedDeliver } {
    const calls: Array<{ seq: number; earlier?: unknown }> = [];
    return {
      calls,
      deliver: async (_t, wakeInput) => {
        calls.push({ seq: wakeInput.seq, ...(wakeInput.earlier !== undefined ? { earlier: wakeInput.earlier } : {}) });
        return { lines: [], outcome: "ok" };
      },
    };
  }

  test("忙→闲：一批积压只投一条，投完删记录退出", async () => {
    const e = env();
    const seqs = [post(e, "a"), post(e, "b"), post(e, "c")];
    for (const seq of seqs) {
      deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(seq), env: e, isBusy: () => true, spawnWatcher: () => {} });
    }
    let polls = 0;
    const spy = deliverSpy();
    await runCodexWakeWatch(THREAD, CHANNEL, {
      env: e,
      pollMs: 5,
      deliver: spy.deliver,
      isLive: () => true,
      isBusy: () => ++polls < 3,
    });
    expect(spy.calls).toEqual([{ seq: seqs[2]!, earlier: { count: 2, firstSeq: seqs[0]! } }]);
    expect(loadDeferredCodexWake(THREAD, CHANNEL, e)).toBeNull();
  });

  test("回合里已经读完：等待器不投任何唤醒", async () => {
    const e = env();
    const seqs = [post(e, "a"), post(e, "b")];
    for (const seq of seqs) {
      deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(seq), env: e, isBusy: () => true, spawnWatcher: () => {} });
    }
    saveCursor(CHANNEL, THREAD, seqs[1]!, e);
    const spy = deliverSpy();
    await runCodexWakeWatch(THREAD, CHANNEL, { env: e, pollMs: 5, deliver: spy.deliver, isLive: () => true, isBusy: () => false });
    expect(spy.calls).toEqual([]);
    expect(loadDeferredCodexWake(THREAD, CHANNEL, e)).toBeNull();
  });

  test("投递期间新到的消息进下一批，不丢", async () => {
    const e = env();
    const first = post(e, "a");
    deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(first), env: e, isBusy: () => true, spawnWatcher: () => {} });
    let second = 0;
    const calls: number[] = [];
    let busy = false;
    await runCodexWakeWatch(THREAD, CHANNEL, {
      env: e,
      pollMs: 5,
      isLive: () => true,
      isBusy: () => {
        const was = busy;
        busy = false;
        return was;
      },
      deliver: async (_t, wakeInput) => {
        calls.push(wakeInput.seq);
        if (second === 0) {
          // 我们的唤醒开了一轮；这期间对方又发了一条
          busy = true;
          second = post(e, "b");
          deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(second), env: e, isBusy: () => true, spawnWatcher: () => {} });
        }
        return { lines: [], outcome: "ok" };
      },
    });
    expect(calls).toEqual([first, second]);
  });

  test("目标退出：删记录，不投（消息仍在频道日志里）", async () => {
    const e = env();
    const seq = post(e, "a");
    deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(seq), env: e, isBusy: () => true, spawnWatcher: () => {} });
    const spy = deliverSpy();
    await runCodexWakeWatch(THREAD, CHANNEL, { env: e, pollMs: 5, deliver: spy.deliver, isLive: () => false, isBusy: () => true });
    expect(spy.calls).toEqual([]);
    expect(loadDeferredCodexWake(THREAD, CHANNEL, e)).toBeNull();
  });

  test("结果未知也不补发：取走的批次不会回到记录里", async () => {
    const e = env();
    const seq = post(e, "a");
    deferCodexWakeIfBusy({ threadId: THREAD, wakeInput: wake(seq), env: e, isBusy: () => true, spawnWatcher: () => {} });
    let calls = 0;
    await runCodexWakeWatch(THREAD, CHANNEL, {
      env: e,
      pollMs: 5,
      isLive: () => true,
      isBusy: () => false,
      deliver: async () => {
        calls++;
        return { lines: ["unknown"], outcome: "unknown" };
      },
    });
    expect(calls).toBe(1);
  });
});
