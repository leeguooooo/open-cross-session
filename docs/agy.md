# Antigravity CLI receiver

An optional receiver lets Claude, Codex, Pi, and paired computers delegate to
[Antigravity CLI (`agy`)](https://antigravity.google/docs/cli/headless/).
It uses the documented `-p`, `--output-format json`, and `--conversation` interfaces.
It starts a dedicated headless conversation, rather than injecting into an existing TUI.

The receiver supports **macOS, Linux, and Windows**. Windows uses a local named
pipe; before sending a token or task, the client verifies the pipe owner, the
server user SID, and the registered worker PID on the same connection. State
files on Windows rely on the local user directory ACL rather than Unix mode bits.
Use an OCS_HOME directory accessible only to your user and administrators.
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
Responses interrupted during delivery are likewise not resent. `ocs agy stop`
uses an authenticated control request on every platform. On Windows, stopping
an active task or reaching its time limit terminates the child process tree.
Long Windows replies include a preview and a path to the complete result file
to stay within the Windows command-line limit. Offline wakes
stay in the OCS channel log; starting the receiver does not automatically
execute messages it never acknowledged. Exit 2/3 still mean stored-only/unknown:
inspect the original channel and sequence before making another request.

This carrier is opt-in and local by default. It neither starts LAN mode nor
pairs computers; existing LAN authentication and trust limits still apply.


## Interactive windows (#89)

An `agy` window you opened yourself gets its own address, separate from the
`agy` receiver above. macOS and Linux only.

1. Ask the window's agent to run `ocs whoami` (or any ocs command). The output
   is the window's address, `agy-<conversation-id>`; `ocs whoami --json` also
   gives the short form `agy-<8hex>`, the native `conversationId`, and
   `deliverable`. A `!` shell escape typed by a person does not work for this:
   agy gives that shell none of the variables ocs needs.
2. `ocs who` lists every open window under "Antigravity CLI windows". It marks
   each one `dm` or `identify-only`; `ocs who --json` shows the same as
   `capabilities.wake` (`available` / `unavailable`).
3. `ocs dm agy-<8hex> "…"` (or `@agy-<8hex>` in `ocs send`) delivers into that
   window's existing conversation. Its reply comes back through the normal
   `Reply:` line, and `ocs rename` works as for other sessions.

How it works, and what it does not promise:

- **Discovery.** An open window's agy process holds
  `~/.gemini/antigravity-cli/presence/<conversation-id>.lock`. ocs lists only
  holders that are an interactive `agy` on a terminal: `agy -p` / `--print`,
  subcommands, and processes without a tty are excluded. After `/clear`, the
  window holds a new conversation id, and the old address stops resolving.
- **Registration.** agy gives the window's tool shells the loopback address of
  its own local server and a per-process token. When ocs runs there, it records
  both in `$OCS_HOME/agy-windows/<pid>.json` (mode 0600), keyed by pid and
  process start time. It records them only after checking that this pid holds
  the conversation's lock and listens on that port. Until a window has
  registered, it is identify-only, and DMs to it stay in the OCS channel.
- **Delivery.** ocs runs `agy agentapi send-message` against that window's own
  server. agentapi answers "sent" for any id, including one nobody has open, so
  ocs does not trust that answer as proof. Before every send it checks again
  that the same process (pid and start time) holds the lock and listens on the
  registered port. If any check fails, nothing is sent. The child process gets
  only the address and token. A busy window takes the message into its current
  turn without cancelling it.
- **Outcome.** `accepted` means the window's server took the message. It does
  not mean the agent has read it. A run that times out or answers anything
  unexpected is `unknown` and is never resent: inspect the original channel
  and seq instead.
- **Framing.** agy shows the message to the model as a `<SYSTEM_MESSAGE>` from
  `sender=system` and does not escape the text. Before sending, ocs neutralizes
  every uppercase pseudo-tag in the note (`<SYSTEM_MESSAGE>`, `<USER_REQUEST>`,
  …) to `‹…` (docs/wake-protocol.md §1). The note's first line still names the
  ocs sender.
- **Exposure.** agentapi takes the message text only as a command-line
  argument, so other local users can see it in `ps` while it is being sent.
  The token travels in the environment, never in argv.
- **Sandbox.** In agy's sandboxed mode, the agent may need your approval to
  run ocs outside the sandbox.
- **Names.** A name given with `ocs rename` belongs to the conversation. After
  `/clear` the window has a new address, and the name does not follow it.
- **Requirements and status.** Discovery and the checks before each send need
  `lsof` and `ps` (on Linux, install `lsof`). Windows windows are not listed.
  Verified on macOS with agy 1.4.7 and 1.5.16; Linux and LAN delivery to a
  window have not yet been verified on real hosts. This relies on agy
  internals that are not a documented interface. If an agy update changes
  them, ocs reports the window as unavailable and sends nothing.
