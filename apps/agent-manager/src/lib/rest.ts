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
 * ST-7 — pull a managed agent's record from AWB. Used when the manager
 * receives a spawn_agent / set_working_dir command and needs to know the
 * canonical working_dir / cli for that agent identity. Returns null on any
 * failure; caller decides whether to surface error or fall through.
 *
 * Endpoint switched from /api/agents/:id (user-session gated, always 401
 * for the manager's agent apiKey) to the manager-auth peer at
 * /api/agent-manager/managed-agents/:id, which validates ownership
 * server-side (target.manager_agent_id === caller). Server also enriches
 * spawn_agent args at dispatch time, so a 404/403 here is no longer
 * fatal — the SSE payload typically already carries the same fields.
 */
export async function fetchAgentRecord(
  config: AwbConfig,
  agentId: string,
): Promise<{ id: string; name: string; type: string; working_dir: string; manager_agent_id: string | null; credential_id?: string | null } | null> {
  if (!agentId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}`;
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
/**
 * Fetch the decrypted CLI credential for a managed agent the manager owns.
 * Returns null when the agent has no credential set (server returns 204) and
 * also on any error (manager falls back to operator-HOME defaults). The
 * payload shape mirrors the server's
 * `/api/agent-manager/managed-agents/:id/credential` route.
 */
export async function fetchAgentCredential(
  config: AwbConfig,
  agentId: string,
): Promise<{ credential_id: string; provider: string; fields: Record<string, string> } | null> {
  if (!agentId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}/credential`;
    const resp = await fetch(url, {
      headers: {
        'X-Agent-Key': config.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // 204 = agent has no credential_id set — caller treats as "use operator HOME".
    if (resp.status === 204) return null;
    if (!resp.ok) {
      log(`agent credential fetch failed: ${resp.status} ${resp.statusText} (agent=${agentId})`);
      return null;
    }
    const body = (await resp.json()) as any;
    if (!body || typeof body !== 'object' || typeof body.provider !== 'string') return null;
    return {
      credential_id: typeof body.credential_id === 'string' ? body.credential_id : '',
      provider: body.provider,
      fields: body.fields && typeof body.fields === 'object' ? body.fields : {},
    };
  } catch (err: any) {
    log(`agent credential fetch error: ${err?.message ?? err} (agent=${agentId})`);
    return null;
  }
}

/**
 * Fetch a single chat attachment (with base64 body) for the agent-key holder.
 * Mirrors the user-session GET /api/chat-rooms/:roomId/attachments/:id but
 * gated by AgentAuthGuard + participant check, so the manager can pull
 * attachment bytes for vision / file delivery to subagent prompts without
 * needing a user session.
 */
export async function fetchChatAttachment(
  config: AwbConfig,
  roomId: string,
  attachmentId: string,
): Promise<{
  id: string;
  file_name: string;
  file_mimetype: string;
  file_size: number;
  file_data: string;
  download_url: string;
} | null> {
  if (!roomId || !attachmentId) return null;
  try {
    const url = `${trimSlash(config.url)}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/attachments/${encodeURIComponent(attachmentId)}`;
    const resp = await fetch(url, {
      headers: {
        'X-Agent-Key': config.apiKey,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`Chat attachment fetch failed: ${resp.status} ${resp.statusText} (room=${roomId} att=${attachmentId})`);
      return null;
    }
    const body = (await resp.json()) as any;
    if (!body || typeof body !== 'object' || typeof body.file_data !== 'string') {
      return null;
    }
    return body;
  } catch (err: any) {
    log(`Chat attachment fetch error: ${err?.message ?? err} (room=${roomId} att=${attachmentId})`);
    return null;
  }
}

/**
 * Send a message to an AWB chat room on behalf of an agent.
 * Fire-and-log on failure — caller is a best-effort fallback path.
 *
 * `opts.type`:
 *   - 'message'  (default) — real chat reply, kept in agent history replay.
 *   - 'progress' — tool-call heartbeat, stripped from agent history replay
 *                  but rendered compactly in the human-facing UI. Used by
 *                  ChatSessionManager#emitProgress.
 */
export async function postChatRoomMessage(
  config: AwbConfig,
  roomId: string,
  agentId: string,
  content: string,
  opts?: { type?: 'message' | 'progress' },
): Promise<boolean> {
  if (!roomId || !content) return false;
  try {
    const url = `${trimSlash(config.url)}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/messages`;
    const body: Record<string, unknown> = { agent_id: agentId, content };
    if (opts?.type && opts.type !== 'message') body.type = opts.type;
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
      log(`chat fallback POST failed: ${resp.status} ${resp.statusText} (room=${roomId})`);
      return false;
    }
    return true;
  } catch (err: any) {
    log(`chat fallback POST error: ${err?.message ?? err} (room=${roomId})`);
    return false;
  }
}

/**
 * Post a silent-exit system comment on a ticket. Used by the agent-manager
 * when a ticket subagent (persistent or one-shot) exits without ever
 * calling `add_comment` OR with a non-zero exit code — leaving no audit
 * trail on the ticket. The server endpoint (`AgentAuthGuard`-gated) creates
 * a `type='system'` Comment and emits the standard activity event so SSE
 * board_update cascades to Reviewer triggers normally.
 *
 * Fire-and-log on failure — losing the fallback comment is unfortunate but
 * the subagent already exited, so retrying is the operator's job.
 */
export async function postSilentExitSystemComment(
  config: AwbConfig,
  ticketId: string,
  body: {
    content: string;
    exit_code: number | null;
    cycle_trigger_id?: string;
    role?: string;
    actor_name?: string;
  },
): Promise<boolean> {
  if (!ticketId || !body.content) return false;
  try {
    const url = `${trimSlash(config.url)}/api/agent/tickets/${encodeURIComponent(ticketId)}/silent-exit-comment`;
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
      log(
        `silent-exit comment POST failed: ${resp.status} ${resp.statusText} (ticket=${ticketId})`,
      );
      return false;
    }
    return true;
  } catch (err: any) {
    log(`silent-exit comment POST error: ${err?.message ?? err} (ticket=${ticketId})`);
    return false;
  }
}

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
