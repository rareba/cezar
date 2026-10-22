import { createHmac } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fleetEventSchema, type FleetEvent, type FleetJob } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

/**
 * Hub-side events (spec 2026-10-22-fleet-events): every job transition worth an alert (started,
 * finished, failed, needs input) is recorded ONCE, by the hub, which is the only place that sees all
 * nodes. Consumers read them from `GET /api/v1/fleet/events` (long-poll) or get them pushed by the
 * opt-in webhook forwarder. A restarted hub replays nothing: statuses are persisted, so a transition
 * it already saw is not a transition again.
 */

const KEEP = 500;

export interface EventState {
  events: FleetEvent[];
  /** Highest seq the webhook forwarder got a 2xx for. */
  deliveredSeq: number;
  /** The webhook forwarder has run before: history is not skipped again. */
  forwarding?: boolean;
}

export class EventLog {
  private events: FleetEvent[];
  private deliveredSeq: number;
  private forwarding: boolean;
  private seq: number;
  private listeners = new Set<() => void>();
  private waiters = new Set<() => void>();

  constructor(
    initial: EventState = { events: [], deliveredSeq: 0 },
    private readonly now: () => number = Date.now,
    private readonly persist: (state: EventState) => void = () => {},
  ) {
    this.events = [...initial.events];
    this.deliveredSeq = initial.deliveredSeq;
    this.forwarding = initial.forwarding === true;
    this.seq = Math.max(0, initial.deliveredSeq, ...initial.events.map((e) => e.seq));
  }

  emit(type: FleetEvent['type'], job: FleetJob, extra: { question?: string } = {}): FleetEvent {
    const event: FleetEvent = {
      seq: ++this.seq,
      at: new Date(this.now()).toISOString(),
      type,
      jobId: job.id,
      title: (job.title ?? job.task).replace(/\s+/g, ' ').slice(0, 120),
      ...(job.nodeId ? { nodeId: job.nodeId } : {}),
      ...(job.runId ? { runId: job.runId } : {}),
      ...(job.prUrl ? { prUrl: job.prUrl } : {}),
      ...(job.branch ? { branch: job.branch } : {}),
      ...(job.branchUrl ? { branchUrl: job.branchUrl } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(extra.question ? { question: extra.question.slice(0, 400) } : {}),
      text: describeEvent(type, job, extra.question),
    };
    this.events = [...this.events, event].slice(-KEEP);
    this.save();
    for (const wake of [...this.waiters]) wake();
    for (const listener of this.listeners) listener();
    return event;
  }

  /** Events after `seq`, oldest first, and the cursor to ask with next. */
  since(seq: number): { events: FleetEvent[]; next: number } {
    const events = this.events.filter((e) => e.seq > seq);
    return { events, next: events.length > 0 ? (events[events.length - 1] as FleetEvent).seq : Math.max(seq, 0) };
  }

  /** Like `since`, but when nothing is new waits up to `ms` for the next event (long-poll). */
  async wait(seq: number, ms: number): Promise<{ events: FleetEvent[]; next: number }> {
    const ready = this.since(seq);
    if (ready.events.length > 0 || ms <= 0) return ready;
    await new Promise<void>((done) => {
      const finish = (): void => {
        clearTimeout(timer);
        this.waiters.delete(finish);
        done();
      };
      const timer = setTimeout(finish, ms);
      this.waiters.add(finish);
    });
    return this.since(seq);
  }

  /** Events the webhook has not yet got a 2xx for. */
  undelivered(): FleetEvent[] {
    return this.events.filter((e) => e.seq > this.deliveredSeq);
  }

  markDelivered(seq: number): void {
    if (seq <= this.deliveredSeq) return;
    this.deliveredSeq = seq;
    this.save();
  }

  onEmit(listener: () => void): void {
    this.listeners.add(listener);
  }

  /** The first time a webhook is configured it starts from now: history is not pushed to a receiver that never asked for it. */
  beginForwarding(): void {
    if (!this.forwarding) {
      this.forwarding = true;
      this.deliveredSeq = this.seq;
      this.save();
    }
  }

  private save(): void {
    try {
      this.persist({ events: this.events, deliveredSeq: this.deliveredSeq, forwarding: this.forwarding });
    } catch (error) {
      console.warn(`fleet: could not save events.json (${error instanceof Error ? error.message : String(error)})`);
    }
  }
}

function describeEvent(type: FleetEvent['type'], job: FleetJob, question?: string): string {
  const title = (job.title ?? job.task).replace(/\s+/g, ' ').slice(0, 80);
  const where = job.nodeId ? ` on ${job.nodeId}` : '';
  switch (type) {
    case 'started':
      return `Started${where}: ${title}`;
    case 'finished':
      return `Finished${where}: ${title}${job.prUrl ? ` — ${job.prUrl}` : job.branchUrl ? ` — ${job.branchUrl}` : job.branch ? ` — branch ${job.branch}` : ''}`;
    case 'failed':
      return `Failed${where}: ${title}${job.error ? ` — ${job.error}` : ''}`;
    case 'needs-input':
      return `Needs input${where}: ${title}${question ? ` — ${question.slice(0, 200)}` : ''}`;
  }
}

// ---- persistence (fleet/events.json) ----------------------------------------------------------

const fileSchema = z.object({ version: z.literal(1), deliveredSeq: z.number().int().nonnegative().default(0), forwarding: z.boolean().optional(), events: z.array(z.unknown()) });

export function fleetEventsPath(): string {
  return join(cezarHomeDir(), 'fleet', 'events.json');
}

export function loadEvents(path = fleetEventsPath()): EventState {
  try {
    const file = fileSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
    return {
      deliveredSeq: file.deliveredSeq,
      ...(file.forwarding ? { forwarding: true } : {}),
      events: file.events.flatMap((entry) => {
        const parsed = fleetEventSchema.safeParse(entry);
        return parsed.success ? [parsed.data] : [];
      }),
    };
  } catch {
    return { events: [], deliveredSeq: 0 };
  }
}

export function saveEvents(state: EventState, path = fleetEventsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, ...state }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}

