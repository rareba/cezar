import { randomUUID } from 'node:crypto';
import type { FleetJob, FleetMail, FleetMailSubmit } from '@open-mercato/cezar-contract';

/**
 * Mail between tasks on different nodes (spec 2026-10-22-fleet-mailbox).
 *
 * `MailTable` is the hub's side: it takes mail from a node's outbox, works out which node the
 * recipient runs on, and keeps the mail until that node acknowledges it. `NodeMailbox` is a node's
 * side: the outbox that rides the heartbeat, and the dedupe for what the hub redelivers.
 */

/** Undelivered mail older than this is dropped (the recipient is gone). */
export const MAIL_TTL_MS = 24 * 60 * 60_000;
const MAX_PENDING = 1000;

export class MailTable {
  /** id -> mail still to deliver; `unresolved` holds mail addressed by job id before the job has a run. */
  private readonly pending = new Map<string, FleetMail>();
  private readonly unresolved = new Map<string, { mail: FleetMailSubmit; at: number }>();
  private readonly seen = new Set<string>();

  constructor(
    initial: readonly FleetMail[] = [],
    private readonly now: () => number = Date.now,
    private readonly onChange: (mail: FleetMail[]) => void = () => {},
  ) {
    for (const mail of initial) this.pending.set(mail.id, mail);
  }

  list(): FleetMail[] {
    return [...this.pending.values()];
  }

  /** Accept a node's outgoing mail. Idempotent by id. */
  accept(mail: FleetMailSubmit, jobs: ReadonlyMap<string, FleetJob>): void {
    if (this.seen.has(mail.id) || this.pending.has(mail.id) || this.unresolved.has(mail.id)) return;
    this.seen.add(mail.id);
    if (this.seen.size > 5000) this.seen.delete(this.seen.values().next().value as string);
    this.unresolved.set(mail.id, { mail, at: this.now() });
    this.resolve(jobs);
  }

  /** Address unresolved mail: a job id names its node and run once the job has reported a run. */
  resolve(jobs: ReadonlyMap<string, FleetJob>): void {
    let changed = false;
    for (const [id, { mail, at }] of [...this.unresolved]) {
      const job = mail.to.jobId ? jobs.get(mail.to.jobId) : undefined;
      const runId = mail.to.runId ?? job?.runId;
      const nodeId = mail.to.nodeId ?? job?.nodeId ?? (runId ? [...jobs.values()].find((j) => j.runId === runId)?.nodeId : undefined);
      if (runId && nodeId) {
        this.unresolved.delete(id);
        this.pending.set(id, { ...mail, to: { ...mail.to, runId, nodeId }, createdAt: new Date(at).toISOString() });
        changed = true;
      }
    }
    const now = this.now();
    for (const [id, { at }] of this.unresolved) if (now - at > MAIL_TTL_MS) this.unresolved.delete(id);
    for (const [id, mail] of this.pending) {
      if (now - Date.parse(mail.createdAt) > MAIL_TTL_MS || this.pending.size > MAX_PENDING) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange(this.list());
  }

  forNode(nodeId: string, limit = 50): FleetMail[] {
    return this.list().filter((m) => m.to.nodeId === nodeId).slice(0, limit);
  }

  /** The node delivered these: forget them. Only the addressed node may acknowledge. */
  ack(nodeId: string, ids: readonly string[]): void {
    let changed = false;
    for (const id of ids) {
      if (this.pending.get(id)?.to.nodeId === nodeId) {
        this.pending.delete(id);
        changed = true;
      }
    }
    if (changed) this.onChange(this.list());
  }
}

export class NodeMailbox {
  private outbox: FleetMailSubmit[] = [];
  private readonly delivered = new Set<string>();
  private acks: string[] = [];

  constructor(private readonly nodeId: () => string = () => 'unknown') {}

  /** Queue mail for the next heartbeat. */
  send(mail: Omit<FleetMailSubmit, 'id' | 'from'> & { from?: Partial<FleetMailSubmit['from']> }): string {
    const id = randomUUID();
    this.outbox.push({ ...mail, id, from: { ...mail.from, nodeId: mail.from?.nodeId ?? this.nodeId() } });
    return id;
  }

  peekOutbox(): FleetMailSubmit[] {
    return this.outbox.slice(0, 100);
  }

  peekAcks(): string[] {
    return this.acks.slice(0, 500);
  }

  /** The heartbeat that carried these got through. */
  sent(outbox: readonly FleetMailSubmit[], acks: readonly string[]): void {
    const ids = new Set(outbox.map((m) => m.id));
    this.outbox = this.outbox.filter((m) => !ids.has(m.id));
    this.acks = this.acks.filter((id) => !acks.includes(id));
  }

  /** Run `deliver` once per mail id; acknowledge it afterwards. The hub redelivers until it hears the ack. */
  async receive(mail: readonly FleetMail[], deliver: (mail: FleetMail) => Promise<void>): Promise<void> {
    for (const m of mail) {
      if (!this.delivered.has(m.id)) {
        try {
          await deliver(m);
        } catch {
          continue; // not acknowledged: the hub sends it again
        }
        this.delivered.add(m.id);
        if (this.delivered.size > 5000) this.delivered.delete(this.delivered.values().next().value as string);
      }
      if (!this.acks.includes(m.id)) this.acks.push(m.id);
    }
  }
}
