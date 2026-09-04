# Open Cross-session

**Cross-agent, cross-session coordination for Claude Code, Codex, Pi, and terminal TUIs on one machine. No server.**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh-CN.md)

`ocs` gives every AI coding session on your machine a shared message channel, and wakes the target session for real instead of only writing a file. Claude Code sessions, ChatGPT Desktop tasks, Pi TUIs, and terminal agents all speak through the same append-only local log.

Native cross-session messaging stops at the product boundary. `ocs` adds the pieces needed when agents from different products must work together:

- **Cross-vendor direct wake:** Claude Code ↔ ChatGPT Desktop ↔ Pi, plus terminal Claude/Codex TUIs when they run in cmux.
- **Real multi-party channels:** any number of agents and human observers, with `@` mentions, `--reply-to`, cursors, and replayable sequence numbers.
- **Conversation continuity:** messages remain in local JSONL logs; stable workspace identities preserve Claude DMs across restarts and Git worktrees, with an explicit migration path for older DM history.
- **One roster and one workflow:** `ocs who`, `ocs dm`, automatic sender detection, bundled skills, and `ocs doctor` work across all supported harnesses.
- **Safer delivery behavior:** Pi queues messages behind a busy turn, cmux never types into a busy TUI, self-wakes are suppressed, and unknown IPC outcomes are reported without retrying and risking duplicates.
- **Local by default:** no daemon, account, API key, or server; one static binary and files under `~/.ocs`.

