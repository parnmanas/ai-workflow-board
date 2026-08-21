import { REQUEST_TIMEOUT_MS } from './constants.js';
import { log } from './logging.js';

export interface AwbConfig {
  url: string;
  apiKey: string;
  workspace_id?: string;
  agent_id?: string;
  cli?: string;
  /** Override for `hasAuditTrailSince`'s grace delay (ticket 2fd06686).
   *  Production leaves this unset (real 2s grace); tests set it to 0 so the
   *  re-verification path they're exercising doesn't add real wall-clock
   *  time to every "no local comment seen" case. */
  silentExitVerifyDelayMs?: number;
  [key: string]: unknown;
}

function trimSlash(url: string): string {
  return url.replace(/\/$/, '');
}

export async function postRuntimeChildEvent(
  config: AwbConfig,
  body: {
    phase: 'start' | 'finish';
    parent_agent_id: string;
    parent_run_id: string;
    child_run_id: string;
    strategy: 'delegated' | 'swarm';
    depth?: number;
    budget?: number;
    title?: string;
    status?: 'completed' | 'failed' | 'cancelled';
    summary?: string;
    metadata?: unknown;
  },
): Promise<void> {
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/runtime/child-runs/${body.phase}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      log(
        `ChildRun ${body.phase} POST failed: ${response.status} ` +
        `(run=${body.parent_run_id} child=${body.child_run_id})`,
      );
    }
  } catch (error: any) {
    log(
      `ChildRun ${body.phase} POST error: ${error?.message ?? error} ` +
      `(run=${body.parent_run_id} child=${body.child_run_id})`,
    );
  }
}

// ── durable outbox hookup ────────────────────────────────────────────────────
// Send-failure trichotomy shared by the live wrappers below and the outbox
// replay path (lib/outbox.ts):
//   'ok'        — landed.
//   'retryable' — transport-level failure (fetch threw: refused / DNS / timeout)
//                 or a server-side 5xx / 408 / 429. The message itself is fine;
//                 the server just couldn't take it — buffer + replay later.
//   'permanent' — any other HTTP failure (4xx): a replay would fail identically,
//                 so buffering it would only wedge the queue.
export type SendOutcome = 'ok' | 'retryable' | 'permanent';

export function classifyHttpSendFailure(status: number): SendOutcome {
  return status >= 500 || status === 408 || status === 429 ? 'retryable' : 'permanent';
}

/** Kinds the wrappers below know how to buffer — mirror of OutboxKind
 *  (lib/outbox.ts). Declared structurally here so rest.ts does not import the
 *  outbox module (main.ts injects the live instance at boot). */
interface RestOutboxSink {
  enqueue(
    kind: 'chat_message' | 'silent_exit_comment' | 'dispatch_ack' | 'command_ack',
    payload: unknown,
  ): void;
}

let outboxSink: RestOutboxSink | null = null;

/** Wire (or clear) the durable outbox the send wrappers buffer retryable
 *  failures into. null (the default, and pre-boot state) = old fire-and-log
 *  behavior. Replays go through the *Raw functions, which never re-enqueue —
 *  so a replay that fails again cannot duplicate its own entry. */
