import { REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';

export interface AwbConfig {
  url: string;
  apiKey: string;
  workspace_id?: string;
  agent_id?: string;
  cli?: string;
  [key: string]: unknown;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * Fetch a fresh ticket with comments from AWB REST.
 * Returns null on any failure; caller falls back to embedded trigger payload.
 */
export async function fetchTicketContext(
  config: AwbConfig,
  ticketId: string | undefined,
): Promise<any | null> {
  if (!ticketId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agent/tickets/${encodeURIComponent(ticketId)}`;
    const resp = await fetch(url, {
      headers: {
        'X-Agent-Key': config.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`Ticket fetch failed: ${resp.status} ${resp.statusText} (ticket=${ticketId})`);
      return null;
    }
    return await resp.json();
  } catch (err: any) {
    log(`Ticket fetch error: ${err?.message ?? err} (ticket=${ticketId})`);
    return null;
  }
}

/**
 * Fetch recent chat room messages from AWB REST API.
 * Returns array (possibly empty) on success or empty on failure.
 */
export async function fetchChatRoomHistory(
  config: AwbConfig,
  roomId: string | undefined,
  limit = 20,
): Promise<any[]> {
  if (!roomId) return [];
  try {
    const url = `${trimSlash(config.url)}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/messages?limit=${limit}`;
    const resp = await fetch(url, {
      headers: { 'X-Agent-Key': config.apiKey },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`Chat room history fetch failed: ${resp.status} (room=${roomId})`);
      return [];
    }
    const data = await resp.json();
    return Array.isArray(data) ? data : (data?.messages ?? []);
  } catch (err: any) {
    log(`Chat room history fetch error: ${err?.message ?? err} (room=${roomId})`);
    return [];
  }
}

/**
 * POST a response payload back to AWB for a pending fs_request.
 * Fire-and-log on failure — server-side timeout will surface a 504 to the UI.
 */
export async function postFsResponse(
  config: AwbConfig,
  requestId: string,
  body: unknown,
): Promise<void> {
  if (!requestId) return;
  try {
    const url = `${trimSlash(config.url)}/api/fs/responses/${encodeURIComponent(requestId)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`fs response POST failed: ${resp.status} ${resp.statusText} (request=${requestId})`);
    }
  } catch (err: any) {
    log(`fs response POST error: ${err?.message ?? err} (request=${requestId})`);
  }
}
