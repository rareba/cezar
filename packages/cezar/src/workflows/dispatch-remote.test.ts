import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetSubmit } from '@open-mercato/cezar-contract';
import { RunStore } from '../runs/store.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';

const run = promisify(execFile);
const ONE_STEP: WorkflowDef = { name: '(planned)', source: 'built-in', steps: [{ id: 'task', name: 'Task', prompt: '{{task}}' }] };

/** Cross-node sub-tasks (spec 2026-10-22-fleet-subtasks): the manager half, against the dry-run mock. */
describe('dispatchRemote', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const saved = { dry: process.env.CEZ_DRY_RUN, dispatch: process.env.CEZ_DISPATCH };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-dispatch-remote-'));
    process.env.CEZ_DRY_RUN = '1';
    process.env.CEZ_DISPATCH = '1';
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = new RunManager(store, repoRoot, { semaphore: new WorkspaceSemaphore({}), projectId: 'proj-1' });
  });
  afterEach(async () => {
    for (const r of store.listRuns()) manager.cancel(r.id);
    while (store.listRuns().some(({ id }) => manager.isActive(id))) await new Promise((r) => setTimeout(r, 25));
    manager.dispose();
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_DISPATCH', saved.dispatch]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  const remote = (over: Partial<Parameters<RunManager['dispatchRemote']>[2]> = {}) => {
    const submitted: FleetSubmit[] = [];
    return {
      submitted,
      args: { nodeId: 'node-a', repoUrl: 'https://github.com/a/b', inFlight: 0, submit: async (job: FleetSubmit) => (submitted.push(job), { id: 'job-9' }), ...over },
    };
  };

  it('sends the child to the hub carrying its parent, and makes the parent a root', async () => {
    const parent = manager.startRun(ONE_STEP, { task: 'parent', autonomous: true });
    const r = remote({ parentJobId: 'job-parent' });
    const out = await manager.dispatchRemote(parent.id, { objective: 'do the thing', kind: 'review' }, r.args);
    expect(out).toEqual({ id: 'job-9' });
    expect(r.submitted).toHaveLength(1);
    expect(r.submitted[0]).toMatchObject({
      repoUrl: 'https://github.com/a/b',
      kind: 'review',
      openPr: true,
      parent: { nodeId: 'node-a', runId: parent.id, rootRunId: parent.id, jobId: 'job-parent', projectId: 'proj-1' },
    });
    expect(r.submitted[0]?.task).toContain('do the thing');
    expect(r.submitted[0]?.task).toContain(`Ordered by: run ${parent.id}`);
    expect(store.getRun(parent.id)?.dispatch?.rootRunId).toBe(parent.id);
    // no local child was started
    expect(store.listRuns()).toHaveLength(1);
  });

  it('counts the parent\'s fleet children against the in-flight cap', async () => {
    const parent = manager.startRun(ONE_STEP, { task: 'parent', autonomous: true });
    const r = remote({ inFlight: 4 });
    const out = await manager.dispatchRemote(parent.id, { objective: 'one more' }, r.args);
    expect(out).toMatchObject({ refused: expect.stringContaining('already in flight') });
    expect(r.submitted).toHaveLength(0);
  });

  it('answers a hub failure with a refusal that names --local', async () => {
    const parent = manager.startRun(ONE_STEP, { task: 'parent', autonomous: true });
    const r = remote({ submit: async () => { throw new Error('hub answered 503'); } });
    const out = await manager.dispatchRemote(parent.id, { objective: 'x' }, r.args);
    expect(out).toMatchObject({ refused: expect.stringContaining('--local') });
  });

  it('refuses for a parent that does not exist', async () => {
    const out = await manager.dispatchRemote('nope', { objective: 'x' }, remote().args);
    expect(out).toEqual({ refused: 'no such run: nope' });
  });

  it('a sub-task whose parent runs elsewhere can still record its report', () => {
    const child = manager.startRun(ONE_STEP, {
      task: 'child',
      autonomous: true,
      dispatch: { rootRunId: 'root-elsewhere', parentRunId: 'parent-elsewhere', remoteParent: { nodeId: 'node-a' } },
    });
    expect(manager.recordReport(child.id, { status: 'done', result: 'ok', evidence: [], side_effects: [], errors: [], suggestions: [] })).toBe(true);
    expect(store.getRun(child.id)?.dispatch?.remoteParent).toEqual({ nodeId: 'node-a' });
  });
});
