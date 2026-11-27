// #93: project-scoped addressing (`codex.<project>`) and `dm --project` checks.
// Every refusal must leave nothing stored.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanWhoProject } from "../src/lan-client.ts";
import { lanProjectVerdict } from "../src/lan-cli.ts";
import { handleLanDm } from "../src/lan-daemon.ts";
import type { LanPeer } from "../src/lan-store.ts";
import { isReservedOcsName } from "../src/names.ts";
import {
  checkTargetProject,
  expandProjectAddress,
  liveProjectPeers,
  parseProjectAddress,
  pickProjectTarget,
  type CheckDeps,
  type ProjectDeps,
} from "../src/project-address.ts";
import type { ResolvedDmTarget, RosterEntry } from "../src/roster.ts";
import { autoCleanupTempDirs, tempDir } from "./tmp";

autoCleanupTempDirs();
const T = 60_000;

const T1 = "019a21b2-1111-7000-8000-000000000001";
const T2 = "019a21b2-2222-7000-8000-000000000002";
const T3 = "019a21b2-3333-7000-8000-000000000003";

function codex(threadId: string, project: string | undefined, livePid: number | null): RosterEntry {
  return {
    kind: "codex-task", target: `codex-${threadId.slice(-8)}`, threadId, summary: `task ${threadId.slice(-1)}`,
    cwd: project === undefined ? null : `/work/${project}`, ...(project === undefined ? {} : { project }),
    self: false, livePid, tty: null, hostApp: null,
  };
}

const live = (entry: RosterEntry) => entry.kind !== "codex-task" || entry.livePid !== null;

describe("parseProjectAddress", () => {
  test("accepts <kind>.<project> for codex / pi / claude", () => {
    expect(parseProjectAddress("codex.my-api")).toEqual({ kind: "codex", project: "my-api" });
    expect(parseProjectAddress("CODEX.My-Api")).toEqual({ kind: "codex", project: "My-Api" });
    expect(parseProjectAddress("pi.web")).toEqual({ kind: "pi", project: "web" });
    expect(parseProjectAddress("claude.docs")).toEqual({ kind: "claude", project: "docs" });
    expect(parseProjectAddress("codex.site.js")).toEqual({ kind: "codex", project: "site.js" });
  });

  test("rejects everything else", () => {
    for (const target of ["codex.", "codex-01a21b2c", "hermes.x", "codex._x", "codex.a/b", "xuanwu", `codex.${"a".repeat(64)}`]) {
      expect(parseProjectAddress(target)).toBeNull();
    }
  });
});

describe("pickProjectTarget", () => {
  test("exactly one reachable session in the project resolves to its full thread id", () => {
    const pick = pickProjectTarget([codex(T1, "api", 10), codex(T2, "web", 11)], "codex", "api", live);
    expect(pick).toMatchObject({ ok: true, candidate: { target: T1, project: "api" } });
  });

  test("project names compare case-insensitively", () => {
    expect(pickProjectTarget([codex(T1, "Api", 10)], "codex", "api", live).ok).toBe(true);
  });

  test("history without a live process is not a candidate", () => {
    const pick = pickProjectTarget([codex(T1, "api", null), codex(T2, "web", 11)], "codex", "api", live);
    expect(pick).toEqual({ ok: false, reason: "none", candidates: [] });
  });

  test("several reachable sessions are ambiguous and listed", () => {
    const pick = pickProjectTarget([codex(T1, "api", 10), codex(T2, "api", 11), codex(T3, "web", 12)], "codex", "api", live);
    expect(pick.ok).toBe(false);
    if (pick.ok) return;
    expect(pick.reason).toBe("ambiguous");
    expect(pick.candidates.map((c) => c.target).sort()).toEqual([T1, T2]);
  });

  test("only the requested kind is considered", () => {
    const pi: RosterEntry = { kind: "pi", target: "pi-aaaaaaaa", sessionId: "aaaaaaaa-0000-4000-8000-000000000000",
      name: null, pid: 5, cwd: "/work/api", project: "api", self: false };
    expect(pickProjectTarget([pi], "codex", "api", live).ok).toBe(false);
    expect(pickProjectTarget([pi], "pi", "api", live)).toMatchObject({ ok: true, candidate: { kind: "pi" } });
  });
});

