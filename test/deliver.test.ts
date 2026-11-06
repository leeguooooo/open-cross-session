import { describe, expect, test } from "bun:test";
import { bufferedSink, collectingSink } from "../src/deliver.ts";

describe("bufferedSink", () => {
  test("replays lines and outcomes in order, so parallel Claude wakes still print per target", () => {
    const first = bufferedSink();
    const second = bufferedSink();
    // 第二个目标先完成
    second.log("wake → b");
    second.fail("unknown");
    first.log("wake → a");
    first.pending?.("deferred");
    const into = collectingSink();
    const pending: string[] = [];
    first.flush({ ...into, pending: (state) => pending.push(state) });
    second.flush(into);
    expect(into.lines).toEqual(["wake → a", "wake → b"]);
    expect(into.outcome()).toBe("unknown");
    expect(pending).toEqual(["deferred"]);
  });
});
