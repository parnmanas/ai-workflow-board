import { REQUEST_TIMEOUT_MS } from './constants.js';
import { loadAgentInfo } from './config.js';
import type { AwbConfig } from './rest.js';

/** Probe the key itself, never the manager fallback. Transport/server failures
 * must stop dispatch, not rotate a potentially healthy key used by live sessions. */
export async function validateRuntimeApiKey(
  config: AwbConfig,
  apiKey: string,
  accountId: string,
  agentId: string,
): Promise<boolean> {
  if (!apiKey || !accountId || !agentId) return false;
  const response = await fetch(`${config.url.replace(/\/$/, '')}/api/agent-manager/runtime-keys/validate`, {
    headers: { 'X-Agent-Key': apiKey, Accept: 'application/json' },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 || response.status === 403) return false;
  if (!response.ok) throw new Error(`Runtime API key validation HTTP ${response.status}`);
  const identity = await response.json() as { account_id?: unknown; runtime_key?: unknown; host_id?: unknown };
  if (!identity || typeof identity.account_id !== 'string' || typeof identity.runtime_key !== 'string'
    || typeof identity.host_id !== 'string') {
    throw new Error('Runtime API key validation returned an invalid identity');
  }
  const manager = loadAgentInfo();
  const hostId = manager?.host_id || manager?.agent_id;
  return identity.account_id === accountId && identity.runtime_key === agentId
    && (!hostId || identity.host_id === hostId);
}
