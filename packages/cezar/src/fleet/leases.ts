import type { FleetLease, FleetLeaseAcquire, FleetLeaseAcquireResponse, FleetLeaseRef } from '@open-mercato/cezar-contract';
import { LEASE_MS, NODE_TTL_MS } from './scheduler.ts';

/**
 * The hub's lease table (spec 2026-10-22-fleet-leases): named claims with an expiry. A node's
 * heartbeat names the leases it still holds and that renews them; a node that stops heartbeating
 * stops renewing, so what it held frees itself. `limit` > 1 turns a name into a counting semaphore.
 */

const iso = (ms: number): string => new Date(ms).toISOString();

export class LeaseTable {
  private readonly byName = new Map<string, FleetLease[]>();

  constructor(
    initial: readonly FleetLease[] = [],
    private readonly now: () => number = Date.now,
    private readonly onChange: (leases: FleetLease[]) => void = () => {},
  ) {
    for (const lease of initial) {
      // After a hub restart nobody has heartbeated yet: give each holder a full lease to do so.
      this.add({ ...lease, expiresAt: iso(this.now() + LEASE_MS) });
    }
  }

  private add(lease: FleetLease): void {
    this.byName.set(lease.name, [...(this.byName.get(lease.name) ?? []), lease]);
  }

  private holders(name: string): FleetLease[] {
    return this.byName.get(name) ?? [];
  }

  private replace(name: string, leases: FleetLease[]): void {
    if (leases.length === 0) this.byName.delete(name);
    else this.byName.set(name, leases);
  }

  list(): FleetLease[] {
    return [...this.byName.values()].flat().sort((a, b) => a.name.localeCompare(b.name) || a.acquiredAt.localeCompare(b.acquiredAt));
  }

  /** Idempotent per (name, holder): asking again renews. Refused when `limit` other holders are in. */
  acquire(input: FleetLeaseAcquire): FleetLeaseAcquireResponse {
    this.sweep();
    const now = this.now();
    const current = this.holders(input.name);
    const mine = current.find((l) => l.holder === input.holder);
    if (mine) {
      const renewed = { ...mine, nodeId: input.nodeId, expiresAt: iso(now + LEASE_MS) };
      this.replace(input.name, current.map((l) => (l === mine ? renewed : l)));
      return { acquired: true, lease: renewed, holders: this.holders(input.name) };
    }
    if (current.length >= (input.limit ?? 1)) return { acquired: false, holders: current };
    const lease: FleetLease = {
      name: input.name,
      holder: input.holder,
      nodeId: input.nodeId,
      ...(input.runId ? { runId: input.runId } : {}),
      acquiredAt: iso(now),
      expiresAt: iso(now + LEASE_MS),
    };
    this.add(lease);
    this.changed();
    return { acquired: true, lease, holders: this.holders(input.name) };
  }

  renew(name: string, holder: string): FleetLease | undefined {
    const current = this.holders(name);
    const mine = current.find((l) => l.holder === holder);
    if (!mine || Date.parse(mine.expiresAt) <= this.now()) return undefined;
    const renewed = { ...mine, expiresAt: iso(this.now() + LEASE_MS) };
    this.replace(name, current.map((l) => (l === mine ? renewed : l)));
    return renewed;
  }

  release(name: string, holder: string): boolean {
    const current = this.holders(name);
    const rest = current.filter((l) => l.holder !== holder);
    if (rest.length === current.length) return false;
    this.replace(name, rest);
    this.changed();
    return true;
  }

  /** Drop expired leases. */
  sweep(): boolean {
    const now = this.now();
    let changed = false;
    for (const [name, leases] of [...this.byName]) {
      const live = leases.filter((l) => Date.parse(l.expiresAt) > now);
      if (live.length === leases.length) continue;
      this.replace(name, live);
      changed = true;
    }
    if (changed) this.changed();
    return changed;
  }

  /**
   * A node's heartbeat: renew what it names, and free what it owns but no longer names. A lease
   * younger than a node TTL is spared so one acquired while the heartbeat was in flight survives.
   */
  syncNode(nodeId: string, held: readonly FleetLeaseRef[]): void {
    const now = this.now();
    const named = new Set(held.map((r) => `${r.name}\n${r.holder}`));
    let changed = false;
    for (const [name, leases] of [...this.byName]) {
      const next: FleetLease[] = [];
      for (const lease of leases) {
        if (lease.nodeId !== nodeId) next.push(lease);
        else if (named.has(`${lease.name}\n${lease.holder}`)) next.push({ ...lease, expiresAt: iso(now + LEASE_MS) });
        else if (now - Date.parse(lease.acquiredAt) < NODE_TTL_MS) next.push(lease);
        else changed = true;
      }
      this.replace(name, next);
    }
    if (changed) this.changed();
  }

  private changed(): void {
    this.onChange(this.list());
  }
}