// ---- outbound webhook (opt-in: CEZ_FLEET_EVENTS_WEBHOOK) ---------------------------------------

export const WEBHOOK_BACKOFF_MS = [1_000, 5_000, 30_000, 120_000, 600_000];

/**
 * Pushes each event to ONE webhook, in order, once: the cursor moves only on a 2xx, a failing
 * receiver is retried with backoff (head of line, so order holds), and the cursor survives a
 * restart. Body: the event JSON; `x-cezar-signature: sha256=<hmac of the body keyed by the fleet token>`.
 */
export class EventForwarder {
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private failures = 0;

  constructor(
    private readonly log: EventLog,
    private readonly options: { url: string; secret: string; fetch?: typeof fetch; backoffMs?: readonly number[]; warn?: (message: string) => void },
  ) {}

  start(): void {
    this.log.beginForwarding();
    this.log.onEmit(() => this.poke());
    void this.pump();
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
  }

  /** Called after each emit; also drives the retry timer. */
  poke(): void {
    if (!this.timer) void this.pump();
  }

  async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Re-read each round: events emitted while one was in flight are picked up by this same loop.
      for (let event = this.log.undelivered()[0]; event; event = this.log.undelivered()[0]) {
        const ok = await this.post(event);
        if (!ok) {
          const backoff = this.options.backoffMs ?? WEBHOOK_BACKOFF_MS;
          const wait = backoff[Math.min(this.failures, backoff.length - 1)] as number;
          this.failures += 1;
          this.timer = setTimeout(() => {
            this.timer = undefined;
            void this.pump();
          }, wait);
          this.timer.unref();
          return;
        }
        this.failures = 0;
        this.log.markDelivered(event.seq);
      }
    } finally {
      this.running = false;
    }
  }

  private async post(event: FleetEvent): Promise<boolean> {
    const body = JSON.stringify(event);
    try {
      const response = await (this.options.fetch ?? fetch)(this.options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-cezar-event': event.type,
          'x-cezar-signature': `sha256=${createHmac('sha256', this.options.secret).update(body).digest('hex')}`,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) this.options.warn?.(`fleet: events webhook answered ${response.status}; will retry`);
      return response.ok;
    } catch (error) {
      this.options.warn?.(`fleet: events webhook failed (${error instanceof Error ? error.message : String(error)}); will retry`);
      return false;
    }
  }
}
