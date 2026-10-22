/**
 * `cez lease …` — fleet-wide locks for workflows (spec 2026-10-22-fleet-leases): "only one task works
 * issue X", "one real-database test at a time". A thin client over this machine's cockpit
 * (`CEZ_API_URL`, set for every task), which holds the fleet token and takes the lease in its node's
 * name. A lease is renewed by the node's heartbeat and ends with the run that took it.
 */
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import {
  fleetLeaseAcquireResponseSchema,
  fleetLeaseListResponseSchema,
  fleetLeaseNameSchema,
  fleetLeaseReleaseResponseSchema,
  type FleetLease,
} from '@open-mercato/cezar-contract';
import { missingCockpitMessage } from '../cockpit-address.ts';

export interface LeaseCliEnv {
  CEZ_API_URL?: string;
  CEZ_PROJECT_ID?: string;
  CEZ_TASK_ID?: string;
  CEZ_RUN_ID?: string;
}

export interface LeaseCliIo {
  fetch: typeof fetch;
  log: (line: string) => void;
  error: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Run a command to completion; resolves its exit code. */
  exec: (command: string, args: string[]) => Promise<number>;
}

const POLL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 15_000;

const USAGE = `cez lease — fleet-wide locks (needs a cockpit with a fleet role; CEZ_API_URL is set inside every task)

  cez lease acquire <name> [--limit <n>] [--wait <seconds>] [--holder <id>] [--if-fleet]
                    exit 0 taken, 1 busy (or --wait ran out), 2 usage/no fleet
  cez lease release <name> [--holder <id>]
  cez lease list [--json]
  cez lease run <name> [--limit <n>] [--wait <seconds>] [--if-fleet] -- <command…>
                    take the lease, run the command, always release; exits with the command's code

  --limit n     n holders at once (a counting semaphore); default 1
  --wait s      keep trying for s seconds (default: try once)
  --holder id   who holds it; default is this task's id. acquire and release must agree on it.
  --if-fleet    when the cockpit has no fleet role, carry on as if the lease were taken`;

const defaultIo: LeaseCliIo = {
  fetch,
  log: console.log,
  error: console.error,
  sleep: (ms) => new Promise((done) => setTimeout(done, ms)),
  exec: (command, args) =>
    new Promise((done) => {
      const child = spawn(command, args, { stdio: 'inherit', shell: false });
      child.on('error', (error) => {
        console.error(`cez lease: cannot run ${command}: ${error.message}`);
        done(127);
      });
      child.on('close', (code, signal) => done(code ?? (signal ? 128 : 1)));
    }),
};

class FleetOff extends Error {}

async function readError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string') return body.error;
  } catch {
    // not JSON
  }
  return `${response.status} ${response.statusText}`;
}

const describe = (l: FleetLease): string => `${l.name}  ${l.holder}  @${l.nodeId}  until ${l.expiresAt}`;

