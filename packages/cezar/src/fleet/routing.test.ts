import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat, FleetJob, FleetNode } from '@open-mercato/cezar-contract';
import { fleetMetricsSchema } from '@open-mercato/cezar-contract';
import { FleetHub } from './hub.ts';
import { runFleetCommand } from './fleet-cli.ts';
import { fleetMetrics, prometheusText } from './metrics.ts';
import { nodeTags } from './index.ts';
import { planAssignments } from './scheduler.ts';
import { createFleetApp } from './server.ts';

const NOW = Date.parse('2026-10-22T12:00:00Z');
const at = (ms: number) => new Date(ms).toISOString();
const job = (id: string, over: Partial<FleetJob> = {}): FleetJob => ({
  id, repoUrl: 'a/b', task: 't', openPr: true, status: 'pending', attempts: 0, createdAt: at(NOW - 1000 + Number(id.replace(/\D/g, ''))), updatedAt: at(NOW), ...over,
});
const node = (nodeId: string, free: number, over: Partial<FleetNode> = {}): FleetNode => ({
  nodeId, lastSeen: at(NOW - 1000), capacity: { free, max: 4 }, host: {}, version: '1', ...over,
});

describe('capability routing', () => {
  it('assigns a job only to a node advertising every tag it requires', () => {
    const plan = planAssignments([job('j1', { requires: ['docker', 'gpu'] })], [node('a', 4, { tags: ['docker'] }), node('b', 1, { tags: ['gpu', 'docker'] })], NOW);
    expect(plan.get('j1')).toBe('b');
  });

  it('leaves a job nobody can take pending without blocking later jobs', () => {
    const plan = planAssignments([job('j1', { requires: ['android'] }), job('j2')], [node('a', 2, { tags: ['docker'] })], NOW);
    expect(plan.has('j1')).toBe(false);
    expect(plan.get('j2')).toBe('a');
  });

  it('never hands work to a draining node', () => {
    expect(planAssignments([job('j1')], [node('a', 4, { draining: true })], NOW).size).toBe(0);
  });

  it('a tagged node still takes untagged work', () => {
    expect(planAssignments([job('j1')], [node('a', 1, { tags: ['gpu'] })], NOW).get('j1')).toBe('a');
  });
});

const beat = (nodeId: string, over: Partial<FleetHeartbeat> = {}): FleetHeartbeat => ({
  nodeId, version: '1', capacity: { free: 2, max: 2 }, host: {}, jobs: [], ...over,
});

describe('FleetHub drain and tags', () => {
  it('records node tags and routes by them through the heartbeat', () => {
    const hub = new FleetHub({ now: () => NOW });
    hub.submit({ repoUrl: 'a/b', task: 't', requires: ['docker'] });
    expect(hub.heartbeat(beat('plain', { tags: ['linux'] })).assigned).toEqual([]);
    expect(hub.heartbeat(beat('dock', { tags: ['docker', 'linux'] })).assigned).toHaveLength(1);
    expect(hub.status().nodes.find((n) => n.nodeId === 'dock')?.tags).toEqual(['docker', 'linux']);
  });

  it('stops assigning to a drained node, keeps its running job, and resumes on undrain', () => {
    const saved: string[][] = [];
    const hub = new FleetHub({ now: () => NOW, persistDrained: (n) => saved.push(n) });
    hub.submit({ repoUrl: 'a/b', task: 't1' });
    const first = hub.heartbeat(beat('n1'));
    expect(first.assigned).toHaveLength(1);
    hub.setDrain('n1', true);
    hub.submit({ repoUrl: 'a/b', task: 't2' });
    const id = first.assigned[0]!.id;
    const during = hub.heartbeat(beat('n1', { jobs: [{ id, status: 'running' }] }));
    expect(during.assigned).toEqual([]);
    expect(hub.getJob(id)?.status).toBe('running');
    expect(hub.status().nodes[0]?.draining).toBe(true);
    hub.setDrain('n1', false);
    expect(hub.heartbeat(beat('n1', { jobs: [{ id, status: 'running' }] })).assigned).toHaveLength(1);
    expect(saved).toEqual([['n1'], []]);
  });

  it('a drain survives a hub restart', () => {
    const hub = new FleetHub({ now: () => NOW, initialDrained: ['n1'] });
    hub.submit({ repoUrl: 'a/b', task: 't' });
    expect(hub.heartbeat(beat('n1')).assigned).toEqual([]);
  });
});

