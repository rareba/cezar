import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetHub } from '../fleet/hub.ts';
import { runLeaseCommand, type LeaseCliIo } from '../fleet/lease-cli.ts';
import { LocalLeases } from '../fleet/leases-local.ts';
import { hubView, setFleetView } from '../fleet/view.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/** `cez lease` against a real cockpit app whose fleet view is a hub (spec 2026-10-22-fleet-leases). */
describe('cez lease through the cockpit', () => {
  let repoRoot: string;
  let store: RunStore;
  const app = () => createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-lease-api-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
  });
  afterEach(() => {
    setFleetView(undefined);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const out: string[] = [];
  const execs: string[][] = [];
  const io = (): LeaseCliIo => ({
    fetch: ((url: string, init?: RequestInit) => apiRequest(app(), new URL(url).pathname, init)) as unknown as typeof fetch,
    log: (l) => out.push(l),
    error: (l) => out.push(`ERR ${l}`),
    sleep: async () => {},
    exec: async (cmd, args) => {
      execs.push([cmd, ...args]);
      return 7;
    },
  });
  const env = { CEZ_API_URL: 'http://cockpit', CEZ_TASK_ID: 'run-1' };
  const lease = (args: string[], over: Record<string, string> = {}) => runLeaseCommand(args, { ...env, ...over }, io());

  beforeEach(() => {
    out.length = 0;
    execs.length = 0;
  });

  it('exits 2 when this cezar has no fleet role, and carries on with --if-fleet', async () => {
    expect(await lease(['acquire', 'issue-1'])).toBe(2);
    expect(out.join('\n')).toContain('fleet is not enabled');
    expect(await lease(['acquire', 'issue-1', '--if-fleet'])).toBe(0);
    expect(await lease(['run', 'issue-1', '--if-fleet', '--', 'echo', 'hi'])).toBe(7);
    expect(execs).toEqual([['echo', 'hi']]);
  });

  it('refuses a second holder, lets it in after release, and registers the lease for the heartbeat', async () => {
    const hub = new FleetHub();
    const local = new LocalLeases();
    setFleetView(hubView(hub, 'hub', local));
    expect(await lease(['acquire', 'issue-1'])).toBe(0);
    expect(local.list()).toEqual([{ name: 'issue-1', holder: 'run-1' }]);
    expect(await lease(['acquire', 'issue-1'], { CEZ_TASK_ID: 'run-2' })).toBe(1);
    expect(out.join('\n')).toContain('held by run-1@hub');
    expect(await lease(['release', 'issue-1'])).toBe(0);
    expect(local.list()).toEqual([]);
    expect(await lease(['acquire', 'issue-1'], { CEZ_TASK_ID: 'run-2' })).toBe(0);
    out.length = 0;
    expect(await lease(['list'])).toBe(0);
    expect(out[0]).toContain('issue-1  run-2  @hub');
  });

  it('run holds the lease for the command, releases it after, and exits with its code', async () => {
    const hub = new FleetHub();
    setFleetView(hubView(hub, 'hub'));
    expect(await lease(['run', 'real-db', '--', 'npm', 'test'])).toBe(7);
    expect(execs).toEqual([['npm', 'test']]);
    expect(hub.listLeases()).toEqual([]);
  });

  it('--wait keeps trying until the holder lets go', async () => {
    const hub = new FleetHub();
    setFleetView(hubView(hub, 'hub'));
    hub.acquireLease({ name: 'real-db', holder: 'other', nodeId: 'n2' });
    let polls = 0;
    const waiting: LeaseCliIo = {
      ...io(),
      sleep: async () => {
        if (++polls === 2) hub.releaseLease('real-db', 'other');
      },
    };
    expect(await runLeaseCommand(['acquire', 'real-db', '--wait', '30'], env, waiting)).toBe(0);
    expect(polls).toBe(2);
  });
});
