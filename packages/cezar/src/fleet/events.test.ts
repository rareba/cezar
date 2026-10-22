import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat, FleetJob } from '@open-mercato/cezar-contract';
import { fleetConfigFromEnv } from './config.ts';
import { EventForwarder, EventLog } from './events.ts';
import { FleetHub } from './hub.ts';
import { runFleetCommand } from './fleet-cli.ts';
import { LEASE_MS } from './scheduler.ts';
import { createFleetApp } from './server.ts';

const T0 = Date.parse('2026-10-22T12:00:00Z');
const beat = (nodeId: string, jobs: FleetHeartbeat['jobs'] = []): FleetHeartbeat => ({
  nodeId, version: '1', capacity: { free: 2, max: 2 }, host: {}, jobs,
});
const setup = () => {
  const clock = { now: T0 };
  let n = 0;
  const hub = new FleetHub({ now: () => clock.now, newId: () => `job-${++n}` });
  return { clock, hub };
};
const types = (hub: FleetHub) => hub.events.since(0).events.map((e) => `${e.type}:${e.jobId}`);

describe('hub events', () => {
  it('records started, then finished with the PR, each exactly once however often the node repeats itself', () => {
    const { hub } = setup();
    hub.submit({ repoUrl: 'a/b', task: 'fix the bug', title: 'Fix it' });
    hub.heartbeat(beat('n1'));
    for (let i = 0; i < 3; i++) hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'running', runId: 'r1' }]));
    for (let i = 0; i < 3; i++) hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'review', runId: 'r1' }]));
    hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'done', runId: 'r1', prUrl: 'https://github.com/a/b/pull/7' }]));
    hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'done', runId: 'r1', prUrl: 'https://github.com/a/b/pull/7' }]));
    expect(types(hub)).toEqual(['started:job-1', 'finished:job-1']);
    const finished = hub.events.since(0).events[1] as { text: string; prUrl?: string; title: string; nodeId?: string };
    expect(finished).toMatchObject({ prUrl: 'https://github.com/a/b/pull/7', title: 'Fix it', nodeId: 'n1' });
    expect(finished.text).toBe('Finished on n1: Fix it — https://github.com/a/b/pull/7');
  });

  it('records needs-input once, with the question', () => {
    const { hub } = setup();
    hub.submit({ repoUrl: 'a/b', task: 't' });
    hub.heartbeat(beat('n1'));
    for (let i = 0; i < 3; i++) hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'running', runId: 'r1', needsInput: 'Which database?' }]));
    const events = hub.events.since(0).events;
    expect(events.map((e) => e.type)).toEqual(['started', 'needs-input']);
    expect(events[1]).toMatchObject({ question: 'Which database?' });
    expect(hub.getJob('job-1')?.needsInput).toBe('Which database?');
  });

  it('records a failure, and a job that dies with its node after its last attempt', () => {
    const { hub, clock } = setup();
    hub.submit({ repoUrl: 'a/b', task: 't1' });
    hub.heartbeat(beat('n1'));
    hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'failed', error: 'boom' }]));
    expect(types(hub)).toEqual(['started:job-1', 'failed:job-1']);

    clock.now += 60_000; // n1 goes quiet, so it is not handed the next job
    hub.submit({ repoUrl: 'a/b', task: 't2' });
    for (let attempt = 0; attempt < 3; attempt++) {
      hub.heartbeat(beat(`x${attempt}`)); // takes the job
      hub.heartbeat(beat(`x${attempt}`, [{ id: 'job-2', status: 'running' }]));
      clock.now += LEASE_MS + 1000;
      hub.sweep();
    }
    expect(types(hub).filter((t) => t.endsWith('job-2')).filter((t) => t.startsWith('failed'))).toHaveLength(1);
  });

  it('a requeue after a lost node is not an event, and a restarted hub does not replay old transitions', () => {
    const { hub, clock } = setup();
    hub.submit({ repoUrl: 'a/b', task: 't' });
    hub.heartbeat(beat('n1'));
    hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'running' }]));
    clock.now += LEASE_MS + 1000;
    hub.sweep();
    expect(types(hub)).toEqual(['started:job-1']);
    const restarted = new FleetHub({ now: () => clock.now, initialJobs: hub.status().jobs, initialEvents: { events: hub.events.since(0).events, deliveredSeq: 0 } });
    restarted.heartbeat(beat('n9'));
    expect(restarted.events.since(0).events).toHaveLength(1);
  });
});