describe("expandProjectAddress", () => {
  const deps = (entries: RosterEntry[], codexIpc = false, owners: Record<string, string> = {}): ProjectDeps & { asked: string[][] } => {
    const asked: string[][] = [];
    return {
      asked,
      prime: async () => {},
      roster: () => ({ entries, codexIpc }),
      desktopOwners: async (ids) => { asked.push(ids); return owners; },
    };
  };
  const env = () => ({ OCS_HOME: tempDir("ocs-project-") });

  test("passes through anything that is not a project address", async () => {
    expect(await expandProjectAddress("codex-01a21b2c", env(), deps([]))).toEqual({ kind: "passthrough", target: "codex-01a21b2c" });
  });

  test("a name registered before this existed keeps winning", async () => {
    const e = env();
    mkdirSync(join(e.OCS_HOME, "names"), { recursive: true });
    writeFileSync(join(e.OCS_HOME, "names", "codex.legacy.json"), JSON.stringify({ v: 1, name: "codex.legacy", kind: "codex", id: T1 }));
    expect(await expandProjectAddress("codex.legacy", e, deps([codex(T2, "legacy", 10)]))).toEqual({ kind: "passthrough", target: "codex.legacy" });
  });

  test("expands to the one live thread, refuses none / several", async () => {
    expect(await expandProjectAddress("codex.api", env(), deps([codex(T1, "api", 10)])))
      .toMatchObject({ kind: "expanded", target: T1 });
    expect(await expandProjectAddress("codex.api", env(), deps([codex(T1, "web", 10)])))
      .toMatchObject({ kind: "refused", reason: "none", project: "api" });
    expect(await expandProjectAddress("codex.api", env(), deps([codex(T1, "api", 10), codex(T2, "api", 11)])))
      .toMatchObject({ kind: "refused", reason: "ambiguous" });
  });

  test("a Desktop claim counts as reachable; only that project's unclaimed threads are probed", async () => {
    const d = deps([codex(T1, "api", null), codex(T2, "web", null)], true, { [T1]: "renderer" });
    expect(await expandProjectAddress("codex.api", env(), d)).toMatchObject({ kind: "expanded", target: T1 });
    expect(d.asked).toEqual([[T1]]);
  });

  test("a Desktop probe failure is no evidence, not a crash", async () => {
    const d: ProjectDeps = { ...deps([codex(T1, "api", null)], true), desktopOwners: async () => { throw new Error("socket gone"); } };
    expect(await expandProjectAddress("codex.api", env(), d)).toMatchObject({ kind: "refused", reason: "none" });
  });
});

describe("liveProjectPeers (parked-notice hint)", () => {
  test("lists other live sessions in the project, never the parked thread, at most 3", async () => {
    const T4 = "019a21b2-4444-7000-8000-000000000004";
    const T5 = "019a21b2-5555-7000-8000-000000000005";
    const entries = [codex(T1, "api", null), codex(T2, "api", 11), codex(T3, "api", 12), codex(T4, "api", 13), codex(T5, "web", 14)];
    const deps: ProjectDeps = { prime: async () => {}, roster: () => ({ entries, codexIpc: false }), desktopOwners: async () => ({}) };
    const peers = await liveProjectPeers("codex", "api", T2, {}, deps);
    expect(peers.map((p) => p.target)).toEqual([T3, T4]);
    const all = await liveProjectPeers("codex", "api", T1, {}, deps);
    expect(all.map((p) => p.target)).toEqual([T2, T3, T4]);
  });
});

