# Fleet leases — fleet-wide locks for workflows

Status: implemented (2026-10-22), step 1 of the coordination work on top of
`2026-10-21-fleet-coordination.md`. Code: `packages/cezar/src/fleet/leases*.ts`,
`lease-cli.ts`; wire shapes: `packages/contract/src/fleet.ts`.

## Problem

An external script coordinated which node worked which issue through locks stored in a GitHub ref:
slow, quota-hungry, and unable to say "this node died, free its locks". The hub already knows which
nodes are alive; locks belong there.

## Model

- A lease is `{name, holder, nodeId, runId?, acquiredAt, expiresAt}`. `name` is what workflows lock
  on (`issue-123`, `real-db`); `holder` is the caller's own label.
- `acquire` is idempotent per `(name, holder)` and refused when `limit` (default 1) other holders are
  in; `limit > 1` is a counting semaphore. `renew` and `release` address `(name, holder)`.
- Expiry is 60 s (`LEASE_MS`). A node's heartbeat carries `leases: [{name, holder}]` — every lease
  the node stands behind — and the hub renews exactly those. A node that stops heartbeating stops
  renewing, so its leases free themselves. Released too: a lease a node owns but no longer names
  (after a node TTL of grace, so an acquire racing a heartbeat survives) is freed at once.
- A heartbeat without the `leases` key (an older node) leaves that node's leases alone; they expire.
- Hub restart: `fleet/leases.json` (atomic, `0600`, per-entry salvage) reloads and every holder gets
  a fresh term to re-heartbeat.

## Who talks to whom

Agents and check steps never hold `CEZ_FLEET_TOKEN`. `cez lease` therefore calls its own cockpit
(`CEZ_API_URL`) on `/api/v1/workspace/fleet/leases/*`; the cockpit takes the lease in its node's name
(the hub directly on a hub, the token-guarded listener on a worker) and records it in a node-local
registry (`leases-local.ts`). The heartbeat names the registry's entries. An entry whose run is no
longer `queued|running|waiting` (or is gone) is dropped before each heartbeat, so a task that
crashed without releasing cannot hold a lock.

## CLI

`cez lease acquire|release|list|run`. `run <name> -- <cmd>` takes the lease (one holder per
invocation), runs the command with inherited stdio, always releases, and exits with the command's
code. `--wait <s>` polls every 2 s; `--if-fleet` treats "no fleet role" as success so the same
workflow runs on a single instance. Exit codes: 0 ok, 1 busy / failure, 2 usage or no fleet.

## Non-goals

No fairness or queueing order between waiters, no hub-pushed wake-up (polling is enough at this
scale), no lease transfer between holders.
