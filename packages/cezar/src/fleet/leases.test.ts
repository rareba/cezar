import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat, FleetLease } from '@open-mercato/cezar-contract';
import { FleetHub } from './hub.ts';
import { LocalLeases } from './leases-local.ts';
import { LeaseTable } from './leases.ts';
import { LEASE_MS, NODE_TTL_MS } from './scheduler.ts';
import { createFleetApp } from './server.ts';

const T0 = Date.parse('2026-10-22T12:00:00Z');
const table = () => {
  const clock = { now: T0 };
  const saved: FleetLease[][] = [];
  return { clock, saved, t: new LeaseTable([], () => clock.now, (l) => saved.push(l)) };
};
const take = (t: LeaseTable, holder: string, over: Record<string, unknown> = {}) =>
  t.acquire({ name: 'issue-1', holder, nodeId: 'n1', ...over });

describe('LeaseTable', () => {
  it('gives a name to one holder and refuses the next', () => {
    const { t } = table();
    expect(take(t, 'a').acquired).toBe(true);
    const refused = take(t, 'b');
    expect(refused.acquired).toBe(false);
    expect(refused.holders.map((h) => h.holder)).toEqual(['a']);
  });

  it('is idempotent per holder: asking again renews instead of refusing', () => {
    const { t, clock } = table();
    take(t, 'a');
    clock.now += 30_000;
    const again = take(t, 'a');
    expect(again.acquired).toBe(true);
    expect(again.lease?.expiresAt).toBe(new Date(clock.now + LEASE_MS).toISOString());
    expect(t.list()).toHaveLength(1);
  });

  it('limit > 1 is a counting semaphore', () => {
    const { t } = table();
    expect(take(t, 'a', { limit: 2 }).acquired).toBe(true);
    expect(take(t, 'b', { limit: 2 }).acquired).toBe(true);
    expect(take(t, 'c', { limit: 2 }).acquired).toBe(false);
  });

  it('frees an expired lease for the next taker', () => {
    const { t, clock } = table();
    take(t, 'a');
    clock.now += LEASE_MS + 1;
    expect(take(t, 'b').acquired).toBe(true);
    expect(t.list().map((l) => l.holder)).toEqual(['b']);
  });

  it('releases only the named holder, and renews only a live lease', () => {
    const { t, clock } = table();
    take(t, 'a');
    expect(t.release('issue-1', 'b')).toBe(false);
    expect(t.renew('issue-1', 'a')).toBeDefined();
    clock.now += LEASE_MS + 1;
    expect(t.renew('issue-1', 'a')).toBeUndefined();
    expect(t.release('issue-1', 'a')).toBe(true);
  });

  it('gives restored leases a fresh term after a hub restart', () => {
    const { t } = table();
    const lease = take(t, 'a').lease as FleetLease;
    const clock = { now: T0 + 10 * LEASE_MS };
    const restored = new LeaseTable([lease], () => clock.now);
    expect(take(restored, 'b').acquired).toBe(false);
  });

  it('persists on acquire, release and expiry but not on renewal', () => {
    const { t, clock, saved } = table();
    take(t, 'a');
    take(t, 'a');
    expect(saved).toHaveLength(1);
    t.release('issue-1', 'a');
    expect(saved).toHaveLength(2);
    take(t, 'a');
    clock.now += LEASE_MS + 1;
    t.sweep();
    expect(saved).toHaveLength(4);
  });
});

const beat = (nodeId: string, leases?: Array<{ name: string; holder: string }>): FleetHeartbeat => ({
  nodeId, version: '1', capacity: { free: 1, max: 1 }, host: {}, jobs: [], ...(leases ? { leases } : {}),
});

