# Open Cross-session

**Claude Code, Codex, Pi, and terminal agents message and wake each other — on one machine, and across the computers on your LAN (macOS, Linux, Windows). No server, no account.**

[![ci](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml/badge.svg)](https://github.com/leeguooooo/open-cross-session/actions/workflows/ci.yml)
[![release](https://img.shields.io/github/v/release/leeguooooo/open-cross-session)](https://github.com/leeguooooo/open-cross-session/releases)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

[中文文档](./README.zh-CN.md)

https://github.com/user-attachments/assets/4c86fd18-f935-467b-ac23-5283d40bb63d

`ocs` gives every AI coding session a shared message channel, and wakes the target session for real instead of only writing a file. Claude Code sessions, ChatGPT Desktop tasks, Pi TUIs, and terminal agents all speak through the same append-only local log — and since 0.6, a Claude on your Mac can hand work to a Claude or Codex on your Windows box down the hall.

For repeatable planning, implementation, and review across independent sessions, pair OCS with [Session Flow](https://github.com/leeguooooo/session-flow).

## New in 0.6: agents across your computers

```bash
# machine A                         # machine B
ocs lan up                          ocs lan up
ocs lan pair   # prints a text  →   (paste it) ocs lan join k3m9q2xa… --addr …
# compare the 6-digit code, y  ←    shows the same 6-digit code
                                    ocs who --lan
                                    ocs dm claude-1a2b3c4d@mini "can you run the Windows build?"
```

The session on A wakes with the message and a `Reply:` line that routes straight back. Verified Mac ↔ Windows
(Claude Code 2.1 and ChatGPT Desktop Codex on both sides).

- **Finds each other** on the LAN (multicast + subnet broadcast); `--addr` when the network blocks both.
- **Pairing by copy-paste, no trust-on-first-use:** `ocs lan pair` prints a ready-to-send text carrying its key fingerprint; you approve the other side after both screens show the same 6-digit code.
- **Trust that runs out:** 8 hours by default, `--once` for a single message, `--forever` for your own devices.
- **Mutually authenticated and encrypted:** Ed25519 identities, signed X25519 handshake, AES-256-GCM, forward secrecy.
  Unpaired machines can only redeem a live code — nothing else.
- **Off by default.** `ocs lan up` starts it; `ocs lan autostart on` keeps it across logins.

Protocol and threat model: [docs/lan.md](./docs/lan.md). Setup details: [Cross-machine](#cross-machine).

Native cross-session messaging stops at the product boundary. `ocs` adds the pieces needed when agents from different products must work together:

- **Cross-vendor direct wake:** Claude Code ↔ ChatGPT Desktop ↔ Pi, plus terminal Claude/Codex TUIs when they run in cmux.
- **Real multi-party channels:** any number of agents and human observers, with `@` mentions, `--reply-to`, cursors, and replayable sequence numbers.
- **Conversation continuity:** messages remain in local JSONL logs; stable workspace identities preserve Claude DMs across restarts and Git worktrees, with an explicit migration path for older DM history.
- **Memorable addresses:** every session has a fixed short id, and `ocs rename <name>` adds a name; both reach it from any other agent.
- **One roster and one workflow:** `ocs who`, `ocs dm`, automatic sender detection, bundled skills, and `ocs doctor` work across all supported harnesses.
- **Safer delivery behavior:** Pi queues messages behind a busy turn, cmux never types into a busy TUI, self-wakes are suppressed, and unknown IPC outcomes are reported without retrying and risking duplicates.
- **Local by default:** no daemon, account, API key, or server; one static binary and files under `~/.ocs`.
- **Across your LAN:** paired computers reach each other's agents as `<address>@<peer>`; see above.

Machines on different networks work the same way once they share a virtual LAN (Tailscale, WireGuard, ZeroTier, or a company VPN): pair with the peer's VPN address. See [Different networks](#different-networks-a-virtual-lan).

## Name your sessions

Every session already has a fixed short id, such as `claude-7043ea85`,
`codex-01a06a98`, or `pi-01a09109`; `ocs who` lists them. Add a name that people
and agents can remember:

```bash
ocs rename reviewer                             # run inside the session (or just ask its agent)
ocs dm reviewer "take a look at this diff"      # reach it by name
ocs dm claude-7043ea85 "same session, by id"    # the id keeps working
ocs send dev "ready? @reviewer"                 # @name wakes it: Claude, Codex, or Pi
ocs rename --clear                              # drop the name
```

- Each session has at most one name; renaming releases the old one. Names are
  case-insensitive, use `A-Z a-z 0-9 . _ -`, and are at most 64 characters.
- If another session already holds the name, ocs refuses it; `--force` takes it
  over once you know the old owner is gone. A name equal to another live Claude
  session's exact name is rejected.
- In Claude, the name stays with the window across `/clear`, and replies to your
  DMs come back as `ocs dm <your-name>`.
- Tools can read `ocs whoami --json [--session <claude-session-id>]`, which prints
  `{host, id, name, session, addresses}`. Every entry in `addresses` works with `ocs dm`.
  In Codex it also prints `threadId`, the full thread UUID: the short `codex-<8hex>` id
  can be shared by Codex tasks started within about a minute of each other.

### Pair it with Claude Status Bar

[Claude Status Bar](https://github.com/leeguooooo/claude-code-usage-bar) (`cs`)
shows each session's ocs address on its own status-line row, for example
`ocs reviewer · claude-7043ea85`, so you can see who to message without running
`ocs who`. From v3.43.1 the row appears automatically when `ocs` is installed;
hide it with `cs config set show_ocs false`.

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/claude-code-usage-bar/main/install.sh | bash
```

### Run a workflow with Session Flow

[Session Flow](https://github.com/leeguooooo/session-flow) (`sflow`) uses OCS to
run workflows such as **Claude plans → Codex implements → Claude reviews**.
Each step selects its agent, model, and workspace. Dependencies determine when
steps start; ready independent steps run in parallel. Write steps use isolated
Git worktrees, and results remain available for inspection.

Session Flow manages the workflow and native TUI workers; OCS carries task
assignments and results. It uses the CLIs' existing authenticated accounts.
The current runtime supports Claude Code and Codex in tmux on **macOS/Linux**;
Windows users need WSL.

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | sh
# Define your steps and dependencies in workflow.json, then:
sflow validate workflow.json
sflow run workflow.json
```

See the [workflow example and setup](https://github.com/leeguooooo/session-flow#run)
and the [smoke workflow](https://github.com/leeguooooo/session-flow/blob/main/examples/smoke.json).

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex
```

Single static binary, zero runtime dependencies. macOS (arm64/x64), Linux (x64), and Windows (x64).
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
ocs dm webapp "continuing in the old thread" --inherit dm-<old-channel>

# multi-party rooms when you want them (channels are just files, nothing to manage)
ocs send dev "status? @webapp-d8 @piggo-67"
ocs watch dev                 # tail a channel as a human observer
```

Each wake note carries the message body and a copy-paste `Reply:` command for
requested answers, decisions and final results. Batch related findings; finish
an exchange without acknowledgement-only or thanks replies. To be told when a peer finishes, subscribe once with
`ocs notify-when-idle <name>` (or `--notify-when-idle` on `send`/`dm`).

For a local closing record or a workflow driver that actively reads results, use
`ocs dm <name> "<record>" --no-wake`. It preserves history/inbox and reports
`wake: skipped` without waking the model. The recipient sees it on its next read;
keep normal wake delivery for requested answers and urgent blockers. A threaded
record can use `ocs send <channel> "<record>" --reply-to <seq> --no-wake`.
Idle subscriptions and LAN DM cannot use `--no-wake`.

## How it works

```
ocs send ──▶ append to channel log ──▶ wake carrier per target
             (~/.ocs, monotonic seq)     ├─ Claude session   → per-session Unix socket inbox
                                         ├─ Desktop task     → ChatGPT's native cross-task IPC
                                         ├─ Pi TUI           → ocs Pi extension Unix socket
                                         ├─ Hermes session   → Hermes host WebSocket, queued behind a busy turn
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

For a Claude-to-Claude DM, the `Reply:` line uses the sender's ocs name when it
has one, otherwise its unique workspace alias; the derived channel stays in
`Thread:` only. With neither, the note falls back to
`ocs send <channel> ... --reply-to ...`. Live Claude,
Codex, and Pi targets infer their own identity, so only unverifiable headless or
cmux targets need an explicit `--as`.
The whole note is capped at 5120 bytes.
The protocol is shared with Agent Party: [docs/wake-protocol.md](./docs/wake-protocol.md).

## Antigravity CLI (`agy`)

On macOS, Linux, or Windows, authenticate in `agy`, then explicitly start its optional receiver:

```sh
ocs agy start --cwd /path/to/workspace
ocs dm agy "Review this project and report findings"
ocs agy status
ocs agy stop
```

The receiver queues turns, keeps conversation context per OCS channel, and sends
the final response back to the requester. It uses the agy CLI's existing login
and permissions. Windows can run the receiver too; paired LAN clients can delegate to it.
See [receiver setup and delivery semantics](docs/agy.md).

## Who can be woken

`ocs who` lists live sessions with a supported discovery/wake carrier, not every
installed AI app. [Grok Build](docs/grok.md) sessions use `grok --leader`; submit
the first prompt to create a resident conversation. Grok web/mobile apps are
not connected. If a supported session is missing, run
`ocs doctor` to check its setup; cmux is optional for native session discovery.

From a plain shell, choose your own sender name:

```sh
ocs dm <target-from-ocs-who> "hello" --as human
# --as may also precede the subcommand: ocs --as human dm <target> "hello"
```

| Target | How | Requirement |
|---|---|---|
| Interactive Claude Code session | `@<name>`, `@claude-<8hex>`, or `@<session name>` | Receiver sets `"crossSessionInbound": "accept"` in `~/.claude/settings.json`. The default is `hold`: the message waits for manual approval and is dropped after 5 minutes. Since 0.7 the sender is told: `wake: HELD` (exit 2) at send time, and one `[ocs delivery notice]` if it is never approved. `ocs doctor` checks the setting. |
| ChatGPT Desktop task / cmux Codex TUI | `ocs dm codex-<8hex> …`, `@<thread-id>`, or `--codex <thread-id\|codex-8hex>` | Desktop delivery needs the task open plus a second open task under the same renderer. If that path is definitely unavailable, ocs safely falls back to a uniquely matched, idle cmux surface that still has a live Codex process. |
| Pi TUI | `ocs dm pi-<8hex> …` or `@pi-<8hex>` | Run `ocs skill install`, then restart Pi. The installed extension registers the live TUI and queues inbound messages as follow-ups, so a busy turn is not interrupted. |
| Hermes Desktop session | `ocs dm hermes-<id> …` or `@hermes-<id>` (`ocs who` prints the id; `_` in Hermes' session id is written `.`) | Hermes Desktop (or `hermes serve`) running as the same user, with the session open. ocs submits through the host's own WebSocket with the busy-queue flag: an idle session starts a turn (`started a turn`), a busy one gets it after the current turn (`queued`) — nothing is interrupted. Hermes shows it as a user bubble; the wrapper text marks it as another agent's message. Inside Hermes, `ocs whoami` knows the session, so replies need no `--as`. |
| Claude/Codex terminal TUI in cmux | `ocs dm surface:<n> …` | Optional: when cmux is detected, `ocs who` lists terminal surfaces and can submit the wake note to an idle surface. A busy surface is left untouched. |
| Grok Build CLI | `ocs dm grok-<full-session-uuid> …` or `@grok-<full-session-uuid>` | Start with `grok --leader`, submit the first prompt, then use the address in `ocs who`. Native queue admission preserves busy turns and existing permissions. Web/mobile and standalone sessions are not connected. [Setup](docs/grok.md). |
| Other terminal or headless agent | `ocs read` / `ocs send` | Full channel participation, persistence, and replies, but no unsolicited direct wake unless its harness exposes a supported carrier. |
| Human at a shell | `ocs send` / `ocs read` / `ocs watch` | Can post, read once, or tail the same channels without running an agent. |

Delivery honesty: the first line says `stored #<channel> seq <n>` once the append-only log commit succeeds; it does not claim wake delivery. Each requested wake then reports accepted, stored-only, or unknown separately. Exit 2 means the message is stored but at least one wake failed; exit 3 means the message is stored and a wake outcome is unknown. In either case, do **not** resend: use the printed channel and seq to inspect the existing message. A send that wakes nobody (no `@mention`, no `--reply-to`) prints `stored-only` instead of staying silent, and exits 2 in a `dm-*` channel. Mentions count after any non-address character, so `。@claude-9e6c0ae7` works. Pi acceptance means its extension queued the message.

Claude targets report back through Claude Code's own delivery receipts (macOS and Linux; wire format and process model in [docs/delivery-receipts.md](./docs/delivery-receipts.md)):

| Output | Exit | What it means |
|---|---|---|
| `wake: accepted by inbox → X` | 0 | The frame is in X's inbox and no hold/refuse receipt arrived. With `accept` that means it entered the conversation. It is **not** a read receipt. |
| `wake: HELD, not delivered yet → X` | 2 | X's `crossSessionInbound` gate parked it for manual approval; it is dropped if nobody approves within 5 minutes. ocs keeps watching and sends your session one `[ocs delivery notice]` if it ends up not delivered. |
| `wake: NOT delivered → X: refused` (or `dropped`, `denied`, `expired`) | 2 | X's side rejected it. |
| `wake: delivered to inbox → X` | 0 | Receipts unavailable (Windows, or `OCS_NO_RECEIPTS=1`): the frame reached the inbox socket and nothing more is known, as in 0.6. |

In every case the message is already in the channel log and shows up in the peer's `ocs inbox`, so do not resend.

### Scripting send/dm

`ocs send … --json` and `ocs dm … --json` print exactly one JSON line on stdout (the human-readable lines move into `lines`); exit codes are unchanged:

```json
{"v":1,"command":"send","stored":true,"channel":"chat","seq":7,"wake":"accepted","exit":0,"lines":["stored #chat seq 7","…"]}
{"v":1,"command":"dm","stored":false,"error":"…","exit":1,"lines":[]}
```

| `wake` | exit | Meaning |
|---|---|---|
| `accepted` | 0 | Every wake was handed to a carrier without a reported failure. **Not proof it was read.** |
| `deferred` | 0 | A Codex target is mid-turn; the wake joins its backlog and goes out when the turn ends. |
| `parked` | 0 | The DM target has no live session; the message waits in the channel. |
| `none` | 0 | Nobody to wake (a non-DM channel with no `@`). |
| `skipped` | 0 | `--no-wake`. |
| `failed` | 2 | Stored, but a wake failed or was held / refused. |
| `unknown` | 3 | Stored, wake outcome unknown. |

With several targets the worst one wins (`unknown` > `failed` > `parked` > `deferred` > `accepted`). `stored:false` (exit 1) means nothing was written and the command is safe to fix and rerun. Any `stored:true` is never safe to resend: look the message up by `channel`/`seq` with `ocs read --json` instead. `ocs dm <address>@<peer> --json` is not supported yet and exits 1 without sending. `ocs read` shows `[wake → X: <status>]` under your own messages (`delivery` in `--json`). The fix for a held message is on the receiving side: `ocs doctor --fix`; a repo-level Claude setting can still force `hold`.

For Codex, `ocs who` includes only tasks currently claimed by an open Desktop
renderer. `ocs codex-sessions` is rollout history, not presence. When Desktop
definitely reports `unavailable`, `not-open`, or `no-source`, ocs may reuse the
same stored channel/seq to wake a uniquely matched idle cmux Codex surface. The
fallback requires both an exact task suffix in the surface title and a live
foreground Codex process; stale shells and ambiguous matches fail closed. It is
never attempted after an unknown IPC outcome. Without a safe carrier match, the
message stays in the append-only log for recovery with `ocs inbox`.

## Commands

| Command | Purpose |
|---|---|
| `ocs who` | Roster of every reachable agent, with same-project peers first and yourself marked; `--verbose` shows raw IDs/paths, `--json` is machine-readable |
| `ocs whoami` | Print the auto-detected sender identity; `--json [--session <id>]` describes the host session (`{host, id, name, session, addresses}`) |
| `ocs rename <name>` | Give this session a memorable address; its short id keeps working. `--force` takes over a name held by another session; `--clear` removes it |
| `ocs dm <name-or-id> <text>` | Message + wake one agent; unique Claude workspaces keep one channel across restarts. `--inherit <old-dm-channel>` binds pre-v0.3.4 history once; `--notify-when-idle` |
| `ocs inbox` | List unread threads that can be safely attributed to the current identity; `--json` for automation, `--session <claude-session-id>` to resolve one Claude session by id (for status bars outside Claude's process tree) |
| `ocs send <ch> <body>` | Append to a channel; `@` mentions wake, `--reply-to <seq>` also wakes that seq's author. `--as` is only an override. `--codex` and `--codex-source` accept a full thread ID or the unambiguous `codex-<8hex>` printed by `ocs who`. Also supports `--no-wake` and `--notify-when-idle`. `send`/`dm` take `--json`: see [Scripting send/dm](#scripting-senddm) |
| `ocs read <ch>` | Read new messages since your cursor, then advance it. Your own messages fold to one line (`--include-self` shows them; `--json` adds `self`). `--as` overrides identity; also supports `--since`, `--peek` |
| `ocs notify-when-idle <name>` | One-shot: a `[Cross-session idle notice]` lands in your session when that Claude session next goes idle or exits (immediately if already idle; expires after 6h) |
| `ocs sessions` | List live Claude Code sessions |
| `ocs codex-sessions` | List local Codex rollout history (`--limit <n>`); unlike `ocs who`, this does not imply the task is open or wakeable |
| `ocs watch <ch>` | Tail a channel (`--interval-ms <n>`) |
| `ocs doctor` | Health check for Claude, Codex, Pi, skills, and the data directory; `--fix` repairs safe local setup and re-checks it |
| `ocs skill install` | Repair/update the bundled skill for Claude Code, Codex, and Pi, plus Pi's direct-wake extension |
| `ocs upgrade` | Fetch and install the latest GitHub Release binary (`--check` only reports) |
| `ocs lan up \| pair \| who \| status \| peers \| scan \| unpair \| down` | Opt-in LAN mode: pair machines, then `ocs dm <address>@<peer>` and `ocs who --lan` (see [Cross-machine](#cross-machine)) |
| `ocs version` | Print the version |

Codex discovery includes live threads older than the latest history entries. A listed transport PID can serve several threads; it does not prove which thread owns a child build process. Select a peer by its full thread ID and project path, even when only one peer is shown.

**Stuck below 0.4.3?** `ocs upgrade` only started upgrading the binary in 0.4.3 — before
that it just printed a migration blurb and exited, so an older install can never reach a
newer release on its own and will keep looking current. Re-run the installer once:

```bash
curl -fsSL https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.sh | sh
```

After that `ocs upgrade` works. Every user-facing invocation (including help and version) prints an update notice to stderr when the cached latest release is newer. Background checks run at most once every 24 hours; the first call without a cache starts a check and subsequent calls show the result. Internal helpers and CI stay quiet. Set `OCS_NO_UPDATE_CHECK=1` to opt out. `ocs doctor` also warns when the binary falls behind.

Release checks fall back to GitHub's public latest-release redirect when the anonymous API quota is exhausted; no token is required. On older builds that stop at `HTTP 403`, rerun the installer above once.

Data lives in `~/.ocs` (override with `OCS_HOME`). Channels are plain JSONL logs.
Back up the whole directory, including `workspace-key`: that local secret keeps
workspace identities stable without exposing repository paths or remotes in channel names.

## vs native cross-session

Claude Code and Codex each shipped their own cross-session capability. They are
good — inside their own islands. ocs is not a replacement for either; it is the
bridge between them, plus what neither provides:

| | Claude native cross-session | Codex native cross-task | ocs |
|---|---|---|---|
| Reach | claude ↔ claude (local + cross-machine) | codex ↔ codex (inside ChatGPT Desktop) | any ↔ any on one machine and across paired LAN machines (Claude, Codex, Pi, terminal TUIs) |
| Best fit | direct Claude session handoff | direct ChatGPT task handoff | personal cross-vendor coordination, on one machine or across your LAN |
| Cross-vendor | — | — | ✅ local + LAN bridge |
| Multi-party | agent teams (same harness) | task @ mentions | ✅ local agents + humans |
| Offline delivery | live sessions only | open tasks only | ◐ messages persist in the local channel* |
| Shared history / audit | per-session transcripts | per-task | ✅ append-only log, seq-referenced receipts, replayable |
| Unified roster | Claude sessions only | Codex tasks only | ✅ `ocs who` lists Claude, Codex, Pi, and cmux surfaces |
| Pi support | — | — | ✅ direct wake extension, busy-turn queue |
| Terminal TUI support | Claude Code sessions | — (Desktop tasks only) | ✅ channel access everywhere; optional cmux wake |
| Thread references | harness-native | harness-native | ✅ portable `seq` + `--reply-to` across harnesses |
| Setup | built into Claude Code | built into ChatGPT Desktop | one static binary; no daemon, account, or API key |

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

## Cross-machine

### Same LAN: `ocs lan` (opt-in)

Pair two machines once, then address a remote agent as `<address>@<peer>`:

```bash
# machine A ("mini")
ocs lan up                  # start the LAN daemon (off until you do this)
ocs lan pair                # prints a text to send to B, then waits up to 10 minutes

# machine B — run the lines from that text
ocs lan up
ocs lan join k3m9q2xa7bfw4ndcuy2e --addr 192.168.1.20:47890
                            # shows a 6-digit check code; A sees the same code and answers y
ocs who --lan               # agents on A: claude-1a2b3c4d@mini  claude  idle  …
ocs dm claude-1a2b3c4d@mini "can you look at the CI failure?"
```

Trust is temporary unless you say otherwise: `ocs lan pair` grants 8 hours, `--for 30m|2h|7d`
picks another period, `--once` allows a single message, and `--forever` is meant for your own
devices. Both sides get the same period; expired peers are refused and dropped.
`ocs lan trust <peer> --for 8h | --forever` changes it later on this side.
Without a terminal (e.g. an agent ran `ocs lan pair`), approve with `ocs lan approve <code>`.
Peers on ocs 0.6/0.7 can still pair with the old one-time code: `ocs lan pair --code` there or here.

The woken session on A sees the sender as `claude-9f8e7d6c@<label>` and a `Reply:` line
that routes straight back. `ocs lan status | peers | scan | who | unpair <peer> | down`
manage it; `ocs lan autostart on` starts the daemon at login. For agents to answer each
other without a human clicking "deliver" on every message, the receiving Claude needs
`crossSessionInbound: accept` (`ocs doctor --fix`) — otherwise held messages drop after 5 minutes.
Windows specifics (named-pipe inbox, firewall rule): [docs/lan.md](./docs/lan.md#windows).

Security, in short: every machine has an Ed25519 key; the pairing text pins the inviting
machine's key fingerprint, and the inviting side approves the requester only after both
screens show the same 6-digit code derived from that connection's keys, so there is no
trust-on-first-use; each connection runs a signed X25519 handshake with forward secrecy and
AES-256-GCM; unpaired machines can only send a pairing request while someone is waiting for one. **Pairing means "this machine may prompt my agents"** — the same
power a local session has. Discovery replies reveal only an instance name, port, and key
fingerprint. Full protocol and threat model: [docs/lan.md](./docs/lan.md).

### Different networks: a virtual LAN

`ocs lan` only needs the two machines to reach each other's TCP port 47890. Machines
on different networks get that from a virtual LAN — Tailscale, WireGuard, ZeroTier,
or a company VPN — with no change to ocs. Multicast discovery usually does not cross
these networks, so pair by address:

```bash
# machine B, after A ran `ocs lan pair` — the key from A's text, A's VPN address
ocs lan join k3m9q2xa7bfw4ndcuy2e --addr 100.64.0.7:47890
```

The trust store remembers the address; reconnects need no discovery. Pairing across
subnets by address alone (no multicast) is tested between macOS and Windows; Tailscale
and WireGuard themselves are not part of the test matrix yet. Prefer a VPN over opening
port 47890 to the internet: the protocol is authenticated and encrypted, but a VPN keeps
the port off the public internet entirely.

### Anywhere else: SSH

Without the LAN daemon OCS has no listener at all. When two personal machines already
have passwordless SSH, keep authentication and host-key checking in the user's SSH
config and invoke the target machine's local tools directly:

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

## FAQ

The story behind ocs, and the "it said OK but the message was gone" bugs it is built around: [Making Claude Code and Codex talk to each other](https://blog.leeguoo.com/en/posts/ocs-cross-agent-wake/).

### Can Claude Code and Codex talk to each other?

Yes. Install ocs on the machine and run `ocs dm codex-<id> "review this diff"` from Claude Code (or ask Claude to "find another agent to review this"). The Codex task is woken with the message and a ready-to-run reply command, so the two agents can go back and forth without you copying text between windows. It works the other way round too, and with Pi and terminal agents.

### How do I get two Claude Code sessions to talk to each other?

Claude Code's built-in cross-session messaging already covers claude ↔ claude, and ocs rides on the same inbox. Use ocs when the conversation also involves Codex or Pi, needs more than two participants, has to survive a session restart, or runs across two computers. Set `"crossSessionInbound": "accept"` in `~/.claude/settings.json` on the receiving side (`ocs doctor --fix` does it). With the default `hold`, a message waits for manual approval and is dropped after 5 minutes; ocs tells the sender so — `wake: HELD` with exit 2 when it is sent, and a delivery notice if nobody approves it — instead of reporting it as delivered.

### Can AI agents on different computers message each other?

Yes, on the same LAN. Run `ocs lan up` on both machines, pair them once with `ocs lan pair`, then address a remote agent as `<name>@<peer>`. Traffic is mutually authenticated and encrypted (Ed25519 identities, signed X25519 handshake, AES-256-GCM); tested between macOS and Windows. On different networks, put both machines on the same virtual LAN (Tailscale, WireGuard, ZeroTier, or a company VPN) and pair with `--addr <peer-vpn-ip>:47890` — see [Different networks](#different-networks-a-virtual-lan).

### Does it work on Windows?

Yes. `ocs` ships a Windows x64 binary (`irm https://raw.githubusercontent.com/leeguooooo/open-cross-session/main/install.ps1 | iex`), wakes Claude Code through its named-pipe inbox and ChatGPT Desktop's Codex through its local IPC pipe, and joins the LAN mode.

The Codex pipe name (`\\.\pipe\codex-ipc`) is fixed and any local process could create it first, so since 0.7.1 ocs checks who is serving the pipe on the very connection it is about to use: the pipe must be owned by your user, and its server process must run as you and be ChatGPT Desktop (Store package `OpenAI.Codex`, image inside the package's install directory). Otherwise nothing is sent, the message stays in the inbox, and `ocs doctor` prints the reason. A Desktop that is not the Store package, or that runs elevated, is refused too.

### Do I need a server, an account, or an API key?

No. ocs is one static binary; messages are JSONL files in `~/.ocs`. Nothing leaves your machine unless you turn on LAN mode, and then only to computers you paired.

### How is this different from subagents, agent teams, or calling Codex through MCP?

Subagents and agent teams are spawned and owned by one Claude session; an MCP bridge makes Codex a tool that Claude calls. ocs connects independent, long-lived sessions — each keeps its own context, tools, and human — and lets any of them start the conversation.

## Development

```bash
bun install
bun test            # Claude/Pi Unix-socket E2E + a fake Desktop-IPC router
bunx tsc --noEmit
```

Architecture decisions and component provenance: [DESIGN.md](./DESIGN.md) and [docs/agentparty-extraction-map.md](./docs/agentparty-extraction-map.md). Engineering invariants for contributors: [CLAUDE.md](./CLAUDE.md).

## License

MIT. Three source files are vendored from [AgentParty](https://github.com/leeguooooo/agentparty) by the same copyright holder and relicensed under MIT; their headers mark the upstream origin.

## Author

Built by **郭立 (Guo Li / leeguoo)** — [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · more tools in the [*-use family](https://github.com/leeguooooo/plugins).


See [traffic counters, explicit related-task batches and discovery capabilities](docs/traffic.md).
