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

/**
 * ST-5b — manager → server ack for an agent_manager_command. Fire-and-log
 * because the server's audit trail is best-effort (the command itself
 * already landed via SSE). Caller passes 'ok' or 'error' + a short detail
 * the operator can read from server logs.
 */
export async function postCommandAck(
  config: AwbConfig,
  command_id: string,
  status: 'ok' | 'error',
  detail?: string,
): Promise<void> {
  if (!command_id) return;
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/command/ack`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ command_id, status, detail: detail ?? '' }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`command ack POST failed: ${resp.status} ${resp.statusText} (command=${command_id})`);
    }
  } catch (err: any) {
    log(`command ack POST error: ${err?.message ?? err} (command=${command_id})`);
  }
}

/**
 * ST-5b — pull a managed agent's record from AWB. Used when the manager
 * receives a spawn_agent / set_working_dir command and needs to know the
 * canonical working_dir / cli for that agent identity. Returns null on any
 * failure; caller decides whether to surface error or fall through.
 */
export async function fetchAgentRecord(
  config: AwbConfig,
  agentId: string,
): Promise<{ id: string; name: string; type: string; working_dir: string; manager_agent_id: string | null } | null> {
  if (!agentId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agents/${encodeURIComponent(agentId)}`;
    const resp = await fetch(url, {
      headers: {
        'X-Agent-Key': config.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`agent fetch failed: ${resp.status} ${resp.statusText} (agent=${agentId})`);
      return null;
    }
    return (await resp.json()) as any;
  } catch (err: any) {
    log(`agent fetch error: ${err?.message ?? err} (agent=${agentId})`);
    return null;
  }
}

/**
 * ST-6: rotate-and-fetch the apiKey for a managed agent this manager owns.
 * The server validates ownership (Agent[target].manager_agent_id === manager's
 * agent_id) and returns the raw key once. The manager persists the key into
 * `<MANAGER_HOME>/agents/<agent_id>/apikey` and embeds it in a per-agent
 * mcp-config.json so spawned subagents authenticate as the managed agent.
 *
 * Returns null on any failure — caller decides whether to throw / retry.
 */
export async function provisionManagedAgentApiKey(
  config: AwbConfig,
  agentId: string,
): Promise<{ raw_key: string; key_id: string; agent_id: string; workspace_id: string } | null> {
  if (!agentId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}/apikey/provision`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`apiKey provision failed: ${resp.status} ${resp.statusText} (agent=${agentId})`);
      return null;
    }
    return (await resp.json()) as any;
  } catch (err: any) {
    log(`apiKey provision error: ${err?.message ?? err} (agent=${agentId})`);
    return null;
  }
}
