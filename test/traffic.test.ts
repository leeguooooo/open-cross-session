import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackDelivery } from "../src/deliver.ts";
import { trafficStats, writeTraffic, type TrafficEvent } from "../src/traffic.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";
autoCleanupTempDirs();

test("observations update once, retain unknown crash state, and distinguish message/pipeline/batch counts", async () => {
  const env = { OCS_HOME: tempDir("ocs-traffic-") };
  const event: TrafficEvent = { v: 1, kind: "message", channel: "chat", seq: 1,
    at: new Date().toISOString(), outcome: "unknown", items: 3 };
  const id = writeTraffic(event, env);
  expect(trafficStats("chat", env).outcomes.unknown).toBe(1);
  writeTraffic({ ...event, outcome: "accepted" }, env, id);
  const sink = { log: () => {}, fail: () => {} };
  await trackDelivery("chat", 1, sink, async (observed) => { observed.pending?.("deferred"); }, env);
  await trackDelivery("chat", 1, sink, async (observed) => { observed.fail("unknown"); observed.fail("failed"); }, env);
  await expect(trackDelivery("chat", 1, sink, async () => { throw new Error("transport stopped"); }, env)).rejects.toThrow();
  writeTraffic({ ...event, kind: "coalesced", items: 3, outcome: "accepted" }, env);
  const stats = trafficStats("chat", env);
  expect(stats).toMatchObject({ messages: 1, outcomes: { accepted: 1, unknown: 0 }, deliveryAttempts: 3,
    deliveryOutcomes: { deferred: 1, unknown: 2 }, batchItems: 3, explicitBatchSavedRequests: 2,
    coalescedMessages: 3, coalescedDeliveries: 1 });
  expect(trafficStats("other", env).messages).toBe(0);
  const dir = join(env.OCS_HOME, "traffic");
  if (process.platform !== "win32") {
    expect(statSync(dir).mode & 0o077).toBe(0);
    for (const file of readdirSync(dir)) expect(statSync(join(dir, file)).mode & 0o077).toBe(0);
  }
  for (const file of readdirSync(dir)) {
    const record = JSON.parse(readFileSync(join(dir, file), "utf8"));
    expect(record.body).toBeUndefined(); expect(record.token).toBeUndefined(); expect(record.pid).toBeUndefined();
  }
});

test("unsafe or damaged diagnostics cannot fail delivery or follow symlinks", async () => {
  const home = tempDir("ocs-traffic-unsafe-"), outside = tempDir("ocs-traffic-outside-");
  const env = { OCS_HOME: home };
  symlinkSync(outside, join(home, "traffic"), process.platform === "win32" ? "junction" : "dir");
  let delivered = 0;
  await trackDelivery("chat", 1, { log: () => {}, fail: () => {} }, async () => { delivered++; }, env);
  expect(delivered).toBe(1); expect(readdirSync(outside)).toEqual([]);
  expect(trafficStats(undefined, env).messages).toBe(0);
  const other = tempDir("ocs-traffic-damaged-");
  mkdirSync(join(other, "traffic"), { mode: 0o700 });
  writeFileSync(join(other, "traffic", "11111111-1111-4111-8111-111111111111.json"), "not json");
  expect(trafficStats(undefined, { OCS_HOME: other }).messages).toBe(0);
});
