import { cpus, freemem, loadavg, platform } from 'node:os';
import type { DispatchReport, FleetHeartbeat, FleetHeartbeatResponse, FleetJob, FleetJobReport, FleetLeaseRef, FleetMail } from '@open-mercato/cezar-contract';
import type { NodeMailbox } from './mailbox.ts';

/**
 * The per-node worker loop (spec 2026-10-21-fleet-coordination). Every node — the hub included —
 * heartbeats its free capacity and the jobs it holds, runs what comes back, and maps each local run
 * onto a job status. It knows nothing about HTTP or RunManager: the transport and the run host are
 * injected, so the hub runs the same loop in-process and tests drive it with fakes.
 */

export const HEARTBEAT_MS = 5_000;

/** What the worker needs from a node's run machinery (`runs.ts` is the real one). */
export interface RecoveredRun {
  jobId: string;
  runId: string;
  openPr: boolean;
}

export interface FleetRunHost {
  /** Resolve the job's repo to a local project (cloning if needed) and start a run; returns the run id. */
  start(job: FleetJob): Promise<string>;
  /** The run's current state, or undefined when it is gone. */
  get(runId: string): { status: string; branch?: string; error?: string; needsInput?: string } | undefined;
  cancel(runId: string): void;
  /** Live fleet runs recovered from this node's previous process, for the worker to adopt. */
  recover(): Promise<RecoveredRun[]>;
  /** Deliver mail into a task on this node. Resolves normally once handled (or the task is unknown); throws to be retried. */
  deliverMail?(mail: FleetMail): Promise<void>;
  /** The report a settled run hands its parent (prose + structured), or undefined when it has no run record. */
  settleReport?(runId: string, extra: { prUrl?: string; branchUrl?: string }): { text: string; report: DispatchReport; title: string } | undefined;
  /** Push the run's branch and open a draft PR so the result survives an ephemeral pod. */
  publish(runId: string): Promise<{ ok: true; url?: string; branchUrl?: string } | { ok: false; error: string }>;
}

export interface FleetWorkerOptions {
  nodeId: string;
  version: string;
  host: FleetRunHost;
  transport: (heartbeat: FleetHeartbeat) => Promise<FleetHeartbeatResponse>;
  /** The node's own effective capacity. Autoscaled or dynamic local limits show up here and so
   *  steer the whole fleet's distribution. */
  capacity: () => { free: number; max: number };
  intervalMs?: number;
  /** The leases this node stands behind; the heartbeat names them so the hub keeps them alive. */
  leases?: () => Promise<FleetLeaseRef[]> | FleetLeaseRef[];
  /** Capabilities this node advertises. */
  tags?: () => string[];
  /** This node's mail: sub-task reports to a remote parent, and what the hub hands in. */
  mailbox?: NodeMailbox;
  /** A job older than this is failed and its run cancelled. Unset = no limit (tests). */
  jobTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

interface Held {
  job: FleetJob;
  runId?: string;
  branch?: string;
  prUrl?: string;
  branchUrl?: string;
  error?: string;
  status: FleetJobReport['status'];
  needsInput?: string;
  publishing: boolean;
  startedAt: number;
  /** Cancelled/dropped by the hub, possibly while `host.start()` was still cloning. */
  released: boolean;
}

/** Run statuses that mean "still working" (autonomous runs never park at `waiting`). */
const LIVE_RUN = new Set(['queued', 'running', 'waiting']);

/** `git push` + `gh pr create` find nothing to propose when the agent changed nothing. */
const NOTHING_TO_PROPOSE = /^nothing to propose/;

export function hostMetrics(): FleetHeartbeat['host'] {
  const cores = cpus().length;
  // loadavg is always 0 on Windows; omit rather than report a false idle.
  const cpuPct = platform() === 'win32' || cores === 0 ? undefined : Math.min(100, Math.round(((loadavg()[0] ?? 0) / cores) * 100));
  return { ...(cpuPct !== undefined ? { cpuPct } : {}), memAvailableBytes: freemem() };
}

export class FleetWorker {
  private readonly held = new Map<string, Held>();
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;
  private stopped = true;
  private lastError = '';