describe('metrics', () => {
  const nodes = [
    node('gen', 3, { tags: ['linux'] }),
    node('dock', 1, { tags: ['docker', 'linux'], capacity: { free: 1, max: 2 } }),
    node('drained', 4, { tags: ['docker'], draining: true }),
    node('dead', 4, { lastSeen: at(NOW - 120_000), tags: ['docker'] }),
  ];
  const jobs = [
    job('j1', { requires: ['docker'] }), job('j2', { requires: ['android'] }), job('j3'),
    job('j4', { status: 'running', nodeId: 'dock' }),
  ];

  it('reports pending jobs and free slots per pool, counting only live non-draining nodes as slots', () => {
    const m = fleetMetrics(jobs, nodes, NOW);
    expect(fleetMetricsSchema.parse(m)).toBeTruthy();
    const pool = (name: string) => m.pools.find((p) => p.pool === name);
    expect(pool('any')).toMatchObject({ pending: 3, running: 1, nodes: 2, freeSlots: 4 });
    expect(pool('docker')).toMatchObject({ pending: 1, running: 1, nodes: 1, freeSlots: 1, maxSlots: 2 });
    expect(pool('android')).toMatchObject({ pending: 1, nodes: 0, freeSlots: 0 }); // a scaler can start the first one
    expect(m.nodes).toEqual({ total: 4, live: 3, draining: 1 });
    expect(m.nodeList.find((n) => n.nodeId === 'dock')).toMatchObject({ running: 1, live: true, draining: false });
    expect(m.nodeList.find((n) => n.nodeId === 'dead')).toMatchObject({ live: false, freeSlots: 0 });
  });

  it('renders Prometheus text', () => {
    const text = prometheusText(fleetMetrics(jobs, nodes, NOW));
    expect(text).toContain('# TYPE cezar_fleet_pending_jobs gauge');
    expect(text).toContain('cezar_fleet_pending_jobs{pool="docker"} 1');
    expect(text).toContain('cezar_fleet_nodes{state="draining"} 1');
  });
});

describe('listener and CLI', () => {
  const token = 'a'.repeat(32);
  it('serves metrics (JSON and Prometheus) and drains a node, behind the token', async () => {
    const hub = new FleetHub();
    hub.heartbeat(beat('n1', { tags: ['docker'] }));
    const app = createFleetApp(hub, token);
    const h = { authorization: `Bearer ${token}` };
    expect(await (await app.request('/api/v1/fleet/metrics', { headers: h })).json()).toMatchObject({ nodes: { total: 1 } });
    expect(await (await app.request('/api/v1/fleet/metrics?format=prometheus', { headers: h })).text()).toContain('cezar_fleet_free_slots{pool="docker"} 2');
    const drain = await app.request('/api/v1/fleet/nodes/n1/drain', { method: 'POST', headers: { ...h, 'content-type': 'application/json' }, body: JSON.stringify({ drain: true }) });
    expect(await drain.json()).toEqual({ nodeId: 'n1', draining: true });
    expect(hub.metrics().nodes.draining).toBe(1);
    expect((await app.request('/api/v1/fleet/metrics')).status).toBe(401);
  });

  it('cezar fleet drain, metrics and submit --requires call the hub', async () => {
    const hub = new FleetHub();
    hub.heartbeat(beat('n1'));
    const app = createFleetApp(hub, token);
    const out: string[] = [];
    const io = {
      fetch: ((url: string, init?: RequestInit) => app.request(new URL(url).pathname + new URL(url).search, init)) as unknown as typeof fetch,
      log: (l: string) => out.push(l),
      error: (l: string) => out.push(`ERR ${l}`),
    };
    const env = { CEZ_FLEET_HUB_URL: 'http://hub', CEZ_FLEET_TOKEN: token };
    expect(await runFleetCommand(['drain', 'n1'], env, io)).toBe(0);
    expect(hub.status().nodes[0]?.draining).toBe(true);
    expect(await runFleetCommand(['drain', 'n1', '--undo'], env, io)).toBe(0);
    expect(await runFleetCommand(['submit', 'do it', '--repo', 'a/b', '--requires', 'Docker, gpu'], env, io)).toBe(0);
    expect(hub.status().jobs[0]?.requires).toEqual(['docker', 'gpu']);
    out.length = 0;
    expect(await runFleetCommand(['metrics'], env, io)).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ pools: expect.any(Array) });
    out.length = 0;
    expect(await runFleetCommand(['metrics', '--prometheus'], env, io)).toBe(0);
    expect(out[0]).toContain('# HELP');
  });
});

describe('nodeTags', () => {
  it('adds the platform to the configured tags', () => {
    expect(nodeTags(['docker'])).toContain('docker');
    expect(nodeTags([]).length).toBe(1);
  });
});
