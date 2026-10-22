import { z } from 'zod';
import { runnerSchema } from './health.ts';

/**
 * Fleet coordination wire shapes (spec `2026-10-21-fleet-coordination`). They travel on the fleet
 * listener (`/api/v1/fleet/*`, bearer token) — a separate port from the cockpit API, opt-in via
 * `CEZ_FLEET_*`. Same discipline as the rest of the contract: one schema, type inferred.
 */

export const fleetJobStatusSchema = z.enum(['pending', 'assigned', 'running', 'review', 'done', 'failed', 'cancelled']);
export type FleetJobStatus = z.infer<typeof fleetJobStatusSchema>;

/** Statuses a worker may report for a job it holds (the hub owns pending/assigned/cancelled). */
export const fleetReportedStatusSchema = z.enum(['running', 'review', 'done', 'failed']);

/** The task that dispatched a fleet job (a cross-node sub-task): where its reports go (spec 2026-10-22-fleet-subtasks). */
export const fleetParentSchema = z.object({
  nodeId: z.string().min(1).max(200),
  runId: z.string().min(1).max(100),
  /** The parent's tree root (the parent itself when it is the root). */
  rootRunId: z.string().min(1).max(100),
  /** Set when the parent is itself a fleet job. */
  jobId: z.string().max(100).optional(),
  projectId: z.string().max(100).optional(),
});
export type FleetParent = z.infer<typeof fleetParentSchema>;

