# Fleet sub-tasks — a child task that runs on any node

Status: implemented (2026-10-22), step 2 on top of `2026-10-22-fleet-leases.md`.

## Behaviour

With a fleet role, `cez task create` (the dispatch route) no longer starts the child on the
parent's machine: the cockpit validates the order exactly as before (switch, live parent, in-flight
and subtask caps, budget) and submits it to the hub as a fleet job carrying
`parent: {nodeId, runId, rootRunId, jobId?, projectId?}`. Any node with room runs it. `--local`
(`local: true`) keeps the old behaviour. Without a fleet role nothing changes.

- **Fork point.** The child starts from the repository's base branch. The parent's branch is
  unpushed and unreachable from another machine, so the order says so; the child's branch is pushed
  and a draft PR opened when it finishes (`openPr` is on).
- **Caps.** The parent's fleet children (hub jobs with `parent.runId` = the parent, not settled)
  count against `DISPATCH_MAX_IN_FLIGHT` together with local children.
- **Budget.** `max_cost` becomes the child's `budgetUsd` on its node. A capped parent's remainder is
  carved from LOCAL children only; fleet children's reservations are not tracked on the parent.
- **Child side.** The worker starts the run as a dispatched child (`dispatch.parentRunId`,
  `dispatch.remoteParent: {nodeId, jobId?}`, dispatch system prompt, `kind`), so `cez task report`
  works. Delivering that report to the parent is the mailbox (step 3).
- **Cancel.** Cancelling a fleet job cancels the jobs whose `parent.jobId` names it.
- **Hub down.** The dispatch is refused with the reason and a hint to use `--local`; nothing is
  half-created.

The child's id is the fleet job id; the route answers `{id, fleet: true}`.
