# Fleet events — one alert per transition, from the hub

Status: implemented (2026-10-22), step 5 on top of `2026-10-22-fleet-routing.md`.

## Problem

An alert about a job (started, finished, needs input) must go out once. If every node alerts for what
it runs, or a poller on each machine reports what it sees, the same transition is announced several
times and the fleet has no single record of it. The hub is the only place that sees every job.

## Behaviour

The hub records one event per transition, when the node's report moves the job:

| type | when |
| --- | --- |
| `started` | the job leaves `assigned` (the node acknowledged it by reporting it) |
| `needs-input` | the report first carries `needsInput`: the run stopped on a `CEZ:ASK` (`waiting` + `askParked`); with the question text |
| `finished` | the job reaches `done` (with the PR / branch link) |
| `failed` | the job reaches `failed`, also when its node stopped answering for the last allowed attempt |

Repeated reports, redelivered heartbeats and a hub restart do not repeat an event: statuses are
persisted, so a transition the hub already saw is not a transition again. A requeue after a lost
node is not an event. Cancel is the user's own action and is not announced.

An event is `{seq, at, type, jobId, title, nodeId?, runId?, prUrl?, branch?, branchUrl?, error?,
question?, text}`; `seq` is a hub-wide cursor and `text` a ready one-line message
(`Finished on worker-01: Fix login — https://github.com/o/r/pull/7`).

## Consuming

- `GET /api/v1/fleet/events?since=<seq>&wait=<seconds>` (token-guarded): events after the cursor,
  and `next` to ask with next time. `wait` (max 25) long-polls for the first new event.
  `cezar fleet events [--since n] [--follow] [--json]`.
- Opt-in push: `CEZ_FLEET_EVENTS_WEBHOOK=<http(s) URL>` on the hub. Each event is POSTed once, in
  order, as JSON with `x-cezar-event: <type>` and `x-cezar-signature: sha256=<hmac of the body keyed
  by CEZ_FLEET_TOKEN>`. The cursor moves only on a 2xx, a failing receiver is retried with backoff
  (1 s .. 10 min) from the same event, and the cursor survives a restart. The first time a webhook is
  configured it starts from now; history is not pushed.
- State: `fleet/events.json` (last 500 events + the webhook cursor; atomic, `0600`; corrupt means
  empty).

Off by default: without the variable nothing leaves the hub and no sender runs.