export async function runLeaseCommand(args: string[], env: LeaseCliEnv = process.env, io: LeaseCliIo = defaultIo): Promise<number> {
  const [command, ...rest] = args;
  if (!command || command === 'help' || command === '--help' || rest.includes('--help')) {
    io.log(USAGE);
    return command ? 0 : 2;
  }
  const url = env.CEZ_API_URL?.replace(/\/+$/, '');
  const runId = env.CEZ_TASK_ID ?? env.CEZ_RUN_ID;
  if (!url) {
    io.error(missingCockpitMessage({ command: 'cez lease', example: 'cez lease list', insideTask: 'the cockpit did not hand this task an address, so leases are unavailable.' }, env));
    return 2;
  }
  const call = async (path: string, body?: unknown): Promise<unknown> => {
    const response = await io.fetch(`${url}/api/v1/workspace/fleet/leases${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) throw new FleetOff(await readError(response));
    if (!response.ok) throw new Error(await readError(response));
    return response.json();
  };
  const options = {
    limit: { type: 'string' },
    wait: { type: 'string' },
    holder: { type: 'string' },
    'if-fleet': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  } as const;
  const num = (value: string | undefined, name: string, min: number): number | undefined => {
    if (value === undefined) return undefined;
    const n = Number(value);
    if (!Number.isFinite(n) || n < min) throw new Error(`--${name} must be a number >= ${min}`);
    return n;
  };

  // `run` splits at `--`: everything after it is the command, untouched.
  const dash = rest.indexOf('--');
  const own = dash === -1 ? rest : rest.slice(0, dash);
  const tail = dash === -1 ? [] : rest.slice(dash + 1);
  let optional = false;
  try {
    const { values, positionals } = parseArgs({ args: own, allowPositionals: true, options });
    optional = values['if-fleet'];
    const name = fleetLeaseNameSchema.safeParse(positionals[0] ?? '');
    if (command !== 'list' && !name.success) throw new Error('give a lease name: letters, digits and . _ : / - (for example issue-123)');
    const leaseName = name.success ? name.data : '';
    const holderFor = (extra = ''): string => values.holder ?? `${runId ?? 'cli'}${extra}`;

    if (command === 'list') {
      const { leases } = fleetLeaseListResponseSchema.parse(await call(''));
      if (values.json) io.log(JSON.stringify(leases, null, 2));
      else if (leases.length === 0) io.log('no leases');
      else for (const lease of leases) io.log(describe(lease));
      return 0;
    }
    if (command === 'release') {
      const { released } = fleetLeaseReleaseResponseSchema.parse(await call('/release', { name: leaseName, holder: holderFor() }));
      io.log(released ? `released ${leaseName}` : `${leaseName} was not held by ${holderFor()}`);
      return 0;
    }

    const acquire = async (holder: string): Promise<number> => {
      const limit = num(values.limit, 'limit', 1);
      const waitMs = (num(values.wait, 'wait', 0) ?? 0) * 1000;
      const deadline = Date.now() + waitMs;
      for (let announced = false; ; ) {
        const result = fleetLeaseAcquireResponseSchema.parse(
          await call('/acquire', {
            name: leaseName,
            holder,
            ...(runId ? { runId } : {}),
            ...(env.CEZ_PROJECT_ID ? { projectId: env.CEZ_PROJECT_ID } : {}),
            ...(limit ? { limit } : {}),
          }),
        );
        if (result.acquired) return 0;
        if (Date.now() >= deadline) {
          io.error(`cez lease: ${leaseName} is held by ${result.holders.map((h) => `${h.holder}@${h.nodeId}`).join(', ')}`);
          return 1;
        }
        if (!announced) io.error(`cez lease: waiting for ${leaseName} (held by ${result.holders.map((h) => `${h.holder}@${h.nodeId}`).join(', ')})`);
        announced = true;
        await io.sleep(POLL_MS);
      }
    };

    if (command === 'acquire') {
      const code = await acquire(holderFor());
      if (code === 0) io.log(`acquired ${leaseName}`);
      return code;
    }
    if (command === 'run') {
      if (tail.length === 0) throw new Error('give the command after --: cez lease run <name> -- <command…>');
      // One lease per invocation, so two commands of the same task do not share a lock.
      const holder = values.holder ?? `${runId ?? 'cli'}:${process.pid}`;
      const code = await acquire(holder);
      if (code !== 0) return code;
      try {
        return await io.exec(tail[0] as string, tail.slice(1));
      } finally {
        await call('/release', { name: leaseName, holder }).catch(() => {});
      }
    }
    io.error(`cez lease: unknown command "${command}"\n\n${USAGE}`);
    return 2;
  } catch (error) {
    if (error instanceof FleetOff && optional) {
      // `--if-fleet`: a single instance has nothing to lock against; run the command unguarded.
      return command === 'run' && tail.length > 0 ? io.exec(tail[0] as string, tail.slice(1)) : 0;
    }
    io.error(`cez lease: ${error instanceof Error ? error.message : String(error)}`);
    return error instanceof FleetOff ? 2 : 1;
  }
}
