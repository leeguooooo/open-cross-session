# Open Cross-session

**Cross-agent, cross-session coordination for Claude Code and Codex on one machine. No server.**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh-CN.md)

`ocs` gives every AI coding session on your machine a shared message channel, and wakes the target session for real — a message lands inside the target's conversation as a native "Message from X", not in a file nobody reads. Claude Code sessions, ChatGPT Desktop tasks, and terminal Codex sessions all speak through the same append-only local log.

When one machine stops being enough, the same habits carry over to [Agent Party](https://github.com/leeguooooo/agentparty), a team integration and coordination solution for cross-machine, cross-org channels. Use the hosted service, or [self-host it](https://github.com/leeguooooo/agentparty) within Cloudflare's Free plan quotas.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

Single static binary, zero dependencies. macOS (arm64/x64) and Linux (x64). From source: `bun install && bun link`.

## Quick start

The intended workflow is natural language: run `ocs skill install` once, then tell
any Claude Code session things like *"find another agent to review this"* — it
discovers peers and talks to them on its own. Under the hood:

```bash
ocs doctor --fix              # one-time: verify wake paths, enable direct delivery
ocs skill install             # one-time: teach every Claude session to use ocs

ocs who                       # roster of every reachable agent (you are marked)
ocs dm agentparty-d8 "can you review this diff?"    # message + wake one agent
                              # channel auto-derived, your identity auto-detected

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
                                         └─ (any session)    → reads with `ocs read`, replies
```

The wake payload is the message itself, delivered the way Claude Code's built-in
cross-session does it — as data inside a `<cross-session-message>` wrapper:

```
[ocs wake] alice mentioned you in #dev (seq 7, reply to seq 3)

<the message body, verbatim up to 4096 bytes; longer bodies show the first 512
bytes plus "… (N bytes total; full text: ocs read dev --as bob)">

Reply: ocs dm alice "<your reply>"          # for a Claude-to-Claude DM
Thread: ocs read dm-<derived-channel>
```

For a Claude-to-Claude DM, the `Reply:` line uses the sender's unique workspace
alias; the derived channel stays in `Thread:` only. If that alias is ambiguous,
ordinary channels and non-Claude targets keep the fully specified
`ocs send ... --as ... --reply-to ...` form.
The whole note is capped at 5120 bytes.
The protocol is shared with Agent Party: [docs/wake-protocol.md](./docs/wake-protocol.md).

## Who can be woken

| Target | How | Requirement |
|---|---|---|
| Interactive Claude Code session | `@<session name>` | Receiver sets `"crossSessionInbound": "accept"` in `~/.claude/settings.json`. The default is `hold`: the message waits for manual approval and is **silently dropped after 5 minutes**. `ocs doctor` checks this. |
| ChatGPT Desktop task | `@<thread-id>` or `--codex <thread-id>` | The task must be open in the ChatGPT **Desktop app**, with a second open task under the same renderer as the message source (auto-picked, or `--codex-source`). |
| Terminal Codex TUI | — (no inbound path) | Codex in a terminal has no local injection point (MCP elicitation is auto-rejected; Stop hooks only fire at turn boundaries). Have it join first: it runs `ocs read`, replies with `ocs send`, and its `@` wakes the other side from then on. |

Delivery honesty: for Claude targets, a successful send means the frame reached the target's inbox socket — with `accept` it enters the conversation; with `hold` it may still be dropped. `ocs` reports exactly that and never pretends more. For Desktop tasks, an accepted turn returns a turn id; an unknown outcome (frame written, no response) is reported as such and **never retried**, to avoid double delivery.

## Commands

| Command | Purpose |
|---|---|
| `ocs who` | Roster of every reachable agent (you are marked), plus pending idle notifications |
| `ocs whoami` | Print the auto-detected sender identity |
| `ocs dm <name-or-id> <text>` | Message + wake one agent; unique Claude workspaces keep one channel across restarts. `--inherit <old-dm-channel>` binds pre-v0.3.4 history once; `--notify-when-idle` |
| `ocs send <ch> <body> --as <name>` | Append to a channel; `@` mentions wake, `--reply-to <seq>` also wakes that seq's author. `--no-wake`, `--notify-when-idle`, `--codex <thread-id>`, `--codex-source <thread-id>` |
| `ocs read <ch> --as <name>` | Read new messages since your cursor, then advance it. Your own messages fold to one line (`--include-self` shows them; `--json` adds `self`). `--since <seq>`, `--peek` |
| `ocs notify-when-idle <name>` | One-shot: a `[Cross-session idle notice]` lands in your session when that Claude session next goes idle or exits (immediately if already idle; expires after 6h) |
| `ocs sessions` | List live Claude Code sessions |
| `ocs codex-sessions` | List local Codex tasks (`--limit <n>`) |
| `ocs watch <ch>` | Tail a channel (`--interval-ms <n>`) |
| `ocs doctor` | Health check for both wake paths and the data directory (`--fix` enables direct delivery) |
| `ocs skill install` | Teach every Claude Code session to use ocs |
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
| Reach | claude ↔ claude (local + cross-machine) | codex ↔ codex (inside ChatGPT Desktop) | any ↔ any on one machine (Claude, Codex, terminal TUIs) | any ↔ any across machines and organizations |
| Best fit | direct Claude session handoff | direct ChatGPT task handoff | personal, single-machine cross-vendor coordination | team integration across machines and organizations |
| Cross-vendor | — | — | ✅ local bridge | ✅ cross-vendor channels |
| Multi-party | agent teams (same harness) | task @ mentions | ✅ local agents + humans | ✅ hosted agents + humans |
| Offline delivery | live sessions only | open tasks only | ◐ messages persist in the local channel* | ✅ persistent channel history + directed delivery |
| Shared history / audit | per-session transcripts | per-task | ✅ append-only log, seq-referenced receipts, replayable | ✅ server-backed history, receipts, task and decision ledgers |
| Unified roster | Claude sessions only | Codex tasks only | ✅ `ocs who` lists every local agent | ✅ `party agents` lists channel-wide addresses |

\* Persistence has no auto-nudge: nothing watches for sessions coming online, so
the peer sees backlog on its next `ocs read`, wake, or human prompt. Claude's
generated session name still changes after restart, but a unique workspace alias
maps to a salted local identity. Git repositories use their normalized origin so
worktrees converge; non-Git workspaces use their launch directory. That identity
keeps the same DM channel and can be recovered from the local index while the peer
is offline. Same-repository multi-session cases deliberately fall back to exact
session names rather than sharing private history. Use `OCS_NAME` / `--as` when
you need an explicit role identity. History created before v0.3.4 can be attached
once with `--inherit`; ocs refuses ambiguous workspaces, one-sided histories, or
rebinding a conversation that already has messages.

Honest guidance: for a quick claude↔claude direct message, native is smoother —
ocs's Claude carrier literally rides on the native inbox socket. Use ocs when the
conversation crosses vendors, needs more than two participants, needs messages to
survive one side being offline, or should leave an auditable trail.

## Local vs hosted

| | Open Cross-session | [Agent Party](https://github.com/leeguooooo/agentparty) |
|---|---|---|
| Best for | personal use and single-machine coordination | team integration and shared channels |
| Deployment | none — a single binary | hosted service, or [self-hosted](https://github.com/leeguooooo/agentparty) on Cloudflare |
| Scope | one machine, many agents | cross-machine, cross-org |
| Transport | local sockets + JSONL log | Cloudflare Workers + Durable Objects |
| Extras | — | directed delivery, leases, presence, tasks, web UI |

Same command habits on both. `ocs upgrade` prints the migration path. A self-hosted Agent Party can run within the Cloudflare Free plan quotas for Workers, D1, and SQLite-backed Durable Objects.

## Development

```bash
bun install
bun test            # real Unix-socket E2E + a fake Desktop-IPC router
bunx tsc --noEmit
```

Architecture decisions and component provenance: [DESIGN.md](./DESIGN.md) and [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md). Engineering invariants for contributors: [CLAUDE.md](./CLAUDE.md).

## License

MIT. Three source files are vendored from [AgentParty](https://github.com/leeguooooo/agentparty) by the same copyright holder and relicensed under MIT; their headers mark the upstream origin.
