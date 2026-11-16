// #78：本机找不到的 dm 地址，在已配对对端里精确查一遍（src/lan-cli.ts findLanAgents）。
import { expect, test } from "bun:test";
import { findLanAgents } from "../src/lan-cli.ts";
import type { LanPeer } from "../src/lan-store.ts";

const peer = (label: string) => ({ label }) as unknown as LanPeer;

test("returns <address>@<peer> for every peer that lists the exact address, case-insensitively", async () => {
  const rosters: Record<string, string[]> = { mac: ["codex-01a1c4a5", "pi-x"], mini: ["CODEX-01A1C4A5"], box: ["codex-01a1c4a6"] };
  const hits = await findLanAgents("codex-01a1c4a5", {
    peers: [peer("mac"), peer("mini"), peer("box")],
    who: async (p) => ({ entries: rosters[p.label]!.map((address) => ({ address })) }),
  });
  expect(hits).toEqual(["codex-01a1c4a5@mac", "codex-01a1c4a5@mini"]);
});

test("offline peers, errors and slow peers count as no match; answers already back still count", async () => {
  const hits = await findLanAgents("worker", {
    peers: [peer("down"), peer("slow"), peer("up")],
    timeoutMs: 100,
    who: async (p) => {
      if (p.label === "down") throw new Error("ECONNREFUSED");
      if (p.label === "slow") await new Promise((r) => setTimeout(r, 1000));
      return { entries: [{ address: "worker" }] };
    },
  });
  expect(hits).toEqual(["worker@up"]);
});

test("no paired peers → no lookup", async () => {
  let called = false;
  expect(await findLanAgents("x", { peers: [], who: async () => { called = true; return { entries: [] }; } })).toEqual([]);
  expect(called).toBe(false);
});
