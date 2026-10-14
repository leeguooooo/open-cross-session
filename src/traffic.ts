// Diagnostic observations, never delivery authority. No message bodies or credentials.
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { CHANNEL_RE, ocsHome } from "./store.ts";

export type TrafficOutcome = "accepted" | "deferred" | "parked" | "failed" | "unknown" | "skipped" | "none";
export interface TrafficEvent {
  v: 1;
  kind: "message" | "coalesced" | "delivery";
  channel: string;
  seq: number;
  at: string;
  outcome: TrafficOutcome;
  items: number;
}
function directory(env: NodeJS.ProcessEnv): string {
  const path = join(ocsHome(env), "traffic");
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() ||
      (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) {
    throw new Error("unsafe traffic directory");
  }
  return path;
}
/** Best effort: diagnostics must never turn a committed send into an error. */
export function writeTraffic(event: TrafficEvent, env: NodeJS.ProcessEnv = process.env, id: string = randomUUID()): string {
  let tmp: string | undefined;
  try {
    if (!/^[0-9a-f-]{36}$/.test(id)) return id;
    const dir = directory(env);
    tmp = join(dir, `${id}.${randomUUID()}.tmp`);
    writeFileSync(tmp, JSON.stringify(event), { mode: 0o600, flag: "wx" });
    renameSync(tmp, join(dir, `${id}.json`));
  } catch { /* Metrics failure cannot change delivery. */ }
  finally { if (tmp !== undefined) try { unlinkSync(tmp); } catch {} }
  return id;
}
export function trafficStats(channel?: string, env: NodeJS.ProcessEnv = process.env) {
  if (channel !== undefined && !CHANNEL_RE.test(channel)) throw new Error("invalid channel");
  const outcomes = { accepted: 0, deferred: 0, parked: 0, failed: 0, unknown: 0, skipped: 0, none: 0 };
  const deliveryOutcomes = { ...outcomes };
  let deliveryAttempts = 0;
  let messages = 0, batchItems = 0, batchedMessages = 0, coalescedMessages = 0, coalescedDeliveries = 0;
  const dir = join(ocsHome(env), "traffic");
  let files: string[];
  try { if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) throw new Error(); files = readdirSync(dir); }
  catch { files = []; }
  for (const file of files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) continue;
    try {
      const path = join(dir, file), stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) continue;
      const e = JSON.parse(readFileSync(path, "utf8")) as TrafficEvent;
      if (e.v !== 1 || !CHANNEL_RE.test(e.channel) || (channel !== undefined && e.channel !== channel) ||
          !Number.isSafeInteger(e.seq) || e.seq < 1 || !Number.isSafeInteger(e.items) || e.items < 1 ||
          !Object.hasOwn(outcomes, e.outcome)) continue;
      if (e.kind === "message") { messages++; outcomes[e.outcome]++; if (e.items > 1) { batchedMessages++; batchItems += e.items; } }
      else if (e.kind === "delivery") { deliveryAttempts++; deliveryOutcomes[e.outcome]++; }
      else if (e.kind === "coalesced") { coalescedDeliveries++; coalescedMessages += e.items; }
    } catch { /* Ignore damaged diagnostic records. */ }
  }
  return { deliveryAttempts, deliveryOutcomes, wakeRequestedMessages: messages - outcomes.skipped - outcomes.none, v: 1, scope: channel ?? "all", messages, outcomes, batchedMessages, batchItems,
    explicitBatchSavedRequests: batchItems - batchedMessages, coalescedMessages, coalescedDeliveries,
    note: "Local observations since instrumentation was installed; accepted is not read or completion. Counts are message-level outcomes, not model turns or tokens." };
}

export function startDeliveryObservation(channel: string, seq: number, env: NodeJS.ProcessEnv = process.env) {
  const event: TrafficEvent = { v: 1, kind: "delivery", channel, seq, at: new Date().toISOString(), outcome: "unknown", items: 1 };
  const id = writeTraffic(event, env);
  return (outcome: TrafficOutcome) => writeTraffic({ ...event, outcome }, env, id);
}