describe('EventLog', () => {
  const job = { id: 'j', task: 't', repoUrl: 'a', openPr: true, status: 'running', attempts: 0, createdAt: '', updatedAt: '' } as FleetJob;

  it('numbers events and resumes from a cursor, also across a reload', () => {
    const saved: unknown[] = [];
    const log = new EventLog(undefined, () => T0, (s) => saved.push(s));
    log.emit('started', job);
    log.emit('finished', job);
    expect(log.since(1).events.map((e) => e.seq)).toEqual([2]);
    expect(log.since(2)).toEqual({ events: [], next: 2 });
    const reloaded = new EventLog(saved[saved.length - 1] as never, () => T0);
    expect(reloaded.emit('failed', job).seq).toBe(3);
  });

  it('long-poll wakes on the next event and times out empty otherwise', async () => {
    const log = new EventLog(undefined, () => T0);
    const waiting = log.wait(0, 5000);
    setTimeout(() => log.emit('started', job), 10);
    expect((await waiting).events).toHaveLength(1);
    expect((await log.wait(1, 20)).events).toEqual([]);
  });
});

describe('EventForwarder', () => {
  const job = { id: 'j', task: 'task', repoUrl: 'a', openPr: true, status: 'running', attempts: 0, createdAt: '', updatedAt: '' } as FleetJob;

  it('pushes each event once, in order, signed, and starts from now', async () => {
    const log = new EventLog(undefined, () => T0);
    log.emit('started', job); // history before the webhook existed
    const sent: Array<{ body: string; sig: string | null }> = [];
    const fake = (async (_url: string, init?: RequestInit) => {
      sent.push({ body: String(init?.body), sig: new Headers(init?.headers).get('x-cezar-signature') });
      return new Response('ok');
    }) as unknown as typeof fetch;
    const forwarder = new EventForwarder(log, { url: 'https://hook.example/x', secret: 'k'.repeat(32), fetch: fake });
    forwarder.start();
    log.emit('finished', job);
    log.emit('failed', job);
    for (let i = 0; i < 50 && log.undelivered().length > 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(sent.map((s) => (JSON.parse(s.body) as { type: string }).type)).toEqual(['finished', 'failed']);
    expect(sent[0]?.sig).toBe(`sha256=${createHmac('sha256', 'k'.repeat(32)).update(sent[0]?.body ?? '').digest('hex')}`);
    expect(log.undelivered()).toEqual([]);
  });

  it('retries a failing receiver from the same event, keeping order', async () => {
    const log = new EventLog(undefined, () => T0);
    const bodies: string[] = [];
    let down = true;
    const fake = (async (_u: string, init?: RequestInit) => {
      if (down) return new Response('no', { status: 503 });
      bodies.push((JSON.parse(String(init?.body)) as { type: string }).type);
      return new Response('ok');
    }) as unknown as typeof fetch;
    const forwarder = new EventForwarder(log, { url: 'https://hook.example/x', secret: 'k'.repeat(32), fetch: fake, backoffMs: [5] });
    forwarder.start();
    log.emit('started', job);
    log.emit('finished', job);
    await forwarder.pump();
    expect(log.undelivered()).toHaveLength(2);
    down = false;
    await new Promise((r) => setTimeout(r, 40));
    expect(bodies).toEqual(['started', 'finished']);
    forwarder.stop();
  });
});

describe('listener, CLI and config', () => {
  const token = 'a'.repeat(32);
  it('serves /events with a cursor behind the token, and cezar fleet events prints them', async () => {
    const { hub } = setup();
    hub.submit({ repoUrl: 'a/b', task: 'hello' });
    hub.heartbeat(beat('n1'));
    hub.heartbeat(beat('n1', [{ id: 'job-1', status: 'running' }]));
    const app = createFleetApp(hub, token);
    const h = { authorization: `Bearer ${token}` };
    expect((await app.request('/api/v1/fleet/events')).status).toBe(401);
    const page = (await (await app.request('/api/v1/fleet/events?since=0', { headers: h })).json()) as { events: unknown[]; next: number };
    expect(page.events).toHaveLength(1);
    expect(page.next).toBe(1);
    const out: string[] = [];
    const io = {
      fetch: ((url: string, init?: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch,
      log: (l: string) => out.push(l), error: (l: string) => out.push(`ERR ${l}`),
    };
    expect(await runFleetCommand(['events'], { CEZ_FLEET_HUB_URL: 'http://hub', CEZ_FLEET_TOKEN: token }, io)).toBe(0);
    expect(out[0]).toContain('Started on n1: hello');
  });

  it('reads the webhook URL and refuses a non-http one', () => {
    const env = { CEZ_FLEET_HUB: '1', CEZ_FLEET_TOKEN: token };
    expect(fleetConfigFromEnv({ ...env, CEZ_FLEET_EVENTS_WEBHOOK: 'https://hook.example/x' })).toMatchObject({ eventsWebhook: 'https://hook.example/x' });
    expect(fleetConfigFromEnv({ ...env, CEZ_FLEET_EVENTS_WEBHOOK: 'ftp://x' })).toMatchObject({ role: 'invalid' });
    expect(fleetConfigFromEnv(env)).not.toHaveProperty('eventsWebhook');
  });
});