describe('FleetHub leases', () => {
  const setup = () => {
    const clock = { now: T0 };
    return { clock, hub: new FleetHub({ now: () => clock.now }) };
  };

  it('is kept alive by the holder node heartbeat', () => {
    const { hub, clock } = setup();
    hub.heartbeat(beat('n1'));
    hub.acquireLease({ name: 'x', holder: 'r1', nodeId: 'n1' });
    for (let i = 0; i < 20; i++) {
      clock.now += 10_000;
      hub.heartbeat(beat('n1', [{ name: 'x', holder: 'r1' }]));
    }
    expect(hub.acquireLease({ name: 'x', holder: 'r2', nodeId: 'n2' }).acquired).toBe(false);
  });

  it('frees what a dead node held, with no one releasing it', () => {
    const { hub, clock } = setup();
    hub.heartbeat(beat('n1'));
    hub.acquireLease({ name: 'x', holder: 'r1', nodeId: 'n1' });
    clock.now += LEASE_MS + 1;
    hub.heartbeat(beat('n2'));
    expect(hub.listLeases()).toEqual([]);
    expect(hub.acquireLease({ name: 'x', holder: 'r2', nodeId: 'n2' }).acquired).toBe(true);
  });

  it('frees a lease its node stopped naming (the run ended without releasing)', () => {
    const { hub, clock } = setup();
    hub.acquireLease({ name: 'x', holder: 'r1', nodeId: 'n1' });
    clock.now += 1_000;
    hub.heartbeat(beat('n1', [])); // young: spared, the heartbeat may predate the acquire
    expect(hub.listLeases()).toHaveLength(1);
    clock.now += NODE_TTL_MS;
    hub.heartbeat(beat('n1', []));
    expect(hub.listLeases()).toEqual([]);
  });

  it('leaves leases alone when the heartbeat predates leases (no `leases` key)', () => {
    const { hub, clock } = setup();
    hub.acquireLease({ name: 'x', holder: 'r1', nodeId: 'n1' });
    clock.now += NODE_TTL_MS + 1;
    hub.heartbeat(beat('n1'));
    expect(hub.listLeases()).toHaveLength(1);
  });

  it("never touches another node's leases", () => {
    const { hub, clock } = setup();
    hub.acquireLease({ name: 'x', holder: 'r1', nodeId: 'n1' });
    clock.now += NODE_TTL_MS + 1;
    hub.heartbeat(beat('n2', []));
    expect(hub.listLeases()).toHaveLength(1);
  });
});

describe('LocalLeases', () => {
  it('drops a lease whose run ended, and keeps run-less ones until released', async () => {
    const local = new LocalLeases();
    local.add({ name: 'a', holder: 'h1', runId: 'r1' });
    local.add({ name: 'b', holder: 'h2' });
    await local.prune(() => false);
    expect(local.list()).toEqual([{ name: 'b', holder: 'h2' }]);
    local.remove({ name: 'b', holder: 'h2' });
    expect(local.list()).toEqual([]);
  });
});

describe('fleet listener leases', () => {
  const token = 'a'.repeat(32);
  const call = (app: ReturnType<typeof createFleetApp>, path: string, body?: unknown) =>
    app.request(`/api/v1/fleet/leases${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it('acquires, refuses, lists, renews and releases', async () => {
    const app = createFleetApp(new FleetHub(), token);
    const ref = { name: 'real-db', holder: 'r1' };
    expect(await (await call(app, '/acquire', { ...ref, nodeId: 'n1' })).json()).toMatchObject({ acquired: true });
    expect(await (await call(app, '/acquire', { name: 'real-db', holder: 'r2', nodeId: 'n2' })).json()).toMatchObject({ acquired: false });
    expect((await (await call(app, '')).json() as { leases: unknown[] }).leases).toHaveLength(1);
    expect((await call(app, '/renew', ref)).status).toBe(200);
    expect((await call(app, '/renew', { name: 'nope', holder: 'x' })).status).toBe(404);
    expect(await (await call(app, '/release', ref)).json()).toEqual({ released: true });
    expect(await (await call(app, '/release', ref)).json()).toEqual({ released: false });
  });

  it('rejects odd names and needs the token', async () => {
    const app = createFleetApp(new FleetHub(), token);
    expect((await call(app, '/acquire', { name: '../x', holder: 'r', nodeId: 'n' })).status).toBe(400);
    expect((await app.request('/api/v1/fleet/leases')).status).toBe(401);
  });
});
