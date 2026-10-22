import { hostname } from 'node:os';

/**
 * Fleet role from the environment (spec 2026-10-21-fleet-coordination). Off unless a role is
 * asked for: a single local cezar never reads any of this.
 */

import { fleetTagSchema } from '@open-mercato/cezar-contract';

export const FLEET_DEFAULT_PORT = 4330;
export const FLEET_MIN_TOKEN_LENGTH = 32;
/** A job running longer than this is failed and its run cancelled (hung or endlessly monitoring). */
export const FLEET_DEFAULT_JOB_TIMEOUT_MINUTES = 240;

export type FleetConfig =
  | { role: 'off' }
  | { role: 'invalid'; error: string }
  | { role: 'hub'; token: string; nodeId: string; port: number; bind: string; jobTimeoutMs: number; tags: string[] }
  | { role: 'worker'; token: string; nodeId: string; hubUrl: string; jobTimeoutMs: number; tags: string[] };

type Env = Record<string, string | undefined>;

export function fleetConfigFromEnv(env: Env = process.env): FleetConfig {
  const isHub = env.CEZ_FLEET_HUB === '1';
  const hubUrl = env.CEZ_FLEET_HUB_URL?.trim().replace(/\/+$/, '');
  if (!isHub && !hubUrl) return { role: 'off' };
  if (isHub && hubUrl) {
    return { role: 'invalid', error: 'CEZ_FLEET_HUB=1 and CEZ_FLEET_HUB_URL are mutually exclusive: an instance is the hub or joins one' };
  }
  const token = env.CEZ_FLEET_TOKEN ?? '';
  if (token.length < FLEET_MIN_TOKEN_LENGTH) {
    return { role: 'invalid', error: `CEZ_FLEET_TOKEN is required and must be at least ${FLEET_MIN_TOKEN_LENGTH} characters` };
  }
  const nodeId = env.CEZ_FLEET_NODE_ID?.trim() || hostname();
  const minutes = env.CEZ_FLEET_JOB_TIMEOUT_MINUTES ? Number(env.CEZ_FLEET_JOB_TIMEOUT_MINUTES) : FLEET_DEFAULT_JOB_TIMEOUT_MINUTES;
  if (!Number.isFinite(minutes) || minutes <= 0) return { role: 'invalid', error: 'CEZ_FLEET_JOB_TIMEOUT_MINUTES must be a positive number' };
  const jobTimeoutMs = Math.round(minutes * 60_000);
  const tags = [...new Set((env.CEZ_FLEET_TAGS ?? '').split(',').map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (tags.length > 20 || tags.some((t) => !fleetTagSchema.safeParse(t).success)) {
    return { role: 'invalid', error: 'CEZ_FLEET_TAGS must be up to 20 comma-separated tags of letters, digits, . _ - (for example docker,android)' };
  }
  if (hubUrl) {
    if (!/^https?:\/\//i.test(hubUrl)) return { role: 'invalid', error: 'CEZ_FLEET_HUB_URL must be an http(s) URL' };
    return { role: 'worker', token, nodeId, hubUrl, jobTimeoutMs, tags };
  }
  const port = env.CEZ_FLEET_PORT ? Number(env.CEZ_FLEET_PORT) : FLEET_DEFAULT_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { role: 'invalid', error: 'CEZ_FLEET_PORT must be a port number' };
  return { role: 'hub', token, nodeId, port, bind: env.CEZ_FLEET_BIND?.trim() || '0.0.0.0', jobTimeoutMs, tags };
}
