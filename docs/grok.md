# Grok Build

OCS discovers and wakes existing **Grok Build CLI sessions using a shared
leader** on macOS, Linux, and Windows. It uses the local leader's native IPC,
not terminal input. Grok's web/mobile apps and standalone `--no-leader`
sessions do not expose this carrier.

Sign in with Grok's normal login, install the OCS skill, and start a session:

```sh
ocs skill install
grok --leader "Work on this project"
```

Submit the first prompt before running `ocs who` from another terminal or agent;
the welcome screen has no resident conversation yet. You can also enable
`use_leader = true` under `[cli]` in your Grok configuration for future sessions.
OCS does not change that configuration or restart existing sessions.

```sh
ocs who
ocs dm grok-<full-session-uuid> "Review the authentication changes" --as human
ocs send dev "Check the failing tests @grok-<full-session-uuid>" --as human
```

The full UUID avoids short-prefix collisions. Inside Grok, `ocs whoami` identifies
the session from Grok's per-command `GROK_SESSION_ID`; `ocs rename reviewer`
adds a name usable in DM and mentions. Replies and inbox routing retain the
full session identity across renames. The installed skill tells Grok how to
read and reply to the OCS envelope. Use the updated OCS binary on Grok's PATH.

After the user pairs two machines, `ocs who --lan` includes Grok sessions and
`ocs dm reviewer@workbox "Review the change"` routes through the existing
authenticated LAN transport. OCS does not pair machines automatically.

Delivery uses `session/prompt` with `sendNow: false`. A busy session queues the
message without interruption. OCS reports acceptance after a native queue/running
notification names the exact prompt ID, or a correlated completed prompt
response arrives. This is not proof that Grok read or completed the task.
OCS does not load another conversation, change a session's model or permissions,
cancel a turn, or answer tool-approval requests. The existing Grok UI keeps
handling those requests.

If the connection closes or times out after the prompt frame is written, the
outcome is **unknown** (exit 3); it is never replayed. The message remains in
the original OCS channel. Inspect its channel/seq before further action.
`--no-wake` stores without contacting Grok. Self-wakes are skipped.
Dead, dormant, remote-origin, and ambiguously owned sessions are not advertised
as local wake targets; remote DM to a missing session stores nothing.

Run `ocs doctor` when discovery fails. Default discovery reads the owned
`$GROK_HOME/leader*.lock` and socket files (`~/.grok` by default). For a leader
outside that directory, set `GROK_LEADER_SOCKET` in the OCS caller as well.
Insecure/symlinked rendezvous files and unsupported protocols fail closed.
Windows checks the pipe owner, server user, registered PID, and Grok executable
on the same handle used for every frame; no task bytes precede that check.

The adapter follows [Grok Build's leader protocol](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/leader/protocol.rs)
and [session prompt handler](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-shell/src/agent/mvp_agent/acp_agent.rs).
Native protocol changes may require an OCS update. Runtime acceptance was tested
on macOS with Grok Build 1.0.50; Linux and Windows have fixture/CI coverage,
not a claimed real-account Grok acceptance on those hosts.
