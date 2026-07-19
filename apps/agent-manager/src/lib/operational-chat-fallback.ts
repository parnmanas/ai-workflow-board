import { createHash } from 'node:crypto';
import { log } from './logging.js';
import type { AwbConfig } from './rest.js';

export const OPERATIONAL_FALLBACK_PREFIX = 'AWB_OPERATIONAL_FALLBACK:';

export interface OperationalFallbackRequest {
  operation: string;
  missing_capability: string;
  original_request?: string;
}

export interface OperationalFallbackSource {
  room_id: string;
  message_id: string;
  board_id?: string;
}

export function parseOperationalFallback(text: string): OperationalFallbackRequest | null {
  const line = text.split(/\r?\n/).find((value) => value.trim().startsWith(OPERATIONAL_FALLBACK_PREFIX));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(line.indexOf(OPERATIONAL_FALLBACK_PREFIX) + OPERATIONAL_FALLBACK_PREFIX.length).trim());
    if (!value || typeof value.operation !== 'string' || !value.operation.trim()
      || typeof value.missing_capability !== 'string' || !value.missing_capability.trim()) return null;
    return {
      operation: value.operation.trim().toLowerCase().replace(/\s+/g, ' '),
      missing_capability: value.missing_capability.trim().toLowerCase().replace(/\s+/g, ' '),
      original_request: typeof value.original_request === 'string' ? value.original_request.trim() : '',
    };
  } catch {
    return null;
  }
}

export function operationalDedupeKey(workspaceId: string, request: OperationalFallbackRequest): string {
  return createHash('sha256')
    .update(`${workspaceId.trim()}\n${request.operation}\n${request.missing_capability}`)
    .digest('hex');
}

/** Server owns the atomic open-ticket lookup/create transaction.  Keeping the
 * claim there makes concurrent managers and manager restarts share one result. */
export async function ensureOperationalFallbackTicket(
  config: AwbConfig,
  request: OperationalFallbackRequest,
  source: OperationalFallbackSource,
  fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; title: string; reused: boolean }> {
  const workspaceId = String(config.workspace_id || '');
  const key = operationalDedupeKey(workspaceId, request);
  const url = `${String(config.url).replace(/\/$/, '')}/api/agent/operational-capability-ticket`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'X-Agent-Key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ workspace_id: workspaceId, dedupe_key: key, ...request, ...source }),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`operational fallback ticket failed: ${response.status}${detail ? ` ${detail}` : ''}`);
  }
  const body = await response.json() as any;
  if (!body?.id) throw new Error('operational fallback ticket returned no id');
  log(`[operational-fallback] ${body.reused ? 'reused' : 'created'} ticket=${body.id} key=${key.slice(0, 12)}`);
  return { id: String(body.id), title: String(body.title || ''), reused: !!body.reused };
}
