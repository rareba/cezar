import {
  fleetJobSchema,
  fleetLeaseAcquireResponseSchema,
  fleetLeaseListResponseSchema,
  fleetLeaseReleaseResponseSchema,
  fleetLeaseSchema,
  fleetStatusResponseSchema,
  type FleetJob,
  type FleetLease,
  type FleetLeaseAcquireInput,
  type FleetLeaseAcquireResponse,
  type FleetLeaseRef,
  type FleetStatusResponse,
} from '@open-mercato/cezar-contract';
import type { FleetHub } from './hub.ts';
import { LocalLeases } from './leases-local.ts';

/**
 * What the cockpit's Fleet panel reads (spec 2026-10-21-fleet-coordination): the hub's state,
 * directly on a hub and over the token-guarded listener on a worker. The cockpit server holds the
 * token; the browser only ever sees the result. `startFleet` registers the view, so a cezar with no
 * fleet role has none and the panel stays hidden.
 */
export interface FleetView {
  role: 'hub' | 'worker';
  nodeId: string;
  status(): Promise<FleetStatusResponse>;
  /** `undefined` when the hub does not know the job. */
  cancel(jobId: string): Promise<FleetJob | undefined>;
  /** Leases (spec 2026-10-22-fleet-leases): taken in this node's name and kept alive by its heartbeat. */
  acquireLease(input: FleetLeaseAcquireInput): Promise<FleetLeaseAcquireResponse>;
  renewLease(ref: FleetLeaseRef): Promise<FleetLease | undefined>;
  releaseLease(ref: FleetLeaseRef): Promise<boolean>;
  listLeases(): Promise<FleetLease[]>;
}

let current: FleetView | undefined;

export const getFleetView = (): FleetView | undefined => current;
export const setFleetView = (view: FleetView | undefined): void => {
  current = view;
};

export function hubView(hub: FleetHub, nodeId: string, local: LocalLeases = new LocalLeases()): FleetView {
  return {
    role: 'hub',
    nodeId,
    status: async () => hub.status(),
    cancel: async (id) => hub.cancel(id),
    async acquireLease({ projectId, ...input }) {
      const result = hub.acquireLease({ ...input, nodeId });
      if (result.acquired) local.add({ name: input.name, holder: input.holder, runId: input.runId, projectId });
      return result;
    },
    async renewLease({ name, holder }) {
      return hub.renewLease(name, holder);
    },
    async releaseLease(ref) {
      local.remove(ref);
      return hub.releaseLease(ref.name, ref.holder);
    },
    async listLeases() {
      return hub.listLeases();
    },
  };
}

const TIMEOUT_MS = 10_000;

export function remoteView(hubUrl: string, token: string, nodeId: string, fetchImpl: typeof fetch = fetch, local: LocalLeases = new LocalLeases()): FleetView {
  const call = (path: string, init: RequestInit = {}) =>
    fetchImpl(`${hubUrl}/api/v1/fleet${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  return {
    role: 'worker',
    nodeId,
    async status() {
      const res = await call('/status');
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetStatusResponseSchema.parse(await res.json());
    },
    async cancel(id) {
      const res = await call(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetJobSchema.parse(await res.json());
    },
    async acquireLease({ projectId, ...input }) {
      const res = await call('/leases/acquire', post({ ...input, nodeId }));
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      const result = fleetLeaseAcquireResponseSchema.parse(await res.json());
      if (result.acquired) local.add({ name: input.name, holder: input.holder, runId: input.runId, projectId });
      return result;
    },
    async renewLease(ref) {
      const res = await call('/leases/renew', post(ref));
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetLeaseSchema.parse(await res.json());
    },
    async releaseLease(ref) {
      local.remove(ref);
      const res = await call('/leases/release', post(ref));
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetLeaseReleaseResponseSchema.parse(await res.json()).released;
    },
    async listLeases() {
      const res = await call('/leases');
      if (!res.ok) throw new Error(`hub answered ${res.status}`);
      return fleetLeaseListResponseSchema.parse(await res.json()).leases;
    },
  };
}

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
