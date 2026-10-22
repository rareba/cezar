import { randomUUID } from 'node:crypto';
import type {
  FleetHeartbeat,
  FleetHeartbeatResponse,
  FleetJob,
  FleetLease,
  FleetLeaseAcquire,
  FleetLeaseAcquireResponse,
  FleetMail,
  FleetMailSubmit,
  FleetNode,
  FleetStatusResponse,
  FleetSubmit,
} from '@open-mercato/cezar-contract';
import { LeaseTable } from './leases.ts';
import { MailTable } from './mailbox.ts';
import {
  LEASE_MS,
  applyReport,
  assignJob,
  cancelJob,
  expireLeases,
  isHeld,
  isTerminal,
  planAssignments,
} from './scheduler.ts';

/** Finished jobs kept in jobs.json — the queue must not grow without bound. */
const KEEP_TERMINAL = 500;
/** Nodes silent for this long drop off the status table. */
const FORGET_NODE_MS = 10 * 60_000;

export interface FleetHubOptions {
  /** Saved jobs (jobs.json). */
  initialJobs?: readonly FleetJob[];
  /** Called with the full queue whenever something other than a lease renewal changed. */
  persist?: (jobs: FleetJob[]) => void;
  /** Saved leases (leases.json) and the writer for them. */
  initialLeases?: readonly FleetLease[];
  persistLeases?: (leases: FleetLease[]) => void;
  /** Undelivered task mail (mail.json) and its writer. */
  initialMail?: readonly FleetMail[];
  persistMail?: (mail: FleetMail[]) => void;
  now?: () => number;
  newId?: () => string;
}

/**
 * The hub's in-memory state: the job queue (persisted) and the nodes table (rebuilt from
 * heartbeats). All scheduling rules live in `scheduler.ts`; this class only applies them.
 */
export class FleetHub {
  private readonly jobs = new Map<string, FleetJob>();
  private readonly nodes = new Map<string, FleetNode>();
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly persist: (jobs: FleetJob[]) => void;
  private readonly leases: LeaseTable;
  private readonly mail: MailTable;

  constructor(options: FleetHubOptions = {}) {
    this.now = options.now ?? Date.now;
    const persistMail = options.persistMail ?? (() => {});
    this.mail = new MailTable(options.initialMail, this.now, (all) => {
      try {
        persistMail(all);
      } catch (error) {
        console.warn(`fleet: could not save mail.json (${error instanceof Error ? error.message : String(error)})`);
      }
    });
    const persistLeases = options.persistLeases ?? (() => {});
    this.leases = new LeaseTable(options.initialLeases, this.now, (all) => {
      try {
        persistLeases(all);
      } catch (error) {
        console.warn(`fleet: could not save leases.json (${error instanceof Error ? error.message : String(error)})`);
      }
    });
    this.newId = options.newId ?? randomUUID;
    this.persist = options.persist ?? (() => {});
    for (const job of options.initialJobs ?? []) {
      // After a hub restart nobody has re-reported yet: give every holder a full lease to do so
      // rather than requeueing work that is still running.
      this.jobs.set(job.id, isHeld(job) ? { ...job, leaseExpiresAt: new Date(this.now() + LEASE_MS).toISOString() } : job);
    }
  }

