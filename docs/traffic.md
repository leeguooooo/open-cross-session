# Traffic, explicit batches and capabilities

## Explicit related-task batches

```sh
# tasks.json contains ["Review configuration", "Review tests", "Report combined findings"]
ocs dm reviewer --batch tasks.json --json
ocs send dev --batch tasks.json --codex <full-thread-id> --json
ocs dm agy --batch tasks.json --json
```

A batch is one ordinary message with every task retained, not multiple stored messages
followed by a wake. The input must be a JSON array of 1..100 non-empty strings; both
input and formatted output must fit the message byte limit. Do not also pass a positional
message. Recipient routing and permissions are unchanged. Related findings can be
returned together; keep unrelated tasks and urgent blockers separate. Long wake notes
remain previews: read the full channel message before acting. Each recipient gets one
delivery pipeline; a multi-recipient send can still wake multiple agents.

## Local traffic observations

```sh
ocs stats --json
ocs stats <channel> --json
```

`messages` and `outcomes` summarize observed message-level results, while
`wakeRequestedMessages` excludes explicit skipped and no-target observations.
`deliveryAttempts` and `deliveryOutcomes` count observed target delivery pipelines,
including accepted, deferred, parked, failed, unknown and self-suppressed (`none`).
They are not a count of model turns: steering may enter an existing turn, queued work
may start later, and accepted does not prove reading or completion. Address rejection
before entering a delivery pipeline need not create a delivery observation.

`batchItems`, `batchedMessages` and `explicitBatchSavedRequests` compare the explicit
batch with one request per item, not with measured model usage. `coalescedMessages`
and `coalescedDeliveries` describe unread Codex notifications consumed by the busy
watcher; originals remain in the channel. They are separate observations from the
original message outcomes and must not be summed as unique messages.

Observations start when this implementation is used. Old sends, old daemons and raw
host calls are absent. Each machine has its own scope; sender and receiver can both
observe one LAN message. No token, cost or cache-hit reduction is inferred.

Private diagnostic JSON files under `$OCS_HOME/traffic` contain only channel, sequence,
time, outcome, kind and item count. An observation begins as unknown, and is updated
once the result is known. A crash can leave unknown; the diagnostic files never decide
whether to retry or whether a message exists. Damaged files are ignored. Metrics I/O
errors do not alter delivery. Remove this directory to reset observations when no sends
or daemon deliveries are active; it does not remove message history.

## Discovery capabilities

`ocs who --json` attaches `capabilities` to local entries. `ocs who --lan --json`
returns the same local roster plus `peers`, containing remote entries or an unavailable
error. `ocs lan who --json` emits only the remote roster. Capabilities v1 contains:

| Field | Values / meaning |
|---|---|
| wake | available or unverified; current carrier observation, not approval or delivery |
| noWake | whether the address supports storing without requesting a turn |
| busyDelivery | serial, queued, steer-or-coalesce, or host-controlled |
| deliveryReceipt | conditional or none; conditional native Claude receipts are not read receipts |
| completionReceipt | false; OCS does not determine task completion |
| batch | whether explicit batch messages are supported for this address |

An old remote receiver may omit capabilities. Do not assume optional features from its
agent kind. Remote discovery reports no terminal delivery receipts: those are not
forwarded across LAN. Capabilities contain no remote PID, private paths or credentials.