export const fleetJobSchema = z.object({
  id: z.string(),
  repoUrl: z.string(),
  baseBranch: z.string().optional(),
  task: z.string(),
  workflowId: z.string().optional(),
  runner: runnerSchema.optional(),
  model: z.string().optional(),
  openPr: z.boolean(),
  /** Set on a cross-node sub-task. */
  parent: fleetParentSchema.optional(),
  title: z.string().max(120).optional(),
  kind: z.enum(['implement', 'review']).optional(),
  maxCostUsd: z.number().positive().optional(),
  status: fleetJobStatusSchema,
  nodeId: z.string().optional(),
  runId: z.string().optional(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  /** Web page of the pushed branch, when the host is not GitHub (no PR is opened there). */
  branchUrl: z.string().optional(),
  error: z.string().optional(),
  leaseExpiresAt: z.string().optional(),
  attempts: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type FleetJob = z.infer<typeof fleetJobSchema>;

export const fleetSubmitSchema = z.object({
  repoUrl: z.string().trim().min(1).max(500),
  task: z.string().trim().min(1).max(20_000),
  // A plain branch name: no leading dash or dot, nothing exotic.
  baseBranch: z.string().trim().regex(/^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/).optional(),
  workflowId: z.string().trim().min(1).max(200).optional(),
  runner: runnerSchema.optional(),
  model: z.string().trim().min(1).max(200).optional(),
  openPr: z.boolean().optional(),
  parent: fleetParentSchema.optional(),
  title: z.string().trim().min(1).max(120).optional(),
  kind: z.enum(['implement', 'review']).optional(),
  maxCostUsd: z.number().positive().optional(),
});
export type FleetSubmit = z.infer<typeof fleetSubmitSchema>;

export const fleetNodeSchema = z.object({
  nodeId: z.string().min(1).max(200),
  lastSeen: z.string(),
  capacity: z.object({ free: z.number().int().nonnegative(), max: z.number().int().nonnegative() }),
  host: z.object({ cpuPct: z.number().optional(), memAvailableBytes: z.number().optional() }),
  version: z.string(),
});
export type FleetNode = z.infer<typeof fleetNodeSchema>;

/** What a worker says about a job it holds. */
export const fleetJobReportSchema = z.object({
  id: z.string(),
  status: fleetReportedStatusSchema,
  runId: z.string().optional(),
  branch: z.string().optional(),
  prUrl: z.string().optional(),
  branchUrl: z.string().optional(),
  error: z.string().optional(),
});
export type FleetJobReport = z.infer<typeof fleetJobReportSchema>;

/** A lease name: what workflows lock on ("issue-123", "real-db-tests"). */
export const fleetLeaseNameSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/);

/**
 * A named, expiring claim on something fleet-wide (spec 2026-10-22-fleet-leases). `holder` is the
 * caller's own label (a run id, a CLI invocation); the lease lives only while its node's heartbeats
 * keep naming it, so a dead node frees what it held.
 */
export const fleetLeaseSchema = z.object({
  name: fleetLeaseNameSchema,
  holder: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(200),
  runId: z.string().max(100).optional(),
  acquiredAt: z.string(),
  expiresAt: z.string(),
});
export type FleetLease = z.infer<typeof fleetLeaseSchema>;

/** What a node still stands behind; the heartbeat renews exactly these. */
export const fleetLeaseRefSchema = z.object({ name: fleetLeaseNameSchema, holder: z.string().min(1).max(200) });
export type FleetLeaseRef = z.infer<typeof fleetLeaseRefSchema>;

/** Cockpit-side body (the node id is added by the cockpit); `limit` > 1 makes a counting semaphore. */
export const fleetLeaseAcquireInputSchema = fleetLeaseRefSchema.extend({
  runId: z.string().max(100).optional(),
  projectId: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});
export type FleetLeaseAcquireInput = z.infer<typeof fleetLeaseAcquireInputSchema>;

/** Hub-side body: the same plus the node taking the lease. */
export const fleetLeaseAcquireSchema = fleetLeaseAcquireInputSchema.omit({ projectId: true }).extend({
  nodeId: z.string().min(1).max(200),
});
export type FleetLeaseAcquire = z.infer<typeof fleetLeaseAcquireSchema>;

export const fleetLeaseAcquireResponseSchema = z.object({
  acquired: z.boolean(),
  /** The caller's lease when acquired. */
  lease: fleetLeaseSchema.optional(),
  /** Who holds the name now (when refused, the blockers). */
  holders: z.array(fleetLeaseSchema),
});
export type FleetLeaseAcquireResponse = z.infer<typeof fleetLeaseAcquireResponseSchema>;

export const fleetLeaseReleaseResponseSchema = z.object({ released: z.boolean() });
export type FleetLeaseReleaseResponse = z.infer<typeof fleetLeaseReleaseResponseSchema>;

export const fleetLeaseListResponseSchema = z.object({ leases: z.array(fleetLeaseSchema) });
export type FleetLeaseListResponse = z.infer<typeof fleetLeaseListResponseSchema>;

export const fleetHeartbeatSchema = fleetNodeSchema.omit({ lastSeen: true }).extend({
  jobs: z.array(fleetJobReportSchema).max(1000),
  /** Every lease this node holds. Absent from a node that predates leases: the hub then leaves its leases alone. */
  leases: z.array(fleetLeaseRefSchema).max(1000).optional(),
});
export type FleetHeartbeat = z.infer<typeof fleetHeartbeatSchema>;

export const fleetHeartbeatResponseSchema = z.object({
  /** Newly assigned jobs, at most the node's reported free capacity. */
  assigned: z.array(fleetJobSchema),
  /** Held jobs the hub cancelled: stop the local run. */
  cancel: z.array(z.string()),
  /** Reported jobs this node no longer owns (requeued, unknown): stop and forget. */
  drop: z.array(z.string()),
});
export type FleetHeartbeatResponse = z.infer<typeof fleetHeartbeatResponseSchema>;

export const fleetStatusResponseSchema = z.object({
  nodes: z.array(fleetNodeSchema),
  jobs: z.array(fleetJobSchema),
});
export type FleetStatusResponse = z.infer<typeof fleetStatusResponseSchema>;

/**
 * `GET /api/v1/workspace/fleet` — the cockpit's read-only Fleet panel. `enabled: false` (with empty
 * lists) when this instance has no fleet role; on a worker the cockpit server asks the hub with
 * the token, which never reaches the browser. `error` is set when the hub could not be reached.
 */
export const fleetPanelSchema = z.object({
  enabled: z.boolean(),
  role: z.enum(['hub', 'worker']).optional(),
  nodeId: z.string().optional(),
  nodes: z.array(fleetNodeSchema),
  jobs: z.array(fleetJobSchema),
  error: z.string().optional(),
});
export type FleetPanel = z.infer<typeof fleetPanelSchema>;

export const fleetJobParamsSchema = z.object({ id: z.string().min(1).max(100) });
export type FleetJobParams = z.infer<typeof fleetJobParamsSchema>;

export const fleetErrorSchema = z.object({ error: z.string() });
export type FleetErrorResponse = z.infer<typeof fleetErrorSchema>;
