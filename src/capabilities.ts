import { findClaudeChannel } from "./claude-channel.ts";
import { resolveSessionSocketByPid } from "./claude-inject.ts";
import { parentPidOf } from "./wake.ts";
import type { RosterEntry, Roster } from "./roster.ts";

export function entryCapabilities(entry: RosterEntry, roster: Pick<Roster, "codexQueue">,
  desktopClaimed = false, platform: string = process.platform, env: NodeJS.ProcessEnv = process.env) {
  const kind = entry.kind;
  // `ocs claude` 启动的会话走 channel：宿主排队、没有回执（docs/claude-channel.md）。
  const channel = kind === "claude" && findClaudeChannel(entry.pid, env, { parentPid: parentPidOf, platform: platform as NodeJS.Platform }) !== null;
  const canWake = kind === "claude" && resolveSessionSocketByPid(entry.pid, { env }) === null ? "unverified" : kind === "cmux" ? "unverified" : kind === "codex-task"
    ? (desktopClaimed || (entry.livePid !== null && roster.codexQueue) ? "available" : "unverified") : "available";
  return { v: 1, wake: canWake, noWake: kind !== "cmux",
    busyDelivery: kind === "agy" ? "serial" : kind === "opencode" || kind === "pi" || kind === "hermes" || kind === "grok" ? "queued"
      : kind === "codex-task" ? "steer-or-coalesce" : channel ? "queued" : "host-controlled",
    deliveryReceipt: kind === "claude" && platform !== "win32" && !channel ? "conditional" : "none",
    completionReceipt: false, batch: kind !== "cmux" };
}

export type Capabilities = ReturnType<typeof entryCapabilities>;
export function parseCapabilities(value: unknown): Capabilities | undefined {
  if (value === null || typeof value !== "object") return;
  const c = value as Capabilities;
  if (c.v !== 1 || !["available", "unverified"].includes(c.wake) ||
      !["serial", "queued", "steer-or-coalesce", "host-controlled"].includes(c.busyDelivery) ||
      !["conditional", "none"].includes(c.deliveryReceipt) || typeof c.noWake !== "boolean" ||
      c.completionReceipt !== false || typeof c.batch !== "boolean") return;
  return { v: 1, wake: c.wake, noWake: c.noWake, busyDelivery: c.busyDelivery,
    deliveryReceipt: c.deliveryReceipt, completionReceipt: false, batch: c.batch };
}
