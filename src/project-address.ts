// Project-scoped addressing (#93): `codex.<project>` / `pi.<project>` / `claude.<project>`
// pick the one reachable session of that kind working in <project>, and `dm --project`
// refuses a target that works somewhere else. Addresses are derived from live sessions,
// resolve only on a unique match, and need no alias table (#12).
//
// Reachability is the same evidence `ocs who` uses (CLAUDE.md rule 10): a Codex thread is
// reachable when a verified process holds its rollout / the daemon has it loaded (both show
// up as `livePid`) or a Desktop renderer claims it. Rollout history alone never counts.

import { workspaceAliasForCwd } from "./claude-address.ts";
import { codexDaemonSnapshot, primeCodexDaemon } from "./codex-daemon.ts";
import { codexDesktopIpcAvailable, discoverCodexDesktopOwners } from "./codex-ipc.ts";
import { codexThreadLivePid } from "./codex-queue.ts";
import { codexSessionsRoot, listCodexSessions } from "./codex-sessions.ts";
import { readOcsName } from "./names.ts";
import { piTargetName } from "./pi-sessions.ts";
import { buildRoster, type ResolvedDmTarget, type RosterEntry } from "./roster.ts";
import { NAME_RE } from "./store.ts";

export type ProjectKind = "codex" | "pi" | "claude";

const PROJECT_ADDRESS_RE = /^(codex|pi|claude)\.(.+)$/i;

/** `codex.my-api` → `{ kind: "codex", project: "my-api" }`; anything else → null. */
export function parseProjectAddress(target: string): { kind: ProjectKind; project: string } | null {
  if (!NAME_RE.test(target)) return null;
  const match = PROJECT_ADDRESS_RE.exec(target);
  if (match === null || !NAME_RE.test(match[2]!)) return null;
  return { kind: match[1]!.toLowerCase() as ProjectKind, project: match[2]! };
}

/** Names `ocs rename` must not hand out: they would shadow project addressing. */
export function isProjectAddressShaped(name: string): boolean {
  return parseProjectAddress(name) !== null;
}

export function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export interface ProjectCandidate {
  kind: ProjectKind;
  /** What `ocs dm` should be handed for this session. */
  target: string;
  /** What to show a human: the address from `ocs who`. */
  address: string;
  label: string | null;
  project: string;
}

export type ProjectPick =
  | { ok: true; candidate: ProjectCandidate }
  | { ok: false; reason: "none" | "ambiguous"; candidates: ProjectCandidate[] };

function candidateOf(entry: RosterEntry): ProjectCandidate | null {
  if (entry.kind === "codex-task" && entry.project !== undefined) {
    return { kind: "codex", target: entry.threadId, address: entry.ocsName ?? entry.target, label: entry.summary, project: entry.project };
  }
  if (entry.kind === "pi" && entry.project !== undefined) {
    return { kind: "pi", target: piTargetName(entry.sessionId), address: entry.ocsName ?? entry.target, label: entry.name, project: entry.project };
  }
  if (entry.kind === "claude" && entry.project !== undefined) {
    // A shadow-free workspace alias keeps the stable workspace DM channel; otherwise fall
    // back to the session's own id so the pick is still exactly this session.
    const target = entry.workspaceAlias ?? entry.id ?? entry.name;
    return { kind: "claude", target, address: entry.ocsName ?? entry.workspaceAlias ?? entry.name, label: null, project: entry.project };
  }
  return null;
}

/**
 * Pure selection: only entries `reachable` accepts, of `kind`, in `project` (case-insensitive).
 * Exactly one → ok. Zero or several → refuse; the caller must not store anything.
 */
export function pickProjectTarget(
  entries: readonly RosterEntry[],
  kind: ProjectKind,
  project: string,
  reachable: (entry: RosterEntry) => boolean,
): ProjectPick {
  const candidates = entries
    .filter((entry) => reachable(entry))
    .map(candidateOf)
    .filter((candidate): candidate is ProjectCandidate =>
      candidate !== null && candidate.kind === kind && sameProject(candidate.project, project));
  if (candidates.length === 1) return { ok: true, candidate: candidates[0]! };
  return { ok: false, reason: candidates.length === 0 ? "none" : "ambiguous", candidates };
}

export interface ProjectDeps {
  /** Refresh the daemon-loaded thread snapshot before reading the (synchronous) roster. */
  prime: (env: NodeJS.ProcessEnv) => Promise<void>;
  roster: (env: NodeJS.ProcessEnv) => { entries: RosterEntry[]; codexIpc: boolean };
  desktopOwners: (threadIds: string[], env: NodeJS.ProcessEnv) => Promise<Record<string, string>>;
}

const defaultDeps: ProjectDeps = {
  prime: async (env) => { await primeCodexDaemon(env); },
  roster: (env) => buildRoster(env),
  desktopOwners: (threadIds, env) => discoverCodexDesktopOwners(threadIds, { env }),
};

/** Every reachable session of the roster, with the same Desktop-claim rule as `ocs who`. */
async function reachableRoster(env: NodeJS.ProcessEnv, deps: ProjectDeps, project?: string) {
  await deps.prime(env);
  const roster = deps.roster(env);
  const unclaimed = roster.entries.filter((entry) => entry.kind === "codex-task" && entry.livePid === null &&
    (project === undefined || (entry.project !== undefined && sameProject(entry.project, project))));
  let owners: Record<string, string> = {};
  if (roster.codexIpc && unclaimed.length > 0) {
    try {
      owners = await deps.desktopOwners(unclaimed.map((entry) => entry.kind === "codex-task" ? entry.threadId : ""), env);
    } catch {
      // Socket/router failure: no Desktop evidence. Verified rollout holders still count.
    }
  }
  const reachable = (entry: RosterEntry): boolean =>
    entry.kind !== "codex-task" || entry.livePid !== null || owners[entry.threadId] !== undefined;
  return { entries: roster.entries, reachable };
}

