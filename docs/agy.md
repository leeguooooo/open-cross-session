# Antigravity CLI receiver

An optional receiver lets Claude, Codex, Pi, and paired computers delegate to
[Antigravity CLI (`agy`)](https://antigravity.google/docs/cli/headless/).
It uses the documented `-p`, `--output-format json`, and `--conversation` interfaces.
It starts a dedicated headless conversation, rather than injecting into an existing TUI.

The receiver supports **macOS and Linux**. Windows clients can send to it over
the existing paired LAN transport; a Windows receiver is not implemented here.
No Python, systemd, additional npm package, or separate API key is required.
You do need `agy` on PATH and its own cached login.

```sh
agy                                      # authenticate interactively once
ocs agy start --cwd /path/to/workspace    # opt in; one receiver per OCS_HOME
ocs who                                  # includes agy while the receiver is live
ocs dm agy "Review the authentication changes and report your findings"
ocs send dev "Check the test failures @agy"
ocs agy status --json
ocs agy stop
```

`--model <slug>` overrides the CLI model. `--timeout <seconds>` sets the turn
limit (1–21600 seconds, default 3600). Run `ocs agy serve --cwd <workspace>` in
the foreground for an existing process supervisor. OCS never enables a login
service or changes agy permissions automatically. A receiver inherits the
authentication environment where it is launched: sign in and launch it from
the same local user environment. In particular, agy may use different credential
storage inside SSH sessions.

After machines have been paired by the user:

```sh
ocs dm agy@workbox "Run the project's Linux checks"
```

The address `agy` is reserved. Include the intended project path in the task
when it differs from the configured workspace. Each OCS channel has its own
persisted agy conversation ID; turns execute serially, without interrupting an
active turn. The final response is sent back to the original local channel or
the authenticated LAN sender. `ocs inbox` and `ocs read` remain the normal way
to inspect messages. Older LAN clients may omit the new `agy` kind in their
roster; direct `ocs dm agy@workbox ...` still works.

Acceptance means the request was committed to the local execution queue, not
that the CLI or the requested work has completed. The final model response
reports the outcome. agy keeps its existing permission policy; headless tools
that cannot obtain approval may be denied. Diagnostics, including permission
notices, go to the foreground stderr or the private `worker.log`.

State lives under `$OCS_HOME/agy` (default `~/.ocs/agy`): owner-only rendezvous
files, a per-runtime socket/token, `jobs.sqlite3`, and `worker.log`. The OCS
channel log remains the sole authority for message sequence numbers. Job IDs
derive from channel/seq, so repeating a wake does not repeat the task.

On restart, accepted queued jobs resume. In-flight jobs are reported as
interrupted with unknown partial effects and are **never re-executed**.
Responses interrupted during delivery are likewise not resent. Offline wakes
stay in the OCS channel log; starting the receiver does not automatically
execute messages it never acknowledged. Exit 2/3 still mean stored-only/unknown:
inspect the original channel and sequence before making another request.

This carrier is opt-in and local by default. It neither starts LAN mode nor
pairs computers; existing LAN authentication and trust limits still apply.
