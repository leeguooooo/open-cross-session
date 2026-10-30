# OpenCode adapter

Requires OpenCode 2.2.1+. The installed `ocs.js` is self-contained, uses Node built-ins, and does not need npm publishing or an SDK dependency. Its default `{ id, setup }` export implements the V2 plugin contract. V1 hooks and older versions are not supported.

## Install and use

```sh
ocs skill install
# Reload OpenCode and submit a prompt in the session.
ocs whoami --json
ocs who --verbose
ocs rename reviewer
ocs dm reviewer "Review the changes"
ocs inbox
```

The installer writes `plugins/ocs.js` and `skills/ocs/SKILL.md` under the OpenCode config directory. `ocs doctor --fix` repairs these files. Existing JSON/JSONC configuration is left intact. Global plugin discovery and config reload belong to OpenCode.

Full addresses retain the exact `ses_…` ID: `opencode-ses_…`. An `oc-<8hex>` alias hashes the complete ID and resolves only when exactly one registered live receiver matches. Duplicate live owners are rejected. An offline full address can retain messages in the OCS log for the same session ID; an unknown short alias cannot identify an offline session. Renaming does not change the routed identity or existing inbox cursors.

## Delivery

Prompt, model-context and tool hooks register observed sessions, without scanning stored session history. Private registrations live in `$OCS_HOME/opencode-sessions`; sockets in `opencode-inbox`, with owner-only permissions and a random runtime token. Windows uses a session-bound random named pipe. `who` omits dead registrations. The adapter checks session existence again before submission.

The tool executor carries the exact session ID through async context into `shell.create.before`; concurrent sessions do not share a process environment identity. Tool shells receive `OCS_OPENCODE_SESSION_ID` and the same OCS data home. An explicitly supplied `OPENCODE_SESSION_ID` is also recognized. A terminal opened outside a model tool must provide an exact identity or `--as`.

Incoming wakes call `ctx.session.prompt` with `delivery: "queue"` and source metadata. A matching native admission acknowledges `queued`, including while the receiver is busy. No interrupt, permission change, server launch or target-session creation occurs. Missing acknowledgement after writing is unknown, never a retry signal. OCS retains the message independently; accepted does not mean read or completed.

LAN uses the existing pairing/trust protocol, exact live target checks and reply routing. Existing paired peers must upgrade to recognize the new roster kind and identity namespace. `notify-when-idle` still targets Claude sessions; OpenCode may receive the resulting notice as a subscriber.

## Verification

`bun test test/opencode.test.ts` runs the shipped plugin against host API fixtures with real local sockets, including concurrent identity, native queue input, unknown outcome and installer behavior. `bun test` and `bunx tsc --noEmit` check integration with existing adapters. Real OpenCode validation must additionally load the installed plugin and inspect native inbox admission; fixture results alone do not establish host compatibility.

Official API references: [V2 server plugins](https://dev.opencode.ai/v2/docs/build/plugins/server), [plugin discovery](https://dev.opencode.ai/v2/docs/plugins).