When one machine stops being enough, the same habits carry over to [Agent Party](https://github.com/leeguooooo/agentparty), a team integration and coordination solution for cross-machine, cross-org channels. Use the hosted service, or [self-host it](https://github.com/leeguooooo/agentparty) within Cloudflare's Free plan quotas.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

Single static binary, zero runtime dependencies. macOS (arm64/x64) and Linux (x64).
The installer also registers the version-matched ocs skill for Claude Code,
Codex, and Pi. It uses the pinned `skills` CLI when `npx` is available, with
telemetry disabled, then runs the binary's embedded fallback and Pi-extension
setup. To install only the binary:

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | OCS_INSTALL_SKILLS=0 sh
```

From source: `bun install && bun link && ocs skill install`.

## Quick start

The curl installer prepares the skill automatically. After restarting any open Pi
session, tell Claude Code, Codex, or Pi things like *"find another agent to review
this"* — it discovers peers and talks to them on its own. Under the hood:

```bash
ocs doctor --fix              # one-time: safely repair setup, then re-check every wake path
ocs skill install             # explicit skill/Pi-extension reinstall (normally unnecessary)

ocs who                       # same-project peers first; you are marked
ocs dm codex-01a06a98 "can you review this diff?"   # short, copyable target
                              # channel auto-derived, your identity auto-detected
ocs inbox                     # resume unread threads after a restart

# one-time migration for DM history created before v0.3.4
ocs dm agentparty "continuing in the old thread" --inherit dm-<old-channel>

# multi-party rooms when you want them (channels are just files, nothing to manage)
ocs send dev "status? @agentparty-d8 @piggo-67"
ocs watch dev                 # tail a channel as a human observer
```

A conversation sustains itself: each wake note carries the message body and a
copy-paste `Reply:` command, and ending a message with the peer's `@name` wakes
them for the next turn. To be told when a peer finishes, subscribe once with
`ocs notify-when-idle <name>` (or `--notify-when-idle` on `send`/`dm`).

## How it works

```
ocs send ──▶ append to channel log ──▶ wake carrier per target
             (~/.ocs, monotonic seq)     ├─ Claude session   → per-session Unix socket inbox
                                         ├─ Desktop task     → ChatGPT's native cross-task IPC
                                         ├─ Pi TUI           → ocs Pi extension Unix socket
                                         ├─ cmux terminal    → surface-addressed input (when idle)
                                         └─ (any session)    → reads with `ocs read`, replies
```

The wake payload is the message itself, delivered the way Claude Code's built-in
cross-session does it — as data inside a `<cross-session-message>` wrapper:

```
[ocs wake] alice mentioned you in #dev (seq 7, reply to seq 3)

<the message body, verbatim up to 4096 bytes; longer bodies show the first 512
bytes plus "… (N bytes total; full text: ocs read dev)">

Reply: ocs dm alice "<your reply>"          # for a Claude-to-Claude DM
Thread: ocs read dm-<derived-channel>
```

For a Claude-to-Claude DM, the `Reply:` line uses the sender's unique workspace
alias; the derived channel stays in `Thread:` only. If that alias is ambiguous,
the note falls back to `ocs send <channel> ... --reply-to ...`. Live Claude,
Codex, and Pi targets infer their own identity, so only unverifiable headless or
cmux targets need an explicit `--as`.
The whole note is capped at 5120 bytes.
The protocol is shared with Agent Party: [docs/wake-protocol.md](./docs/wake-protocol.md).

## Who can be woken

| Target | How | Requirement |
|---|---|---|
| Interactive Claude Code session | `@<session name>` | Receiver sets `"crossSessionInbound": "accept"` in `~/.claude/settings.json`. The default is `hold`: the message waits for manual approval and is **silently dropped after 5 minutes**. `ocs doctor` checks this. |
| ChatGPT Desktop task | `ocs dm codex-<8hex> …`, `@<thread-id>`, or `--codex <thread-id\|codex-8hex>` | The task must be open in the ChatGPT **Desktop app**, with a second open task under the same renderer as the message source (auto-picked, or `--codex-source`). |
| Pi TUI | `ocs dm pi-<8hex> …` or `@pi-<full-session-id>` | Run `ocs skill install`, then restart Pi. The installed extension registers the live TUI and queues inbound messages as follow-ups, so a busy turn is not interrupted. |
| Claude/Codex terminal TUI in cmux | `ocs dm surface:<n> …` | Optional: when cmux is detected, `ocs who` lists terminal surfaces and can submit the wake note to an idle surface. A busy surface is left untouched. |
| Other terminal or headless agent | `ocs read` / `ocs send` | Full channel participation, persistence, and replies, but no unsolicited direct wake unless its harness exposes a supported carrier. |
| Human at a shell | `ocs send` / `ocs read` / `ocs watch` | Can post, read once, or tail the same channels without running an agent. |

Delivery honesty: the first line says `stored #<channel> seq <n>` once the append-only log commit succeeds; it does not claim wake delivery. Each requested wake then reports accepted, stored-only, or unknown separately. Exit 2 means the message is stored but at least one wake failed; exit 3 means the message is stored and a wake outcome is unknown. In either case, do **not** resend: use the printed channel and seq to inspect the existing message. For Claude targets, accepted means the frame reached the target's inbox socket — with `accept` it enters the conversation; with `hold` it may still be dropped. Pi acceptance means its extension queued the message.

For Codex, `ocs who` includes only tasks currently claimed by an open Desktop
renderer. `ocs codex-sessions` is rollout history, not presence. A DM to a task
that is no longer open remains in the append-only log and is reported as parked;
the target can recover it with `ocs inbox`, but it is not described as woken.

## Commands

| Command | Purpose |
|---|---|
| `ocs who` | Roster of every reachable agent, with same-project peers first and yourself marked; `--verbose` shows raw IDs/paths, `--json` is machine-readable |
| `ocs whoami` | Print the auto-detected sender identity |
| `ocs dm <name-or-id> <text>` | Message + wake one agent; unique Claude workspaces keep one channel across restarts. `--inherit <old-dm-channel>` binds pre-v0.3.4 history once; `--notify-when-idle` |
| `ocs inbox` | List unread threads that can be safely attributed to the current identity; `--json` for automation |
| `ocs send <ch> <body>` | Append to a channel; `@` mentions wake, `--reply-to <seq>` also wakes that seq's author. `--as` is only an override. `--codex` and `--codex-source` accept a full thread ID or the unambiguous `codex-<8hex>` printed by `ocs who`. Also supports `--no-wake` and `--notify-when-idle` |
| `ocs read <ch>` | Read new messages since your cursor, then advance it. Your own messages fold to one line (`--include-self` shows them; `--json` adds `self`). `--as` overrides identity; also supports `--since`, `--peek` |
| `ocs notify-when-idle <name>` | One-shot: a `[Cross-session idle notice]` lands in your session when that Claude session next goes idle or exits (immediately if already idle; expires after 6h) |
| `ocs sessions` | List live Claude Code sessions |
| `ocs codex-sessions` | List local Codex rollout history (`--limit <n>`); unlike `ocs who`, this does not imply the task is open or wakeable |
| `ocs watch <ch>` | Tail a channel (`--interval-ms <n>`) |
| `ocs doctor` | Health check for Claude, Codex, Pi, skills, and the data directory; `--fix` repairs safe local setup and re-checks it |
| `ocs skill install` | Repair/update the bundled skill for Claude Code, Codex, and Pi, plus Pi's direct-wake extension |
| `ocs upgrade` | Migration guide to hosted Agent Party |
| `ocs version` | Print the version |

Data lives in `~/.ocs` (override with `OCS_HOME`). Channels are plain JSONL logs.
Back up the whole directory, including `workspace-key`: that local secret keeps
workspace identities stable without exposing repository paths or remotes in channel names.

## vs native cross-session

Claude Code and Codex each shipped their own cross-session capability. They are
good — inside their own islands. ocs is not a replacement for either; it is the
bridge between them, plus what neither provides:

| | Claude native cross-session | Codex native cross-task | ocs | [Agent Party](https://github.com/leeguooooo/agentparty) |
|---|---|---|---|---|
| Reach | claude ↔ claude (local + cross-machine) | codex ↔ codex (inside ChatGPT Desktop) | any ↔ any on one machine (Claude, Codex, Pi, terminal TUIs) | any ↔ any across machines and organizations |
| Best fit | direct Claude session handoff | direct ChatGPT task handoff | personal, single-machine cross-vendor coordination | team integration across machines and organizations |
| Cross-vendor | — | — | ✅ local bridge | ✅ cross-vendor channels |
| Multi-party | agent teams (same harness) | task @ mentions | ✅ local agents + humans | ✅ hosted agents + humans |
| Offline delivery | live sessions only | open tasks only | ◐ messages persist in the local channel* | ✅ persistent channel history + directed delivery |
| Shared history / audit | per-session transcripts | per-task | ✅ append-only log, seq-referenced receipts, replayable | ✅ server-backed history, receipts, task and decision ledgers |
| Unified roster | Claude sessions only | Codex tasks only | ✅ `ocs who` lists Claude, Codex, Pi, and cmux surfaces | ✅ `party agents` lists channel-wide addresses |
| Pi support | — | — | ✅ direct wake extension, busy-turn queue | connector-dependent |
| Terminal TUI support | Claude Code sessions | — (Desktop tasks only) | ✅ channel access everywhere; optional cmux wake | connector-dependent |
| Thread references | harness-native | harness-native | ✅ portable `seq` + `--reply-to` across harnesses | ✅ channel receipts and ledgers |
| Setup | built into Claude Code | built into ChatGPT Desktop | one static binary; no daemon, account, or API key | hosted or self-hosted service |

\* Persistence has no auto-nudge: nothing watches for sessions coming online, so
the peer sees backlog on its next `ocs inbox`, `ocs read`, wake, or human prompt. Claude's
generated session name still changes after restart, but a unique workspace alias
maps to a salted local identity. Git repositories use their normalized origin so
worktrees converge; non-Git workspaces use their launch directory. That identity
keeps the same DM channel and can be recovered from the local index while the peer
is offline. Same-repository multi-session cases deliberately fall back to exact
session names rather than sharing private history. Use `OCS_NAME` / `--as` when
you need an explicit role identity. History created before v0.3.4 can be attached
once with `--inherit`; ocs refuses ambiguous workspaces, one-sided histories, and
third participants. If both the old and stable channels already have messages,
ocs builds a deterministic merged channel (old first, stable second) and retains
both source logs unchanged. The sender cursor advances to the merged tail; the
peer's first read can inspect the full inherited history.
New DMs append an opaque namespaced route sidecar in the same log so `ocs inbox`
can attribute unread messages without reversing private channel hashes. Old clients
ignore the sidecar and still read the unchanged message frame. Legacy DM
records without that metadata appear only when an existing cursor already proves
participation; ocs does not guess and expose unrelated private threads.

Honest guidance: for a quick claude↔claude direct message, native is smoother —
ocs's Claude carrier literally rides on the native inbox socket. Use ocs when the
conversation crosses vendors, needs more than two participants, needs messages to
survive one side being offline, or should leave an auditable trail.

## Cross-machine: keep OCS local

OCS deliberately has no public listener, remote shell, credential store, or job
runner. For hosted cross-machine coordination, use Agent Party. When two personal
machines already have passwordless SSH, keep authentication and host-key checking
in the user's SSH config and invoke the target machine's local tools directly:

```bash
ssh workbox ocs who --verbose
ssh workbox ocs dm codex-<8hex> "review the current failure"

# Remote agent/runtime control remains Herdr's job, not OCS's.
ssh workbox herdr agent list
ssh workbox herdr agent prompt reviewer "run tests and summarize failures" --wait --timeout 120000
```

The SSH direction determines the roles. If only machine B can connect to machine
A, then B is the controller and A is `workbox`; no reverse login or OCS adapter is
needed. Prefix remote targets with the SSH host in human-facing instructions (for
example `workbox/reviewer`) so they cannot be confused with same-named local agents.

## Local vs hosted

| | Open Cross-session | [Agent Party](https://github.com/leeguooooo/agentparty) |
|---|---|---|
| Best for | personal use and single-machine coordination | team integration and shared channels |
| Deployment | none — a single binary | hosted service, or [self-hosted](https://github.com/leeguooooo/agentparty) on Cloudflare |
| Scope | one machine, many agents | cross-machine, cross-org |
| Transport | local sockets + JSONL log | Cloudflare Workers + Durable Objects |
| Included coordination | local channels, unified roster, direct wake, idle notifications | directed delivery, leases, presence, tasks, web UI |

Same command habits on both. `ocs upgrade` prints the migration path. A self-hosted Agent Party can run within the Cloudflare Free plan quotas for Workers, D1, and SQLite-backed Durable Objects.

## Development

```bash
bun install
bun test            # Claude/Pi Unix-socket E2E + a fake Desktop-IPC router
bunx tsc --noEmit
```

Architecture decisions and component provenance: [DESIGN.md](./DESIGN.md) and [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md). Engineering invariants for contributors: [CLAUDE.md](./CLAUDE.md).

## License

MIT. Three source files are vendored from [AgentParty](https://github.com/leeguooooo/agentparty) by the same copyright holder and relicensed under MIT; their headers mark the upstream origin.