export function setRestOutbox(sink: RestOutboxSink | null): void {
  outboxSink = sink;
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

/** Grace delay before the silent-exit re-verification fetch below (ticket
 *  2fd06686) — gives a comment/move POSTed right as the child exited a
 *  moment to actually land before we re-check for it. */
const SILENT_EXIT_VERIFY_DELAY_MS = 2_000;
/** Buffer subtracted from the session-start lower bound so a manager clock
 *  running a few seconds ahead of the server's doesn't cause a genuine
 *  audit-trail comment posted right at session start to be missed. */
const SILENT_EXIT_VERIFY_BUFFER_MS = 5_000;

/**
 * Re-verify against the ticket's ACTUAL comments before trusting a subagent
 * exit handler's local "no audit trail seen" verdict (ticket 2fd06686). The
 * local verdict comes from a live scan of the CLI's own stdout for a
 * comment-creating tool call; that scan can race the child's `exit` event
 * and — before this ticket — never recognized `move_ticket` as audit trail
 * at all. A `move_ticket` call makes the server post a system "moved from X
 * to Y" Comment row, so checking the real rows (not just the local tool-call
 * scan) catches both gaps in one pass, regardless of which one actually
 * caused a given false positive.
 *
 * Only comments created at/after `sinceMs` (minus the clock-skew buffer)
 * count — this is meant to answer "did THIS session's run produce
 * anything", not "does this ticket have any history at all". Comments
 * carrying `metadata.reason === 'silent_exit'` are excluded: those are the
 * manager's OWN prior fallback rows, not evidence of subagent work.
 *
 * Fails CLOSED (returns false — "no evidence found") on any fetch error, so
 * a flaky verification call falls back to the pre-existing behavior instead
 * of silently swallowing a genuine silent exit.
 */
export async function hasAuditTrailSince(
  config: AwbConfig,
  ticketId: string | undefined,
  sinceMs: number,
): Promise<boolean> {
  if (!ticketId) return false;
  const graceDelayMs = config.silentExitVerifyDelayMs ?? SILENT_EXIT_VERIFY_DELAY_MS;
  if (graceDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceDelayMs));
  }
  const ticket = await fetchTicketContext(config, ticketId);
  const comments = Array.isArray(ticket?.comments) ? ticket.comments : [];
  const cutoff = sinceMs - SILENT_EXIT_VERIFY_BUFFER_MS;
  return comments.some((c: any) => {
    if (c?.metadata?.reason === 'silent_exit') return false;
    const createdAt = new Date(c?.created_at).getTime();
    return Number.isFinite(createdAt) && createdAt >= cutoff;
  });
}

/**
 * Did `agentId` post a comment on `ticketId` whose id is NOT in
 * `knownCommentIds`? Confirms a Hermes comment-mention dispatch that ended
 * stopReason='end_turn' actually produced the `add_comment` MCP call it was
 * asked to make — 'end_turn' only means the ACP session ended cleanly, not
 * that any tool call inside it landed (ticket e8105c84).
 *
 * `knownCommentIds` is the id set from the ticket fetch taken BEFORE
 * dispatch (handleCommentMention already fetches the ticket once for prompt
 * composition — callers snapshot ids from that same response, no extra round
 * trip). This is exact id-set membership, not a timestamp window: an earlier
 * version of this check used `created_at >= sinceMs - buffer`, but no buffer
 * is simultaneously wide enough to absorb inter-host clock skew and narrow
 * enough to not also match a genuinely OLDER comment the same agent posted
 * moments before this dispatch started (review round 2) — id membership has
 * neither failure mode.
 *
 * No grace delay: the ACP session/prompt response that #dispatchHermes()
 * resolves on only arrives after Hermes's own add_comment call has already
 * round-tripped, so the write is already committed by the time this runs (no
 * exited-process-vs-in-flight-write race like the silent-exit case).
 *
 * Fails CLOSED (returns false — "no new reply seen") on any fetch error.
 */
export async function hasNewAgentComment(
  config: AwbConfig,
  ticketId: string | undefined,
  agentId: string | undefined,
  knownCommentIds: ReadonlySet<string>,
): Promise<boolean> {
  if (!ticketId || !agentId) return false;
  const ticket = await fetchTicketContext(config, ticketId);
  const comments = Array.isArray(ticket?.comments) ? ticket.comments : [];
  return comments.some(
    (c: any) => c?.author_id === agentId && c?.id && !knownCommentIds.has(c.id),
  );
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
  const outcome = await postCommandAckRaw(config, command_id, status, detail);
  if (outcome === 'retryable') {
    outboxSink?.enqueue('command_ack', { command_id, status, detail: detail ?? '' });
  }
}

/** Transport-only variant of {@link postCommandAck} — classifies the failure
 *  instead of buffering it. The outbox replay path calls this directly. */
export async function postCommandAckRaw(
  config: AwbConfig,
  command_id: string,
  status: 'ok' | 'error',
  detail?: string,
): Promise<SendOutcome> {
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
      return classifyHttpSendFailure(resp.status);
    }
    return 'ok';
  } catch (err: any) {
    log(`command ack POST error: ${err?.message ?? err} (command=${command_id})`);
    return 'retryable';
  }
}

/**
 * ticket e7c87517 — manager → server ack for an `agent_trigger` dispatch,
 * closing the durable dispatch outbox loop. Called right after the manager
 * spawns the subagent (`outcome='processed'`) or aborts the spawn
 * (`outcome='nack'` — worktree pool_exhausted / missing repo / push credential).
 * `triggerId` echoes the value received on the trigger payload (SSE
 * `field_changed`) so the server matches the ack to THAT dispatch and drops a
 * stale one. Fire-and-log: a dropped ack just means the server's reconciler
 * falls back to its processing-grace timeout before re-dispatching — the
 * durability guarantee never depends on this POST landing.
 */