  constructor(private readonly options: FleetWorkerOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    const loop = (): void => {
      void this.tick().finally(() => {
        if (this.stopped) return;
        this.timer = setTimeout(loop, this.options.intervalMs ?? HEARTBEAT_MS);
        this.timer.unref();
      });
    };
    loop();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  /**
   * Take over runs this node recovered after a restart. They are reported on the first heartbeat:
   * if the hub still assigns the job here it carries on, otherwise it answers `drop` and the
   * ordinary release path cancels the run.
   */
  adopt(recovered: readonly RecoveredRun[]): void {
    const at = new Date().toISOString();
    for (const r of recovered) {
      if (this.held.has(r.jobId)) continue;
      const job: FleetJob = {
        id: r.jobId, repoUrl: '', task: '', openPr: r.openPr, status: 'running', attempts: 0, createdAt: at, updatedAt: at,
      };
      this.held.set(r.jobId, { job, runId: r.runId, status: 'running', publishing: false, startedAt: (this.options.now ?? Date.now)(), released: false });
    }
  }

  /** Jobs this node currently holds (tests, status). */
  heldJobIds(): string[] {
    return [...this.held.keys()];
  }

  /** One heartbeat round. Never throws: a hub that is down is retried on the next tick. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.pollRuns();
      const reports = [...this.held.values()].map(report);
      // Jobs handed to us whose run is not created yet, or is queued behind the semaphore, hold no
      // slot, so count them as used or the hub would over-assign.
      const starting = [...this.held.values()].filter(
        (h) => h.status === 'running' && (!h.runId || this.options.host.get(h.runId)?.status === 'queued'),
      ).length;
      const { free, max } = this.options.capacity();
      const leases = await this.options.leases?.();
      const outbox = this.options.mailbox?.peekOutbox() ?? [];
      const acks = this.options.mailbox?.peekAcks() ?? [];
      let response: FleetHeartbeatResponse;
      try {
        response = await this.options.transport({
          nodeId: this.options.nodeId,
          version: this.options.version,
          capacity: { free: Math.max(0, free - starting), max },
          host: hostMetrics(),
          ...(this.options.tags ? { tags: this.options.tags() } : {}),
          jobs: reports,
          ...(leases ? { leases } : {}),
          ...(outbox.length > 0 ? { outbox } : {}),
          ...(acks.length > 0 ? { mailAck: acks } : {}),
        });
        this.lastError = '';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message !== this.lastError) this.options.log?.(`fleet: heartbeat failed (${message}); will retry`);
        this.lastError = message;
        return;
      }
      this.options.mailbox?.sent(outbox, acks);
      this.apply(response, reports);
      const { mailbox, host } = this.options;
      if (mailbox && host.deliverMail && response.mail?.length) await mailbox.receive(response.mail, (m) => host.deliverMail!(m));
    } finally {
      this.ticking = false;
    }
  }

  private apply(response: FleetHeartbeatResponse, sent: FleetJobReport[]): void {
    // The hub has seen the final report of a finished job; only now is it safe to forget it.
    for (const r of sent) {
      if (r.status !== 'done' && r.status !== 'failed') continue;
      const held = this.held.get(r.id);
      if (held) this.mailParent(held);
      this.held.delete(r.id);
    }
    for (const id of [...response.cancel, ...response.drop]) this.release(id);
    for (const job of response.assigned) {
      if (this.held.has(job.id)) continue; // redelivered assignment we already acted on
      const held: Held = { job, status: 'running', publishing: false, startedAt: (this.options.now ?? Date.now)(), released: false };
      this.held.set(job.id, held);
      void this.begin(held);
    }
  }

  /** A sub-task whose parent runs elsewhere reports to it by mail once its job has settled (spec 2026-10-22-fleet-mailbox). */
  private mailParent(held: Held): void {
    const parent = held.job.parent;
    const mailbox = this.options.mailbox;
    if (!parent || !mailbox || held.released) return;
    const settled = held.runId ? this.options.host.settleReport?.(held.runId, { prUrl: held.prUrl, branchUrl: held.branchUrl }) : undefined;
    const failed = held.status === 'failed';
    const report: DispatchReport = settled?.report ?? {
      status: failed ? 'failed' : 'done',
      result: held.error ?? (failed ? 'the job failed' : 'finished'),
      evidence: [], side_effects: [], errors: held.error ? [held.error] : [], suggestions: [],
    };
    const links = [held.prUrl ? `PR ${held.prUrl}` : '', held.branchUrl ? `branch ${held.branchUrl}` : ''].filter(Boolean).join(', ');
    const title = settled?.title ?? held.job.title ?? 'sub-task';
    const text = settled?.text ?? `Report from task "${title}" (job ${held.job.id}): status ${report.status}; ${report.result}${links ? `; ${links}` : ''}`;
    mailbox.send({
      to: { runId: parent.runId, nodeId: parent.nodeId, ...(parent.projectId ? { projectId: parent.projectId } : {}) },
      from: { ...(held.runId ? { runId: held.runId } : {}), title },
      kind: 'report',
      subject: `Report from ${title}`,
      body: text.slice(0, 19_000),
      report,
    });
  }

  private async begin(held: Held): Promise<void> {
    try {
      held.runId = await this.options.host.start(held.job);
      // Cancelled while cloning: there was no run to stop then, so stop it now.
      if (held.released) this.options.host.cancel(held.runId);
    } catch (error) {
      held.status = 'failed';
      held.error = error instanceof Error ? error.message : String(error);
    }
  }

  private release(jobId: string): void {
    const held = this.held.get(jobId);
    if (!held) return;
    held.released = true;
    this.held.delete(jobId);
    if (held.runId) this.options.host.cancel(held.runId);
  }

  /** Map each held job's local run onto a job status. */
  private pollRuns(): void {
    for (const held of this.held.values()) {
      if (held.status === 'done' || held.status === 'failed' || held.publishing) continue;
      const limit = this.options.jobTimeoutMs;
      if (limit && (this.options.now ?? Date.now)() - held.startedAt > limit) {
        // A hung or endlessly monitoring run would renew its lease forever.
        held.status = 'failed';
        held.error = `job exceeded the ${Math.round(limit / 60_000)} minute limit (CEZ_FLEET_JOB_TIMEOUT_MINUTES)`;
        held.released = true;
        if (held.runId) this.options.host.cancel(held.runId);
        continue;
      }
      if (!held.runId) continue;
      const run = this.options.host.get(held.runId);
      if (!run) {
        held.status = 'failed';
        held.error = 'run disappeared from the node';
        continue;
      }
      if (run.branch) held.branch = run.branch;
      if (run.needsInput) held.needsInput = run.needsInput;
      if (LIVE_RUN.has(run.status)) held.status = 'running';
      else if (run.status === 'done' || run.status === 'review') void this.finish(held);
      else {
        held.status = 'failed';
        held.error = run.error ?? (run.status === 'cancelled' ? 'run was cancelled on the node' : 'run failed');
      }
    }
  }

  private async finish(held: Held): Promise<void> {
    if (!held.job.openPr || !held.runId) {
      held.status = 'done'; // no PR was asked for: the branch stays on this node
      return;
    }
    held.publishing = true;
    held.status = 'review';
    try {
      const result = await this.options.host.publish(held.runId);
      if (result.ok) {
        if (result.url) held.prUrl = result.url;
        if (result.branchUrl) held.branchUrl = result.branchUrl;
        held.status = 'done';
      } else if (NOTHING_TO_PROPOSE.test(result.error)) {
        held.status = 'done'; // the agent changed nothing: finished, no PR to open
      } else {
        held.status = 'failed';
        held.error = result.error;
      }
    } catch (error) {
      held.status = 'failed';
      held.error = error instanceof Error ? error.message : String(error);
    }
  }
}

function report(held: Held): FleetJobReport {
  return {
    id: held.job.id,
    status: held.status,
    ...(held.runId ? { runId: held.runId } : {}),
    ...(held.branch ? { branch: held.branch } : {}),
    ...(held.prUrl ? { prUrl: held.prUrl } : {}),
    ...(held.branchUrl ? { branchUrl: held.branchUrl } : {}),
    ...(held.error ? { error: held.error } : {}),
    ...(held.needsInput ? { needsInput: held.needsInput } : {}),
  };
}
