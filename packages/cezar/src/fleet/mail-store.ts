import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { fleetMailSchema, type FleetMail } from '@open-mercato/cezar-contract';
import { cezarHomeDir } from '../paths.ts';

/** The hub's mail: `cezarHomeDir()/fleet/mail.json`, undelivered task mail, same rules as `jobs.json` (written, never required). */
const fileSchema = z.object({ version: z.literal(1), mail: z.array(z.unknown()) });

export function fleetMailPath(): string {
  return join(cezarHomeDir(), 'fleet', 'mail.json');
}

export function loadMail(path = fleetMailPath(), warn: (message: string) => void = console.warn): FleetMail[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return [];
  }
  try {
    return fileSchema.parse(JSON.parse(raw)).mail.flatMap((entry) => {
      const parsed = fleetMailSchema.safeParse(entry);
      return parsed.success ? [parsed.data] : [];
    });
  } catch {
    warn(`fleet: ${path} is unreadable; starting with no mail`);
    return [];
  }
}

export function saveMail(mail: readonly FleetMail[], path = fleetMailPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: 1, mail }, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
