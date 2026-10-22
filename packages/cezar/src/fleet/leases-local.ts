import type { FleetLeaseRef } from '@open-mercato/cezar-contract';

/**
 * The leases THIS node stands behind (spec 2026-10-22-fleet-leases). The heartbeat names exactly
 * these, which renews them at the hub; one whose run has ended is dropped here, and the hub frees it
 * on the next heartbeat — so a task that crashed without `cez lease release` cannot hold a lock.
 */
export interface LocalLease extends FleetLeaseRef {
  /** The run that took it, when the caller was a run: its end ends the lease. */
  runId?: string;
  projectId?: string;
}

export class LocalLeases {
  private readonly held = new Map<string, LocalLease>();

  private static key(ref: FleetLeaseRef): string {
    return `${ref.name}\n${ref.holder}`;
  }

  add(lease: LocalLease): void {
    this.held.set(LocalLeases.key(lease), lease);
  }

  remove(ref: FleetLeaseRef): void {
    this.held.delete(LocalLeases.key(ref));
  }

  list(): FleetLeaseRef[] {
    return [...this.held.values()].map(({ name, holder }) => ({ name, holder }));
  }

  /** Forget leases whose run is over. `alive` answers for a run; a lease with no run is kept until released. */
  async prune(alive: (lease: LocalLease) => boolean | Promise<boolean>): Promise<void> {
    for (const lease of [...this.held.values()]) {
      if (!lease.runId) continue;
      if (!(await alive(lease))) this.remove(lease);
    }
  }
}
