import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fleetLeaseSchema, type FleetLease } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

/** The hub's leases: `cezarHomeDir()/fleet/leases.json`, same rules as `jobs.json` (written, never required). */
const fileSchema = z.object({ version: z.literal(1), leases: z.array(z.unknown()) });

export function fleetLeasesPath(): string {
  return join(cezarHomeDir(), 'fleet', 'leases.json');
}

export function loadLeases(path = fleetLeasesPath(), warn: (message: string) => void = console.warn): FleetLease[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    return fileSchema.parse(JSON.parse(raw)).leases.flatMap((entry) => {
      const parsed = fleetLeaseSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    warn(`fleet: ${path} is unreadable; starting with no leases`);
    return [];
  }
}

export function saveLeases(leases: readonly FleetLease[], path = fleetLeasesPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, leases }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
