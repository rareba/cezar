import { fleetHeartbeatResponseSchema, type FleetHeartbeat, type FleetHeartbeatResponse } from '@open-mercato/cezar-contract';
import type { FleetConfig } from './config.ts';
import { FleetHub } from './hub.ts';
import { loadJobs, saveJobs } from './jobs-store.ts';
import { LocalLeases, type LocalLease } from './leases-local.ts';
import { loadLeases, saveLeases } from './leases-store.ts';
import { NodeMailbox } from './mailbox.ts';
import { loadMail, saveMail } from './mail-store.ts';
import { loadDrained, saveDrained } from './drain-store.ts';
import { platform } from 'node:os';
import { createFleetRunHost, type BootProject } from './runs.ts';
import { startFleetServer } from './server.ts';
import { setFleetView, hubView, remoteView } from './view.ts';
import { FleetWorker } from './worker.ts';

/** How often the hub looks for expired leases between heartbeats. */
const SWEEP_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;

/** What `localCapacity` reads from the semaphore. The pool-aware members arrive with the per-pool
 *  limits change; a fleet job is main-pool work, so they win when present. */
export interface CapacitySource {
  maxParallel(): number;
  busy(): number;
  freeCapacity?(): { main: number };
  effectiveLimits?(): { main: number };
}

/** What this node advertises: the configured tags plus its platform (`macos`, `windows`, `linux`). */
export function nodeTags(configured: readonly string[]): string[] {
  const os = platform() === 'darwin' ? 'macos' : platform() === 'win32' ? 'windows' : 'linux';
  return [...new Set([...configured, os])];
}

/** Free slots on this node (works on a semaphore with or without per-pool limits). */
export function localCapacity(semaphore: CapacitySource): { free: number; max: number } {
  const max = semaphore.effectiveLimits?.().main ?? semaphore.maxParallel();
  const free = semaphore.freeCapacity?.().main ?? max - semaphore.busy();
  return { free: Math.max(0, free), max };
}

/** Worker -> hub transport: authenticated JSON over HTTP, response validated at the boundary. */
export function httpTransport(hubUrl: string, token: string, fetchImpl: typeof fetch = fetch) {
  return async (heartbeat: FleetHeartbeat): Promise<FleetHeartbeatResponse> => {
    const response = await fetchImpl(`${hubUrl}/api/v1/fleet/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify(heartbeat),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`hub answered ${response.status}`);
    return fleetHeartbeatResponseSchema.parse(await response.json());
  };
}

export interface StartFleetDeps {
  config: Exclude<FleetConfig, { role: 'off' } | { role: 'invalid' }>;
  version: string;
  semaphore: CapacitySource;
  boot: BootProject;
  context: (projectId: string) => Promise<BootProject>;
  /** Announce a project a fleet job just cloned (the server's `project-added` event). */
  onProjectAdded?: (project: { id: string; root: string }) => void;
  /** Is the run that took a lease still working? Unknown runs count as over; failures as alive. */
  runAlive?: (lease: LocalLease) => boolean | Promise<boolean>;
  log?: (message: string) => void;
}

/** Start this node's fleet role. Returns the stop handle; a hub also starts its fleet listener. */
export function startFleet(deps: StartFleetDeps): { stop(): void } {
  const { config, log = console.log } = deps;
  const stops: Array<() => void> = [];
  let transport: (heartbeat: FleetHeartbeat) => Promise<FleetHeartbeatResponse>;
  const localLeases = new LocalLeases();
  const mailbox = new NodeMailbox(() => config.nodeId);
  if (config.role === 'hub') {
    const hub = new FleetHub({ initialJobs: loadJobs(), persist: saveJobs, initialLeases: loadLeases(), persistLeases: saveLeases, initialMail: loadMail(), persistMail: saveMail, initialDrained: loadDrained(), persistDrained: saveDrained });
    setFleetView(hubView(hub, config.nodeId, localLeases, mailbox));
    const server = startFleetServer(hub, config.token, config.port, config.bind);
    const sweep = setInterval(() => hub.sweep(), SWEEP_MS);
    sweep.unref();
    stops.push(() => {
      clearInterval(sweep);
      server.close();
    });
    // The hub is a node too: same worker loop, heartbeating straight into the hub.
    transport = async (heartbeat) => hub.heartbeat(heartbeat);
    log(`  fleet hub → :${config.port} (${config.bind}) as node ${config.nodeId}`);
  } else {
    transport = httpTransport(config.hubUrl, config.token);
    setFleetView(remoteView(config.hubUrl, config.token, config.nodeId, fetch, localLeases, mailbox));
    log(`  fleet worker → ${config.hubUrl} as node ${config.nodeId}`);
  }
  const host = createFleetRunHost({ boot: deps.boot, context: deps.context, onProjectAdded: deps.onProjectAdded });
  const worker = new FleetWorker({
    nodeId: config.nodeId,
    version: deps.version,
    host,
    transport,
    capacity: () => localCapacity(deps.semaphore),
    mailbox,
    tags: () => nodeTags(config.tags),
    leases: async () => {
      if (deps.runAlive) await localLeases.prune(deps.runAlive);
      return localLeases.list();
    },
    jobTimeoutMs: config.jobTimeoutMs,
    log,
  });
  // Runs this node recovered from its previous life are adopted: the first heartbeat reports them,
  // and the hub either still assigns the job here (it carries on) or answers `drop` (cancelled).
  let stopped = false;
  void host.recover().then(
    (found) => {
      worker.adopt(found);
      if (found.length > 0) log(`  fleet: adopting ${found.length} run(s) from the previous process`);
    },
    () => {},
  ).finally(() => {
    if (!stopped) worker.start();
  });
  stops.push(() => {
    stopped = true;
    worker.stop();
    setFleetView(undefined);
  });
  return { stop: () => stops.forEach((stop) => stop()) };
}
