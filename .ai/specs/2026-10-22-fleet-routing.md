# Fleet routing, drain and metrics

Status: implemented (2026-10-22), step 4 on top of `2026-10-22-fleet-mailbox.md`.

## Capability routing

- A node advertises `tags` (`CEZ_FLEET_TAGS=docker,android,gpu`, lowercased, up to 20) plus its
  platform, added automatically: `macos`, `windows` or `linux`. A combination like `macos-ios` is
  just a tag the operator sets.
- A job declares `requires` (`cezar fleet submit --requires docker,gpu`, `cez task create
  --requires docker`, up to 8). The hub assigns it only to a live, non-draining node with free
  capacity that advertises every tag. A job nobody can take stays `pending` and does not block
  later jobs that need less.
- Jobs without `requires` run anywhere, tagged nodes included.

## Drain

`POST /api/v1/fleet/nodes/:id/drain {drain}` (`cezar fleet drain <node> [--undo]`): the node takes
no new jobs; what it holds keeps running and finishing. The mark lives on the hub in
`fleet/drain.json` (survives a hub restart) and also shows on the node as `draining` in status. A
scaler removes a node once it is draining and `running` is 0.

## Metrics

`GET /api/v1/fleet/metrics` (token-guarded like the rest of the listener; `?format=prometheus` for
text exposition). A pool is `any` (whole fleet, all pending jobs) or one tag. Per pool: `pending`
(jobs requiring the tag; for `any`, every pending job), `running` (jobs held by its nodes), `nodes`,
`freeSlots`, `maxSlots` (live non-draining nodes only). A tag that only pending jobs ask for still
shows up with no nodes, so a scaler can start the first node of that pool. `nodeList` carries the
same per node (live, draining, tags, running, free) for picking an idle node to remove.

Autoscaler recipe: scale a pool out while `pending > freeSlots`; scale in by draining an idle node
(`running == 0` after drain) and then deleting it.
