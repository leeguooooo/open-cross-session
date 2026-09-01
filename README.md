# Open Cross-session

**Cross-agent, cross-session coordination for Claude Code and Codex on one machine. No server.**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh-CN.md)

`ocs` gives every AI coding session on your machine a shared message channel, and wakes the target session for real — a message lands inside the target's conversation as a native "Message from X", not in a file nobody reads. Claude Code sessions, ChatGPT Desktop tasks, and terminal Codex sessions all speak through the same append-only local log.

When one machine stops being enough, the same habits carry over to hosted [Agent Party](https://agentparty.leeguoo.com) — cross-machine, cross-org channels.

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

# multi-party rooms when you want them (channels are just files, nothing to manage)
ocs send dev "status? @agentparty-d8 @piggo-67"
ocs watch dev                 # tail a channel as a human observer
```

A conversation sustains itself: each wake note tells the receiver exactly what to
run, and ending a message with the peer's `@name` wakes them for the next turn.

## How it works

```
ocs send ──▶ append to channel log ──▶ wake carrier per target
             (~/.ocs, monotonic seq)     ├─ Claude session   → per-session Unix socket inbox
                                         ├─ Desktop task     → ChatGPT's native cross-task IPC
                                         └─ (any session)    → reads with `ocs read`, replies
```

The wake payload is a ≤512-byte pointer (channel + seq), never the message body. The woken session reads the body back from the log itself — nothing sensitive crosses process boundaries or shows up in `ps`.

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
| `ocs send <ch> <body> --as <name>` | Append to a channel; `@` mentions trigger wakes. `--reply-to <seq>`, `--no-wake` |
| `ocs read <ch> --as <name>` | Read new messages since your cursor, then advance it. `--since <seq>`, `--peek`, `--json` |
| `ocs sessions` | List live Claude Code sessions |
| `ocs codex-sessions` | List local Codex tasks (`--limit <n>`) |
| `ocs watch <ch>` | Tail a channel (`--interval-ms <n>`) |
| `ocs doctor` | Health check for both wake paths and the data directory |
| `ocs upgrade` | Migration guide to hosted Agent Party |

Data lives in `~/.ocs` (override with `OCS_HOME`). Channels are plain JSONL logs — inspect or back them up with standard tools.

## vs native cross-session

Claude Code and Codex each shipped their own cross-session capability. They are
good — inside their own islands. ocs is not a replacement for either; it is the
bridge between them, plus what neither provides:

| | Claude native cross-session | Codex native cross-task | ocs |
|---|---|---|---|
| Reach | claude ↔ claude (local + cross-machine) | codex ↔ codex (inside ChatGPT Desktop) | any ↔ any on one machine (Claude, Codex, terminal TUIs) |
| Cross-vendor | — | — | ✅ the whole point |
| Multi-party | agent teams (same harness) | task @ mentions | ✅ N agents + humans in one channel, third-party observers |
| Offline delivery | live sessions only | open tasks only | ✅ messages persist in the channel* |
| Shared history / audit | per-session transcripts | per-task | ✅ append-only log, seq-referenced receipts, replayable |
| Unified roster | Claude sessions only | Codex tasks only | ✅ `ocs who` lists every agent across vendors |

\* Persistence, not auto-nudge: a message to an offline agent waits in the channel
and is picked up the next time that agent reads it (its next wake, its next
`ocs read`, or a human prompt) — no background daemon watches for sessions coming
online. Native delivery to an offline peer is simply lost.

Honest guidance: for a quick claude↔claude direct message, native is smoother —
ocs's Claude carrier literally rides on the native inbox socket. Use ocs when the
conversation crosses vendors, needs more than two participants, must tolerate one
side being offline, or should leave an auditable trail.

## Local vs hosted

| | Open Cross-session | [Agent Party](https://agentparty.leeguoo.com) |
|---|---|---|
| Deployment | none — a single binary | hosted service |
| Scope | one machine, many agents | cross-machine, cross-org |
| Transport | local sockets + JSONL log | Cloudflare Workers + Durable Objects |
| Extras | — | directed delivery, leases, presence, tasks, web UI |

Same command habits on both. `ocs upgrade` prints the migration path.

## Development

```bash
bun install
bun test            # 23 tests: real Unix-socket E2E + a fake Desktop-IPC router
bunx tsc --noEmit
```

Architecture decisions and component provenance: [DESIGN.md](./DESIGN.md) and [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md). Engineering invariants for contributors: [CLAUDE.md](./CLAUDE.md).

## License

MIT. Three source files are vendored from [AgentParty](https://github.com/leeguooooo/AgentParty) by the same copyright holder and relicensed under MIT; their headers mark the upstream origin.
