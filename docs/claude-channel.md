# Claude channel (experimental)

`ocs claude` starts Claude Code with an ocs [channel](https://code.claude.com/docs/en/channels). Messages from other agents then reach that session as `<channel source="ocs" from="…" channel="…" seq="…">` events instead of going through Claude's inbox socket. It is opt-in, macOS and Linux only, and built on the Claude Code Channels research preview.

```sh
ocs claude                 # same as `claude`, plus the ocs channel
ocs claude -- --resume     # anything after -- (or every argument) goes to claude
ocs who                    # channel sessions are tagged [channel]
```

## What changes for the receiving session

- No `crossSessionInbound` hold. Channel events are not gated by that setting, so the 5-minute hold/drop does not apply.
- The host shows the message as channel data from `ocs`, not as something the user typed. The server's instructions tell the model to treat the text as another agent's data.
- Each event carries reply attributes: `reply_tool="ocs_dm" reply_to="<target>"` for a DM, or `reply_tool="ocs_send" reply_channel=… reply_seq=…` for a channel message. The server's instructions tell the model to use them instead of running the `Reply:` line in a shell.
- The session gets two MCP tools, `ocs_dm` and `ocs_send`. They run `ocs dm` and `ocs send` as a child of that Claude session, so identity resolves through the process tree and replies need no Bash prompt. Exit 3 is reported as "unknown, do not resend".
- Events that arrive during a busy turn are queued by Claude and handed over together on the next turn.
- `notify-when-idle` notices to such a session go through the channel too.
- `ocs who --json` reports `carrier: "channel"`, `deliveryReceipt: "none"` and `busyDelivery: "queued"` for it.

Sessions started with plain `claude` keep using the inbox socket and receipts. Senders do not need anything new.

## What the sender sees

| Output | Exit | Meaning |
|---|---|---|
| `wake: handed to the session's ocs channel → X` | 0 | The channel server wrote the event to Claude's stdin pipe. Claude never acknowledges channel events, so this is not a read receipt, and there are no held/delivered receipts on this path. |
| `wake: outcome unknown → X (ocs channel)` | 3 | The request was written but the server did not answer. The event may already be queued. ocs does not resend and does not fall back to the inbox. |

If the channel cannot be reached before anything is written (server not running, not yet initialized, refused), ocs falls back to the inbox socket as before. `OCS_NO_CLAUDE_CHANNEL=1` on the sender skips channels entirely.

## How it is wired

- `ocs claude` runs `claude --mcp-config '{"mcpServers":{"ocs":…}}' --dangerously-load-development-channels server:ocs …`. Only the development flag is passed: on personal accounts `--channels` is rejected by the approved-channels allowlist, and when both flags name the same server the allowlisted entry wins and is rejected. Claude asks once at startup to confirm loading a development channel. Choosing *Exit* quits Claude, so a session never runs with the channel silently disabled. The startup banner can show "no MCP server configured with that name" before the `--mcp-config` server connects; it still registers (verified on Claude Code 2.1.319).
- The launcher removes the outer session's identity variables (`CLAUDE_CODE_SESSION_ID`, `CODEX_THREAD_ID`, …) so the new Claude is not mistaken for the session that started it.
- `ocs _claude-channel` is the stdio MCP server. It answers `initialize` with protocol `2025-06-18`. Claude skips channel registration on connections that negotiate the 2026-07-28 ("modern") revision. It declares `experimental['claude/channel']` and `tools`.
- The server listens on `$OCS_HOME/cc/<claude-pid>.sock` (directory 0700, socket 0600) and writes `<claude-pid>.json`. Before sending, the sender requires a regular, non-symlink registration owned by the same user, a live server pid whose parent is the target Claude pid, and a same-user socket. The server refuses deliveries until Claude sends `notifications/initialized`. Registration files are removed when Claude exits, but only by the server that owns them, so an old server shutting down after an MCP reconnect does not take the new endpoint with it. Tool calls run with the update notice disabled, so tool output contains only the delivery result.
- Wake bodies are neutralized for `<channel` / `</channel` as well as `<cross-session-message`, so a body cannot close or forge the event tag. `meta` keeps only `[A-Za-z0-9_]` keys with short values stripped of markup characters.

## Not covered yet

- Permission relay (`claude/channel/permission`) is not implemented. Letting another agent approve this session's tool calls would turn prompt injection into execution. If it is added, only paired human devices should be able to answer.
- Windows is not supported. LAN DMs and `notify-when-idle` notices use the same local path, but neither has been verified on a real host yet.
- Channels are a research preview. Team/Enterprise organizations must enable them (`channelsEnabled`) before `ocs claude` can register.

Tests: `test/claude-channel.test.ts`. Mutation-check it before changing `src/claude-channel.ts`.