export type ProjectExpansion =
  | { kind: "passthrough"; target: string }
  | { kind: "expanded"; target: string; candidate: ProjectCandidate }
  | { kind: "refused"; reason: "none" | "ambiguous"; projectKind: ProjectKind; project: string; candidates: ProjectCandidate[] };

/**
 * `codex.<project>` → the one reachable Codex thread working in <project>. Not the syntax,
 * or a name someone registered with `ocs rename` before this existed → passthrough (the
 * registered name keeps winning).
 */
export async function expandProjectAddress(
  target: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ProjectDeps = defaultDeps,
): Promise<ProjectExpansion> {
  const parsed = parseProjectAddress(target);
  if (parsed === null || readOcsName(target, env) !== null) return { kind: "passthrough", target };
  const { entries, reachable } = await reachableRoster(env, deps, parsed.project);
  const pick = pickProjectTarget(entries, parsed.kind, parsed.project, reachable);
  if (pick.ok) return { kind: "expanded", target: pick.candidate.target, candidate: pick.candidate };
  return { kind: "refused", reason: pick.reason, projectKind: parsed.kind, project: parsed.project, candidates: pick.candidates };
}

/** Project of a Codex thread from its rollout head, else the daemon's loaded-thread record. */
export function projectOfCodexThread(threadId: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const id = threadId.toLowerCase();
  const [session] = listCodexSessions(codexSessionsRoot(env), { limit: 1, threadIds: new Set([id]), headBytes: 16 * 1024 });
  return workspaceAliasForCwd(session?.cwd ?? codexDaemonSnapshot().threads.get(id)?.cwd ?? null);
}

/** The project of a resolved DM target, or null when it cannot be established. */
export function projectOfResolved(resolved: ResolvedDmTarget, env: NodeJS.ProcessEnv = process.env): string | null {
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) return projectOfCodexThread(resolved.threadId, env);
  if (resolved.kind === "pi") return workspaceAliasForCwd(resolved.piSession?.cwd);
  if (resolved.kind === "claude") return workspaceAliasForCwd(resolved.claude?.cwd);
  return null;
}

export type ProjectCheck = { ok: true } | { ok: false; reason: "unknown" } | { ok: false; reason: "mismatch"; actual: string };

export interface CheckDeps {
  prime: (env: NodeJS.ProcessEnv) => Promise<void>;
  /** Live evidence for a Codex thread: verified rollout holder / daemon loaded, or Desktop claim. */
  codexReachable: (threadId: string, env: NodeJS.ProcessEnv) => Promise<boolean>;
  project: (resolved: ResolvedDmTarget, env: NodeJS.ProcessEnv) => string | null;
}

const defaultCheckDeps: CheckDeps = {
  prime: async (env) => { await primeCodexDaemon(env); },
  codexReachable: async (threadId, env) => {
    if (codexThreadLivePid(threadId, env) !== null) return true;
    if (!codexDesktopIpcAvailable(env)) return false;
    try {
      const owners = await discoverCodexDesktopOwners([threadId], { env });
      return Object.keys(owners).some((id) => id.toLowerCase() === threadId.toLowerCase());
    } catch {
      return false;
    }
  },
  project: projectOfResolved,
};

/**
 * `dm --project <name>`: the target must be a live session whose project is <name>. A
 * parked/offline target, another kind, or an unknown working directory cannot be confirmed
 * and is refused — the caller stores nothing either way.
 */
export async function checkTargetProject(
  resolved: ResolvedDmTarget,
  expected: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: CheckDeps = defaultCheckDeps,
): Promise<ProjectCheck> {
  let live: boolean;
  if (resolved.kind === "codex-task" && resolved.threadId !== undefined) {
    await deps.prime(env);
    live = await deps.codexReachable(resolved.threadId, env);
  } else if (resolved.kind === "pi") {
    live = resolved.piSession !== undefined;
  } else if (resolved.kind === "claude") {
    live = resolved.claude !== undefined;
  } else {
    return { ok: false, reason: "unknown" };
  }
  if (!live) return { ok: false, reason: "unknown" };
  const actual = deps.project(resolved, env);
  if (actual === null) return { ok: false, reason: "unknown" };
  return sameProject(actual, expected) ? { ok: true } : { ok: false, reason: "mismatch", actual };
}

/** Other reachable sessions of the same kind in `project`, for "try this instead" hints. */
export async function liveProjectPeers(
  kind: ProjectKind,
  project: string,
  exclude: string,
  env: NodeJS.ProcessEnv = process.env,
  deps: ProjectDeps = defaultDeps,
): Promise<ProjectCandidate[]> {
  try {
    const { entries, reachable } = await reachableRoster(env, deps, project);
    const pick = pickProjectTarget(entries, kind, project, reachable);
    const all = pick.ok ? [pick.candidate] : pick.candidates;
    return all.filter((candidate) => candidate.target.toLowerCase() !== exclude.toLowerCase()).slice(0, 3);
  } catch {
    return [];
  }
}
