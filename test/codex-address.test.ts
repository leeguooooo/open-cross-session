// #93: Codex short addresses hash the full thread id; the old time prefix keeps resolving,
// and LAN channel keys keep the time prefix so existing conversations do not drift.
import { describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexRolloutLastActive, codexShortId } from "../src/codex-sessions.ts";
import { agoText, messages } from "../src/i18n.ts";
import { localAddressOf } from "../src/lan-daemon.ts";
import { resolveDmTarget } from "../src/roster.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();

// Two UUIDv7 threads created in the same ~65 s bucket share their first 8 hex digits.
const A = "019a21b2-1111-7000-8000-000000000001";
const B = "019a21b2-2222-7000-8000-000000000002";

function codexHome(threads: string[]): { root: string; env: NodeJS.ProcessEnv; day: string } {
  const root = tempDir("ocs-codex-address-");
  const day = join(root, "sessions", "2026", "11", "25");
  mkdirSync(day, { recursive: true });
  threads.forEach((thread, i) => writeFileSync(
    join(day, `rollout-2026-11-25T03-32-${String(i).padStart(2, "0")}-${thread}.jsonl`),
    `${JSON.stringify({ type: "session_meta", payload: { cwd: "/work/x" } })}\n`,
  ));
  return { root, day, env: { CODEX_HOME: root, OCS_HOME: join(root, "ocs") } };
}

describe("codexShortId", () => {
  test("is stable, case-insensitive and shaped like the old address", () => {
    expect(codexShortId(A)).toBe(codexShortId(A.toUpperCase()));
    expect(codexShortId(A)).toMatch(/^codex-[0-9a-f]{8}$/);
  });

  test("threads sharing a time prefix get different addresses", () => {
    expect(A.slice(0, 8)).toBe(B.slice(0, 8));
    expect(codexShortId(A)).not.toBe(codexShortId(B));
  });
});

describe("resolving codex-<8hex>", () => {
  test("the hashed address and the old time prefix reach the same thread", () => {
    const { env } = codexHome([A]);
    for (const address of [codexShortId(A), `codex-${A.slice(0, 8)}`]) {
      expect(resolveDmTarget(address, env)).toMatchObject({
        kind: "codex-task", name: codexShortId(A), identity: `codex:${A}`, threadId: A,
      });
    }
  });

  test("the hashed address of each same-prefix thread is unique; the shared prefix is ambiguous", () => {
    const { env } = codexHome([A, B]);
    expect(resolveDmTarget(codexShortId(A), env)).toMatchObject({ threadId: A });
    expect(resolveDmTarget(codexShortId(B), env)).toMatchObject({ threadId: B });
    const shared = resolveDmTarget(`codex-${A.slice(0, 8)}`, env)!;
    expect(shared.threadId).toBeUndefined();
    expect(shared.ambiguousCodexTargets?.sort()).toEqual([A, B]);
  });

  test("a hash that equals another thread's time prefix is ambiguous, never a pick", () => {
    const hash = codexShortId(A).slice("codex-".length);
    const lookalike = `${hash}-3333-7000-8000-000000000003`;
    const { env } = codexHome([A, lookalike]);
    const resolved = resolveDmTarget(`codex-${hash}`, env)!;
    expect(resolved.threadId).toBeUndefined();
    expect(resolved.ambiguousCodexTargets?.sort()).toEqual([A, lookalike].sort());
  });
});

describe("LAN channel key", () => {
  test("stays the time prefix so existing LAN conversations keep their channel", () => {
    const { env } = codexHome([A]);
    const local = localAddressOf(resolveDmTarget(A, env)!, A, env);
    expect(local).toEqual({ key: `codex-${A.slice(0, 8)}`, display: codexShortId(A) });
  });
});

describe("parked notice for an ended thread", () => {
  test("finds the last write time, including archives compressed to .jsonl.zst", () => {
    const { root, day } = codexHome([]);
    const archived = join(day, `rollout-2026-11-25T03-32-00-${A}.jsonl.zst`);
    writeFileSync(archived, "");
    const when = new Date("2026-10-14T07:11:00Z");
    utimesSync(archived, when, when);
    expect(codexRolloutLastActive(join(root, "sessions"), A)).toBe(when.getTime());
    expect(codexRolloutLastActive(join(root, "sessions"), B)).toBeNull();
  });

  test("says when the thread was last active, and keeps the old text when unknown", () => {
    const when = Date.now() - 43 * 86_400_000;
    for (const lang of ["en", "zh"] as const) {
      const M = messages(lang);
      expect(M.dmCodexParked(A, "dm-x", when)).toContain(agoText(when, lang));
      expect(M.dmCodexParked(A, "dm-x", null)).toBe(M.dmCodexParked(A, "dm-x"));
    }
    expect(agoText(when, "en")).toBe("43 days ago");
  });
});
