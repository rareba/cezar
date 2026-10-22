import { describe, expect, it } from 'vitest';
import type { FleetHeartbeat, FleetJob, FleetMailSubmit } from '@open-mercato/cezar-contract';
import { FleetHub } from './hub.ts';
import { MAIL_TTL_MS, MailTable, NodeMailbox } from './mailbox.ts';

const T0 = Date.parse('2026-10-22T12:00:00Z');
const mail = (id: string, to: FleetMailSubmit['to'], over: Partial<FleetMailSubmit> = {}): FleetMailSubmit => ({
  id: `mail-${id}000`, to, from: { nodeId: 'n1', runId: 'child' }, kind: 'message', subject: 's', body: 'hello', ...over,
});
const jobs = (...list: Array<Partial<FleetJob> & { id: string }>) =>
  new Map(list.map((j) => [j.id, { repoUrl: 'a/b', task: 't', openPr: true, status: 'running', attempts: 0, createdAt: '', updatedAt: '', ...j } as FleetJob]));

describe('MailTable', () => {
  it('addresses mail by run and node, and holds it for that node only until acked', () => {
    const t = new MailTable([], () => T0);
    t.accept(mail('1', { runId: 'r1', nodeId: 'n2' }), jobs());
    expect(t.forNode('n3')).toEqual([]);
    expect(t.forNode('n2')).toHaveLength(1);
    t.ack('n3', ['mail-1000']); // not the addressee
    expect(t.forNode('n2')).toHaveLength(1);
    t.ack('n2', ['mail-1000']);
    expect(t.forNode('n2')).toEqual([]);
  });

  it('is idempotent by id, even after the ack', () => {
    const t = new MailTable([], () => T0);
    const m = mail('1', { runId: 'r1', nodeId: 'n2' });
    t.accept(m, jobs());
    t.ack('n2', [m.id]);
    t.accept(m, jobs());
    expect(t.list()).toEqual([]);
  });

  it('resolves a job id to its node and run once the job has reported a run', () => {
    const t = new MailTable([], () => T0);
    t.accept(mail('1', { jobId: 'j1' }), jobs({ id: 'j1', status: 'assigned', nodeId: 'n2' }));
    expect(t.list()).toEqual([]); // no run yet: waits
    t.resolve(jobs({ id: 'j1', nodeId: 'n2', runId: 'r9' }));
    expect(t.forNode('n2')[0]?.to).toMatchObject({ runId: 'r9', nodeId: 'n2' });
  });

  it('finds the node of a bare run id through its job', () => {
    const t = new MailTable([], () => T0);
    t.accept(mail('1', { runId: 'r9' }), jobs({ id: 'j1', nodeId: 'n2', runId: 'r9' }));
    expect(t.forNode('n2')).toHaveLength(1);
  });

  it('drops mail nobody collected within the TTL', () => {
    const clock = { now: T0 };
    const t = new MailTable([], () => clock.now);
    t.accept(mail('1', { runId: 'r1', nodeId: 'n2' }), jobs());
    t.accept(mail('2', { jobId: 'never' }), jobs());
    clock.now += MAIL_TTL_MS + 1;
    t.resolve(jobs());
    expect(t.list()).toEqual([]);
  });
});

describe('NodeMailbox', () => {
  it('keeps the outbox until a heartbeat got through', () => {
    const box = new NodeMailbox(() => 'n1');
    box.send({ to: { runId: 'r1', nodeId: 'n2' }, kind: 'message', subject: 's', body: 'b' });
    const first = box.peekOutbox();
    expect(first).toHaveLength(1);
    expect(box.peekOutbox()).toEqual(first); // failed heartbeat: resent
    box.sent(first, []);
    expect(box.peekOutbox()).toEqual([]);
  });

  it('delivers once per id, acknowledges, and retries what threw', async () => {
    const box = new NodeMailbox(() => 'n1');
    const m = { ...mail('1', { runId: 'r1', nodeId: 'n1' }), to: { runId: 'r1', nodeId: 'n1' }, createdAt: '' };
    const seen: string[] = [];
    let fail = true;
    await box.receive([m], async (x) => { if (fail) throw new Error('busy'); seen.push(x.id); });
    expect(box.peekAcks()).toEqual([]);
    fail = false;
    await box.receive([m], async (x) => { seen.push(x.id); });
    await box.receive([m], async (x) => { seen.push(x.id); }); // hub redelivered before it saw the ack
    expect(seen).toEqual([m.id]);
    expect(box.peekAcks()).toEqual([m.id]);
    box.sent([], [m.id]);
    expect(box.peekAcks()).toEqual([]);
  });
});

describe('mail through the hub heartbeat', () => {
  const beat = (nodeId: string, over: Partial<FleetHeartbeat> = {}): FleetHeartbeat => ({
    nodeId, version: '1', capacity: { free: 1, max: 1 }, host: {}, jobs: [], ...over,
  });

  it('carries mail from one node to another and forgets it once acked', () => {
    const hub = new FleetHub({ now: () => T0 });
    const m = mail('1', { runId: 'r1', nodeId: 'b' }, { from: { nodeId: 'a' } });
    expect(hub.heartbeat(beat('a', { outbox: [m] })).mail).toBeUndefined();
    const delivered = hub.heartbeat(beat('b'));
    expect(delivered.mail?.map((x) => x.id)).toEqual([m.id]);
    expect(hub.heartbeat(beat('b')).mail).toHaveLength(1); // not acked: again
    expect(hub.heartbeat(beat('b', { mailAck: [m.id] })).mail).toBeUndefined();
  });

  it('delivers to a sender\'s own node in the same heartbeat', () => {
    const hub = new FleetHub({ now: () => T0 });
    const m = mail('1', { runId: 'r1', nodeId: 'a' }, { from: { nodeId: 'a' } });
    expect(hub.heartbeat(beat('a', { outbox: [m] })).mail).toHaveLength(1);
  });

  it('addresses a child by job id once the child has reported its run', () => {
    const hub = new FleetHub({ now: () => T0, newId: () => 'job-1' });
    hub.submit({ repoUrl: 'a/b', task: 't' });
    hub.heartbeat(beat('w'));
    hub.heartbeat(beat('w', { jobs: [{ id: 'job-1', status: 'running', runId: 'run-w' }] }));
    const res = hub.heartbeat(beat('p', { outbox: [mail('1', { jobId: 'job-1' }, { from: { nodeId: 'p' } })] }));
    expect(res.mail).toBeUndefined();
    expect(hub.heartbeat(beat('w')).mail?.[0]?.to).toMatchObject({ runId: 'run-w', nodeId: 'w' });
  });

  it('persists undelivered mail', () => {
    const saved: unknown[] = [];
    const hub = new FleetHub({ now: () => T0, persistMail: (all) => saved.push(all) });
    hub.heartbeat(beat('a', { outbox: [mail('1', { runId: 'r1', nodeId: 'b' })] }));
    expect(saved).toHaveLength(1);
  });
});
