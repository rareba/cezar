# Fleet mailboxes — messages between tasks on different nodes

Status: implemented (2026-10-22), step 3 on top of `2026-10-22-fleet-subtasks.md`.

## Behaviour

- **Reports.** When a cross-node sub-task's fleet job settles (after its PR is opened), its node
  mails the report to the parent: `to: {runId: parent, nodeId: parent node, projectId}`,
  `kind: 'report'`, the prose the parent reads plus the structured `DispatchReport`, with the PR and
  branch links appended. It is delivered exactly like a local child's report (`receiveMail`): a
  pending report on the parent, then the open session, the queued prompt stack or the start-up
  buffer, and a settled parent is continued.
- **Messages.** `cez task send <run id|job:<job id>>[@node] "<text>"` mails any task. A message goes
  into the live session; for a finished task it waits in the task's tree inbox (it never restarts
  a finished task). A child is addressable by its fleet job id: the hub resolves job -> node + run
  once the job has reported a run.

## Transport

Mail rides the existing heartbeat, both ways; no new connection and no new port:

- node -> hub: `outbox: FleetMailSubmit[]` (ids chosen by the sender, resent every heartbeat until
  one gets through; the hub dedupes by id).
- hub -> node: `mail: FleetMail[]` in the reply, until the node acknowledges the ids in a later
  heartbeat's `mailAck`; the node delivers each id at most once. Latency is one heartbeat (5 s).
- The hub keeps undelivered mail in `fleet/mail.json` (atomic, `0600`, per-entry salvage), drops
  mail older than 24 h, and only the addressed node may acknowledge it.
- An unknown run on the addressed node is acknowledged and dropped (nobody there can ever take it).

Long-poll was not needed: a 5 s heartbeat is below the latency of a task reading its inbox.

## Limits

An outbox lives in the node process: mail queued but not yet sent is lost if the node restarts in
that window (a few seconds). A report's parent must still be reachable through its node's
heartbeat; mail for a node that never returns expires after 24 h.