describe("checkTargetProject (dm --project)", () => {
  const resolvedCodex = { kind: "codex-task", name: "codex-x", identity: `codex:${T1}`, threadId: T1 } as ResolvedDmTarget;
  const deps = (reachable: boolean, project: string | null): CheckDeps => ({
    prime: async () => {}, codexReachable: async () => reachable, project: () => project,
  });

  test("a live target in the expected project passes", async () => {
    expect(await checkTargetProject(resolvedCodex, "API", {}, deps(true, "api"))).toEqual({ ok: true });
  });

  test("a live target elsewhere is refused with its real project", async () => {
    expect(await checkTargetProject(resolvedCodex, "api", {}, deps(true, "web"))).toEqual({ ok: false, reason: "mismatch", actual: "web" });
  });

  test("an ended thread cannot be confirmed, even if its history says the right project", async () => {
    expect(await checkTargetProject(resolvedCodex, "api", {}, deps(false, "api"))).toEqual({ ok: false, reason: "unknown" });
  });

  test("unknown working directory, offline names and other kinds cannot be confirmed", async () => {
    expect(await checkTargetProject(resolvedCodex, "api", {}, deps(true, null))).toEqual({ ok: false, reason: "unknown" });
    const parkedName = { kind: "claude", name: "someone", identity: "name:someone" } as ResolvedDmTarget;
    expect(await checkTargetProject(parkedName, "api", {}, deps(true, "api"))).toEqual({ ok: false, reason: "unknown" });
    const hermes = { kind: "hermes", name: "hermes-x", identity: "hermes:x" } as ResolvedDmTarget;
    expect(await checkTargetProject(hermes, "api", {}, deps(true, "api"))).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("ocs rename", () => {
  test("refuses names shaped like project addresses", () => {
    expect(isReservedOcsName("codex.api")).toBe(true);
    expect(isReservedOcsName("Pi.web")).toBe(true);
    expect(isReservedOcsName("claude.docs")).toBe(true);
    expect(isReservedOcsName("codexapi")).toBe(false);
    expect(isReservedOcsName("my.codex")).toBe(false);
  });
});

describe("LAN", () => {
  test("a peer's project field survives only as a plain name", () => {
    expect(cleanWhoProject("my-api")).toBe("my-api");
    for (const bad of ["/home/u/my-api", "a b", "x\u001b[31m", "", 7, null, "a".repeat(65)]) {
      expect(cleanWhoProject(bad)).toBeUndefined();
    }
  });

  test("--project verdict against the peer's roster", () => {
    const entries = [{ address: "codex-aaaaaaaa", project: "api" }, { address: "codex-bbbbbbbb" }];
    expect(lanProjectVerdict(entries, "codex-aaaaaaaa", "API", "mac")).toEqual({ ok: true });
    expect(lanProjectVerdict(entries, "codex-aaaaaaaa", "web", "mac")).toEqual({ ok: false, reason: "mismatch", actual: "api" });
    expect(lanProjectVerdict(entries, "codex-bbbbbbbb", "api", "mac")).toEqual({ ok: false, reason: "unverifiable" });
    expect(lanProjectVerdict(entries, "codex-cccccccc", "api", "mac")).toEqual({ ok: false, reason: "missing", peer: "mac" });
    expect(lanProjectVerdict([], "codex.api", "api", "mac")).toEqual({ ok: true });
    expect(lanProjectVerdict([], "codex.api", "web", "mac")).toEqual({ ok: false, reason: "mismatch", actual: "api" });
  });

  test("an inbound DM to codex.<project> with no live session stores nothing", async () => {
    const home = tempDir("ocs-project-lan-");
    const peer = { fingerprint: "a".repeat(52), label: "other" } as LanPeer;
    const r = await handleLanDm({ op: "dm", from: "reviewer", from_key: "reviewer", to: "codex.nowhere", body: "must not store" }, peer, "en",
      { OCS_HOME: home, CODEX_HOME: join(home, "codex"), OCS_CLAUDE_NATIVE_SESSIONS_DIR: join(home, "claude") });
    expect(r).toMatchObject({ ok: false, error: "not-found" });
    expect(existsSync(join(home, "channels"))).toBe(false);
  }, T);
});

describe("CLI", () => {
  function runCli(args: string[]): { code: number; stdout: string; stderr: string; home: string } {
    const home = tempDir("ocs-project-cli-");
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "..", "src", "cli.ts"), ...args], {
      env: {
        ...process.env, CODEX_HOME: join(home, "codex"), OCS_HOME: home, OCS_LANG: "en", OCS_UPGRADE_CHECK: "0",
        CODEX_THREAD_ID: "", OCS_NAME: "", OCS_PI_SESSION_ID: "", PI_SESSION_ID: "", HERMES_SESSION_ID: "",
        OCS_CLAUDE_NATIVE_SESSIONS_DIR: join(home, "claude-sessions"),
      },
    });
    return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), home };
  }
  const stored = (home: string) => existsSync(join(home, "channels")) ? readdirSync(join(home, "channels")) : [];

  test("dm codex.<project> with no live session refuses and stores nothing", () => {
    const r = runCli(["dm", "codex.nowhere", "hello", "--as", "human", "--json"]);
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ stored: false, exit: 1 });
    expect(JSON.parse(r.stdout).error).toContain("no live codex session works in project nowhere");
    expect(stored(r.home)).toEqual([]);
  }, T);

  test("dm <offline name> --project refuses and stores nothing", () => {
    const r = runCli(["dm", "someone", "hello", "--as", "human", "--project", "api"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("cannot confirm that someone works in project api");
    expect(stored(r.home)).toEqual([]);
  }, T);

  test("dm --project rejects a malformed project name", () => {
    const r = runCli(["dm", "someone", "hello", "--as", "human", "--project", "a/b"]);
    expect(r.code).toBe(1);
    expect(stored(r.home)).toEqual([]);
  }, T);
});