  submit(input: FleetSubmit): FleetJob {
    const at = new Date(this.now()).toISOString();
    const job: FleetJob = {
      id: this.newId(),
      repoUrl: input.repoUrl,
      task: input.task,
      ...(input.baseBranch ? { baseBranch: input.baseBranch } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(input.runner ? { runner: input.runner } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.maxCostUsd ? { maxCostUsd: input.maxCostUsd } : {}),
      openPr: input.openPr ?? true,
      status: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    };
    this.jobs.set(job.id, job);
    this.save();
    return job;
  }

  cancel(id: string): FleetJob | undefined {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    const next = cancelJob(job, this.now());
    if (next !== job) {
      this.jobs.set(id, next);
      // Sub-tasks die with their parent: a cost brake that left them spending would not brake.
      for (const child of this.jobs.values()) if (child.parent?.jobId === id && child.status !== 'cancelled') this.cancel(child.id);
      this.save();
    }
    return next;
  }

  /** Requeue (or fail) held jobs whose lease ran out. The hub also calls this on a timer. */
  sweep(): void {
    const now = this.now();
    const expired = expireLeases([...this.jobs.values()], now);
    for (const job of expired) this.jobs.set(job.id, job);
    for (const [id, node] of this.nodes) {
      if (now - Date.parse(node.lastSeen) > FORGET_NODE_MS) this.nodes.delete(id);
    }
    if (expired.length > 0) this.save();
    this.leases.sweep();
  }

  acquireLease(input: FleetLeaseAcquire): FleetLeaseAcquireResponse {
    return this.leases.acquire(input);
  }

  renewLease(name: string, holder: string): FleetLease | undefined {
    return this.leases.renew(name, holder);
  }

  releaseLease(name: string, holder: string): boolean {
    return this.leases.release(name, holder);
  }

  /** Queue mail for a task (the hub's own CLI path; nodes send through their heartbeat outbox). */
  sendMail(mail: FleetMailSubmit): void {
    this.mail.accept(mail, this.jobs);
  }

  listLeases(): FleetLease[] {
    this.leases.sweep();
    return this.leases.list();
  }

  heartbeat(hb: FleetHeartbeat): FleetHeartbeatResponse {
    const now = this.now();
    const { jobs: reports, leases: _leases, outbox, mailAck, ...nodeInfo } = hb;
    const node: FleetNode = { ...nodeInfo, lastSeen: new Date(now).toISOString() };
    this.nodes.set(hb.nodeId, node);
    this.sweep();
    if (hb.leases) this.leases.syncNode(hb.nodeId, hb.leases);

    const cancel: string[] = [];
    const drop: string[] = [];
    let changed = false;
    const reported = new Set<string>();
    for (const report of reports) {
      reported.add(report.id);
      const outcome = applyReport(this.jobs.get(report.id), hb.nodeId, report, now);
      if (outcome.action === 'cancel') cancel.push(report.id);
      else if (outcome.action === 'drop') drop.push(report.id);
      else {
        this.jobs.set(report.id, outcome.job);
        changed ||= outcome.changed;
      }
    }

    // An assignment whose response got lost is handed out again until the node acknowledges it by
    // reporting it; the lease (not renewed without a report) bounds how long that can go on.
    const assigned: FleetJob[] = [...this.jobs.values()].filter(
      (j) => j.status === 'assigned' && j.nodeId === hb.nodeId && !reported.has(j.id),
    );
    const plan = planAssignments([...this.jobs.values()], [...this.nodes.values()], now);
    for (const [jobId, nodeId] of plan) {
      if (nodeId !== hb.nodeId) continue;
      const job = assignJob(this.jobs.get(jobId) as FleetJob, nodeId, now);
      this.jobs.set(jobId, job);
      assigned.push(job);
      node.capacity = { ...node.capacity, free: Math.max(0, node.capacity.free - 1) };
      changed = true;
    }
    if (changed) this.save();
    // Mail last: a job that just reported its run id can now be addressed by job id.
    for (const m of outbox ?? []) this.mail.accept(m, this.jobs);
    this.mail.ack(hb.nodeId, mailAck ?? []);
    this.mail.resolve(this.jobs);
    const mail = this.mail.forNode(hb.nodeId);
    return { assigned, cancel, drop, ...(mail.length > 0 ? { mail } : {}) };
  }

  status(): FleetStatusResponse {
    return {
      nodes: [...this.nodes.values()].sort((a, b) => a.nodeId.localeCompare(b.nodeId)),
      jobs: [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }

  getJob(id: string): FleetJob | undefined {
    return this.jobs.get(id);
  }

  private save(): void {
    const all = [...this.jobs.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const finished = all.filter(isTerminal);
    for (const job of finished.slice(0, Math.max(0, finished.length - KEEP_TERMINAL))) this.jobs.delete(job.id);
    try {
      this.persist([...this.jobs.values()]);
    } catch (error) {
      // A read-only home degrades to an in-memory queue, never a crash.
      console.warn(`fleet: could not save jobs.json (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}
