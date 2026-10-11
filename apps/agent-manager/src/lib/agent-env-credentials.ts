/**
 * Env vars from AWB credentials an operator exposed to agent runs
 * (`Credential.agent_env` — e.g. a Google OAuth client becomes
 * GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN).
 *
 * Fetched per spawn from `GET /api/agent-manager/agent-env?account_id=` —
 * server contract: apps/server/src/modules/credentials/credentials-agent-env.controller.ts.
 * The values never ride an SSE payload and are never written to disk here.
 * A process keeps the env it was started with, so an edited credential
 * reaches persistent sessions on their next spawn.
 *
 * Every spawn site (one-shot subagent, persistent ticket/chat session, Agent
 * Session) merges the result right after the base env, below AWB_API_KEY /
 * cli-home / per-agent credential / harness env — so it can never shadow
 * those. On top of that ordering, names the spawn itself owns are dropped
 * here: AWB_* and the CLI adapter's own auth vars (authEnvKeys()). The server
 * already refuses those at save time; this is the guard for a CLI whose auth
 * vars the server's list has not caught up with.
 */
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

export type AgentEnvFetcher = (config: AwbConfig, accountId: string) => Promise<AgentEnvResponse>;

export interface AgentEnvResponse {
  env: Record<string, string>;
  skipped: Array<{ credential_id?: string; name?: string; reason?: string }>;
}

// Shorter than the general REST timeout: this sits in front of every spawn.
const AGENT_ENV_TIMEOUT_MS = 5_000;

let fetcherOverride: AgentEnvFetcher | null = null;
let missingRouteLogged = false;

/** Test seam — spawn tests must not reach for a real AWB server. */
export function setAgentEnvFetcherForTests(fetcher: AgentEnvFetcher | null): void {
  fetcherOverride = fetcher;
  missingRouteLogged = false;
}

async function fetchAgentEnv(config: AwbConfig, accountId: string): Promise<AgentEnvResponse | null> {
  const qs = new URLSearchParams({ account_id: accountId });
  const resp = await fetch(`${config.url.replace(/\/$/, '')}/api/agent-manager/agent-env?${qs}`, {
    method: 'GET',
    headers: { 'X-Agent-Key': config.apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(AGENT_ENV_TIMEOUT_MS),
  });
  // An AWB server older than this manager has no route — nothing to inject.
  if (resp.status === 404) {
    if (!missingRouteLogged) log('[agent-env] server has no /api/agent-manager/agent-env route — credential env disabled');
    missingRouteLogged = true;
    return null;
  }
  if (!resp.ok) {
    let detail = '';
    try { detail = (await resp.json())?.error ?? ''; } catch { /* ignore */ }
    throw new Error(`HTTP ${resp.status}${detail ? ` ${detail}` : ''}`);
  }
  const body = await resp.json();
  return {
    env: body?.env && typeof body.env === 'object' ? body.env : {},
    skipped: Array.isArray(body?.skipped) ? body.skipped : [],
  };
}

/** Drop what the spawn owns, keep only string values. */
export function filterAgentEnv(
  env: Record<string, unknown>,
  ownedKeys: readonly string[],
): { env: Record<string, string>; dropped: string[] } {
  const owned = new Set(ownedKeys.map((k) => k.toUpperCase()));
  const out: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (name.toUpperCase().startsWith('AWB_') || owned.has(name.toUpperCase())) {
      dropped.push(name);
      continue;
    }
    out[name] = value;
  }
  return { env: out, dropped };
}

/**
 * Credential env for one spawn. Never throws: a failed fetch is logged with
 * the account and the run goes ahead without it — the agent then sees the
 * variable missing, which names the problem better than a refused dispatch.
 */
export async function agentCredentialEnvFor(
  config: AwbConfig,
  accountId: string | null | undefined,
  ownedKeys: readonly string[],
  tag: string,
): Promise<Record<string, string>> {
  const account = String(accountId || '').trim();
  if (!account || !config?.url || !config?.apiKey) return {};
  let response: AgentEnvResponse | null;
  try {
    response = fetcherOverride ? await fetcherOverride(config, account) : await fetchAgentEnv(config, account);
  } catch (err: any) {
    log(`${tag} credential env fetch failed for account ${account.slice(0, 8)}: ${err?.message ?? err} — spawning without it`);
    return {};
  }
  if (!response) return {};
  for (const s of response.skipped) {
    log(`${tag} credential env skipped ${s.name ?? s.credential_id ?? '?'}: ${s.reason ?? 'unknown reason'}`);
  }
  const { env, dropped } = filterAgentEnv(response.env, ownedKeys);
  if (dropped.length) log(`${tag} credential env dropped spawn-owned names: ${dropped.join(', ')}`);
  const names = Object.keys(env);
  if (names.length) log(`${tag} credential env: ${names.join(', ')}`);
  return env;
}