export interface DispatchAckBody {
  ticket_id: string;
  role: string;
  trigger_id: string;
  outcome: 'processed' | 'nack';
  reason?: string;
  skill_snapshot_run_id?: string;
}

export async function postDispatchAck(
  config: AwbConfig,
  body: DispatchAckBody,
): Promise<void> {
  if (!body.ticket_id || !body.role) return;
  const outcome = await postDispatchAckRaw(config, body);
  // Buffered with a SHORT TTL (see outbox.ts): a replayed 'processed' ack that
  // still lands inside the server's processing-grace window prevents a
  // duplicate re-dispatch of work the manager already spawned; past that
  // window the server matches trigger_id and drops the stale ack harmlessly.
  if (outcome === 'retryable') {
    outboxSink?.enqueue('dispatch_ack', { body });
  }
}

/** Transport-only variant of {@link postDispatchAck} — classifies the failure
 *  instead of buffering it. The outbox replay path calls this directly. */
export async function postDispatchAckRaw(
  config: AwbConfig,
  body: DispatchAckBody,
): Promise<SendOutcome> {
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/dispatch/ack`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        ticket_id: body.ticket_id,
        role: body.role,
        trigger_id: body.trigger_id || '',
        outcome: body.outcome,
        reason: body.reason ?? '',
        skill_snapshot_run_id: body.skill_snapshot_run_id ?? '',
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`dispatch ack POST failed: ${resp.status} ${resp.statusText} (ticket=${body.ticket_id.slice(0, 8)} outcome=${body.outcome})`);
      return classifyHttpSendFailure(resp.status);
    }
    return 'ok';
  } catch (err: any) {
    log(`dispatch ack POST error: ${err?.message ?? err} (ticket=${body.ticket_id.slice(0, 8)} outcome=${body.outcome})`);
    return 'retryable';
  }
}

/**
 * ticket fdc69c13 — manager → server output-liveness heartbeat. Called
 * (throttled by OUTPUT_LIVENESS_MIN_INTERVAL_MS) whenever a ticket subagent
 * emits model output, so the server's TicketSupervisor knows the
 * (agent,ticket,role) strand is alive and must NOT be force-respawned into the
 * exit-143 deathloop. Fire-and-log: a dropped heartbeat just means the
 * supervisor falls back to ticket-write staleness for that window. `apiKey` is
 * the effective (managed-agent-or-manager) key so the report authenticates even
 * when the child runs as a managed agent.
 */
export async function postOutputLiveness(
  config: AwbConfig,
  apiKey: string,
  body: { agent_id: string; ticket_id: string; role: string },
): Promise<void> {
  if (!body.agent_id || !body.ticket_id) return;
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/output-liveness`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': apiKey || config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`output-liveness POST failed: ${resp.status} ${resp.statusText} (ticket=${body.ticket_id})`);
    }
  } catch (err: any) {
    log(`output-liveness POST error: ${err?.message ?? err} (ticket=${body.ticket_id})`);
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
): Promise<{
  id: string;
  name: string;
  type: string;
  working_dir: string;
  manager_agent_id: string | null;
  credential_id?: string | null;
  model?: string | null;
  runtime_config?: import('./runtime/runtime-types.js').AgentRuntimeConfig | null;
} | null> {
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
  workspaceId?: string,
): Promise<{ credential_id: string; provider: string; fields: Record<string, string> } | null> {
  if (!agentId) return null;
  try {
    const query = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}/credential${query}`;
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

export async function fetchRepositoryCredential(
  config: AwbConfig,
  resourceId: string,
  agentId: string,
  workspaceId?: string,
): Promise<{ username?: string; token: string } | null> {
  if (!resourceId || !agentId) return null;
  try {
    const workspaceQuery = workspaceId ? `&workspace_id=${encodeURIComponent(workspaceId)}` : '';
    const url = `${trimSlash(config.url)}/api/agent-manager/resources/${encodeURIComponent(resourceId)}/git-credential?agent_id=${encodeURIComponent(agentId)}${workspaceQuery}`;
    const resp = await fetch(url, {
      headers: { 'X-Agent-Key': config.apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (resp.status === 204) return null;
    if (!resp.ok) {
      log(`repository credential fetch failed: ${resp.status} (resource=${resourceId.slice(0, 8)})`);
      return null;
    }
    const body = await resp.json() as any;
    return typeof body?.token === 'string' && body.token
      ? { username: typeof body.username === 'string' ? body.username : undefined, token: body.token }
      : null;
  } catch (err: any) {
    log(`repository credential fetch error: ${err?.message ?? err} (resource=${resourceId.slice(0, 8)})`);
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
  // `metadata` (ticket 24694916): structured ticket-action refs the ChatSessionManager
  // captured from mcp__awb__* tool results. Forwarded to the agent-api send endpoint,
  // which sanitizes + persists it so the client renders reliable ticket cards.
  opts?: { type?: 'message' | 'progress'; metadata?: unknown },
): Promise<boolean> {
  if (!roomId || !content) return false;
  const outcome = await postChatRoomMessageRaw(config, roomId, agentId, content, opts);
  // Buffer real replies only — a replayed `progress` heartbeat is stale noise
  // by the time the server is reachable again (and the turn it narrated has
  // long since ended), so progress stays fire-and-log.
  if (outcome === 'retryable' && opts?.type !== 'progress') {
    outboxSink?.enqueue('chat_message', {
      room_id: roomId,
      agent_id: agentId,
      content,
      opts: opts ?? null,
    });
  }
  return outcome === 'ok';
}

/** Transport-only variant of {@link postChatRoomMessage} — classifies the
 *  failure instead of buffering it. The outbox replay path calls this directly. */
export async function postChatRoomMessageRaw(
  config: AwbConfig,
  roomId: string,
  agentId: string,
  content: string,
  opts?: { type?: 'message' | 'progress'; metadata?: unknown } | null,
): Promise<SendOutcome> {
  if (!roomId || !content) return 'permanent';
  try {
    const url = `${trimSlash(config.url)}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/messages`;
    const body: Record<string, unknown> = { agent_id: agentId, content };
    if (opts?.type && opts.type !== 'message') body.type = opts.type;
    if (opts?.metadata) body.metadata = opts.metadata;
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
      return classifyHttpSendFailure(resp.status);
    }
    return 'ok';
  } catch (err: any) {
    log(`chat fallback POST error: ${err?.message ?? err} (room=${roomId})`);
    return 'retryable';
  }
}

/**
 * ticket e18be8ff — push a chat session's current keep-alive / live
 * background-task-count snapshot so the room UI can render "백그라운드 작업
 * N개 실행 중 · keep-alive 잔여 XX분". Same posture as the room typing
 * indicator: fire-and-log, no outbox buffering — a dropped push just means
 * the badge is stale until the next recheck (idle timer / applyKeepAlive),
 * never a correctness issue for the session itself.
 */
export async function postChatRoomSessionStatus(
  config: AwbConfig,
  roomId: string,
  agentId: string,
  body: { keep_alive_until_ms: number | null; background_task_count: number },
): Promise<void> {
  if (!roomId || !agentId) return;
  try {
    const url = `${trimSlash(config.url)}/api/agent/chat-rooms/${encodeURIComponent(roomId)}/session-status`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ agent_id: agentId, ...body }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`session-status POST failed: ${resp.status} ${resp.statusText} (room=${roomId})`);
    }
  } catch (err: any) {
    log(`session-status POST error: ${err?.message ?? err} (room=${roomId})`);
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
    agent_id?: string;
    subagent_session_id?: string;
    cycle_started_at?: string;
    silent_exit_attempt?: number;
    terminal_reason?: string;
    silent_exit_family_key?: string;
    silent_exit_retry_count?: number;
  },
): Promise<'created' | 'suppressed' | 'failed'> {
  if (!ticketId || !body.content) return 'failed';
  const graceDelayMs = config.silentExitVerifyDelayMs ?? 500;
  if (graceDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, graceDelayMs));
  }
  const { outcome, result } = await postSilentExitSystemCommentRaw(config, ticketId, body);
  if (outcome === 'retryable') {
    outboxSink?.enqueue('silent_exit_comment', { ticket_id: ticketId, body });
  }
  return result;
}

export async function startMentionAuditRun(
  config: AwbConfig,
  ticketId: string,
  body: { cycle_trigger_id: string; agent_id: string; role?: string; attempt: number; subagent_session_id?: string },
): Promise<{ run_token: string; attempt: number } | null> {
  try {
    const resp = await fetch(`${trimSlash(config.url)}/api/agent/tickets/${encodeURIComponent(ticketId)}/mention-audit-runs/start`, {
      method: 'POST',
      headers: { 'X-Agent-Key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

export async function completeMentionAuditRun(
  config: AwbConfig,
  ticketId: string,
  runToken: string,
  exitCode: number | null,
): Promise<{ decision: 'succeeded' | 'retry' | 'retry_claimed' | 'failed'; attempt: number; reason?: string } | null> {
  try {
    const resp = await fetch(`${trimSlash(config.url)}/api/agent/tickets/${encodeURIComponent(ticketId)}/mention-audit-runs/${encodeURIComponent(runToken)}/complete`, {
      method: 'POST',
      headers: { 'X-Agent-Key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ exit_code: exitCode }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

export async function failMentionAuditRetrySpawn(
  config: AwbConfig,
  ticketId: string,
  runToken: string,
): Promise<{ decision: 'failed'; attempt: 1; reason: string; family_key?: string } | null> {
  try {
    const resp = await fetch(
      `${trimSlash(config.url)}/api/agent/tickets/${encodeURIComponent(ticketId)}/mention-audit-runs/${encodeURIComponent(runToken)}/retry-spawn-failed`,
      {
        method: 'POST',
        headers: { 'X-Agent-Key': config.apiKey, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    return resp.ok ? await resp.json() : null;
  } catch {
    return null;
  }
}

/** Transport-only variant of {@link postSilentExitSystemComment} — no grace
 *  delay (the exit it narrates is long past by replay time) and classifies the
 *  failure instead of buffering it. The outbox replay path calls this directly. */
export async function postSilentExitSystemCommentRaw(
  config: AwbConfig,
  ticketId: string,
  body: Parameters<typeof postSilentExitSystemComment>[2],
): Promise<{ outcome: SendOutcome; result: 'created' | 'suppressed' | 'failed' }> {
  if (!ticketId || !body?.content) return { outcome: 'permanent', result: 'failed' };
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
      return { outcome: classifyHttpSendFailure(resp.status), result: 'failed' };
    }
    const result = await resp.json().catch(() => null);
    return { outcome: 'ok', result: result?.suppressed === true ? 'suppressed' : 'created' };
  } catch (err: any) {
    log(`silent-exit comment POST error: ${err?.message ?? err} (ticket=${ticketId})`);
    return { outcome: 'retryable', result: 'failed' };
  }
}

export async function provisionManagedAgentApiKey(
  config: AwbConfig,
  agentId: string,
  workspaceId?: string,
): Promise<{ raw_key: string; key_id: string; agent_id: string; workspace_id: string } | null> {
  if (!agentId) return null;
  try {
    const query = workspaceId ? `?workspace_id=${encodeURIComponent(workspaceId)}` : '';
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}/apikey/provision${query}`;
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

/**
 * Ask the server to immediately re-push agent_trigger(s) for the given
 * (ticket, role) work a just-restarted managed agent was interrupted on.
 * Used by restart_agent right after the fresh spawn so the agent resumes on
 * the new credential without waiting for TicketSupervisorService's ~30-min
 * stale sweep. Server validates manager ownership of the agent and emits
 * each trigger with force_respawn + bypassFocus. Returns the server's
 * emitted/skipped counts, or null on any transport failure (the supervisor
 * remains the backstop, so a failed re-push only delays resume — it never
 * loses the work).
 */
export async function requestManagerTriggerRepush(
  config: AwbConfig,
  agentId: string,
  items: Array<{ ticket_id: string; role: string }>,
): Promise<{ emitted: number; skipped: number } | null> {
  if (!agentId || !Array.isArray(items) || items.length === 0) {
    return { emitted: 0, skipped: 0 };
  }
  try {
    const url = `${trimSlash(config.url)}/api/agent-manager/managed-agents/${encodeURIComponent(agentId)}/resume-triggers`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'X-Agent-Key': config.apiKey,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ items }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!resp.ok) {
      log(`resume-triggers POST failed: ${resp.status} ${resp.statusText} (agent=${agentId})`);
      return null;
    }
    return (await resp.json()) as any;
  } catch (err: any) {
    log(`resume-triggers POST error: ${err?.message ?? err} (agent=${agentId})`);
    return null;
  }
}
