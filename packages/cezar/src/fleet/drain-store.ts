import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { cezarHomeDir } from '../paths.ts';

/** Nodes an operator drained: `cezarHomeDir()/fleet/drain.json`, same rules as `jobs.json` (written, never required). */
const fileSchema = z.object({ version: z.literal(1), nodes: z.array(z.string()) });

export function fleetDrainPath(): string {
  return join(cezarHomeDir(), 'fleet', 'drain.json');
}

export function loadDrained(path = fleetDrainPath()): string[] {
  try {
    return fileSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).nodes;
  } catch {
    return [];
  }
}

export function saveDrained(nodes: readonly string[], path = fleetDrainPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, nodes }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
