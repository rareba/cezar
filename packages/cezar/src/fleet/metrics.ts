import type { FleetJob, FleetMetrics, FleetNode, FleetPoolMetrics } from '@open-mercato/cezar-contract';
import { NODE_TTL_MS, isHeld } from './scheduler.ts';

/**
 * What the hub tells an autoscaler (spec 2026-10-22-fleet-routing). Pure: jobs, nodes and the clock
 * in, numbers out. `any` is the whole fleet; every tag is its own pool.
 */
export function fleetMetrics(jobs: readonly FleetJob[], nodes: readonly FleetNode[], now: number): FleetMetrics {
  const live = (n: FleetNode): boolean => now - Date.parse(n.lastSeen) <= NODE_TTL_MS;
  const running = new Map<string, number>();
  for (const job of jobs) if (isHeld(job) && job.nodeId) running.set(job.nodeId, (running.get(job.nodeId) ?? 0) + 1);
  const pending = jobs.filter((j) => j.status === 'pending');

  const tags = new Set<string>();
  for (const n of nodes) for (const t of n.tags ?? []) tags.add(t);
  for (const j of pending) for (const t of j.requires ?? []) tags.add(t);

  const pool = (name: string, member: (n: FleetNode) => boolean, wants: (j: FleetJob) => boolean): FleetPoolMetrics => {
    // Slots count only nodes that can take a new job; running counts everything the pool's nodes hold.
    const takers = nodes.filter((n) => member(n) && live(n) && !n.draining);
    return {
      pool: name,
      pending: pending.filter(wants).length,
      running: nodes.filter(member).reduce((sum, n) => sum + (running.get(n.nodeId) ?? 0), 0),
      nodes: takers.length,
      freeSlots: takers.reduce((sum, n) => sum + n.capacity.free, 0),
      maxSlots: takers.reduce((sum, n) => sum + n.capacity.max, 0),
    };
  };

  return {
    at: new Date(now).toISOString(),
    nodes: { total: nodes.length, live: nodes.filter(live).length, draining: nodes.filter((n) => n.draining).length },
    pools: [
      pool('any', () => true, () => true),
      ...[...tags].sort().map((tag) => pool(tag, (n) => (n.tags ?? []).includes(tag), (j) => (j.requires ?? []).includes(tag))),
    ],
    nodeList: [...nodes]
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
      .map((n) => ({
        nodeId: n.nodeId,
        live: live(n),
        draining: Boolean(n.draining),
        tags: n.tags ?? [],
        running: running.get(n.nodeId) ?? 0,
        freeSlots: live(n) ? n.capacity.free : 0,
        maxSlots: n.capacity.max,
      })),
  };
}

/** The same numbers in Prometheus text exposition format (`?format=prometheus`). */
export function prometheusText(m: FleetMetrics): string {
  const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const lines: string[] = [];
  const family = (name: string, help: string, rows: Array<[string, number]>): void => {
    lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
    for (const [labels, value] of rows) lines.push(`${name}${labels} ${value}`);
  };
  const byPool = (pick: (p: FleetMetrics['pools'][number]) => number): Array<[string, number]> =>
    m.pools.map((p) => [`{pool="${esc(p.pool)}"}`, pick(p)]);
  family('cezar_fleet_pending_jobs', 'Jobs waiting for a node, per pool.', byPool((p) => p.pending));
  family('cezar_fleet_running_jobs', 'Jobs held by the pool\'s nodes.', byPool((p) => p.running));
  family('cezar_fleet_free_slots', 'Free job slots on live, non-draining nodes of the pool.', byPool((p) => p.freeSlots));
  family('cezar_fleet_max_slots', 'Job slots on live, non-draining nodes of the pool.', byPool((p) => p.maxSlots));
  family('cezar_fleet_pool_nodes', 'Live, non-draining nodes in the pool.', byPool((p) => p.nodes));
  family('cezar_fleet_nodes', 'Nodes by state.', [
    ['{state="total"}', m.nodes.total],
    ['{state="live"}', m.nodes.live],
    ['{state="draining"}', m.nodes.draining],
  ]);
  return `${lines.join('\n')}\n`;
}
