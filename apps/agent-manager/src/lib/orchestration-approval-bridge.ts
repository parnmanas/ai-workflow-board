// Mission tool approvals — the Runtime Host half (docs/orchestration.md → "실행 승인").
//
// A CLI running in a mission room at `approve` trust raises a permission prompt over its stdio
// (claude: `--permission-prompt-tool stdio`; Hermes: ACP `session/request_permission`). This module
// relays it to AWB (`POST /api/agent/orchestration/approvals`) and long-polls the answer, which
// comes from the mission's trusted orchestrator or from the user. The CLI stays blocked meanwhile —
// that is the point — so the session reapers treat a pending approval as progress.
//
// Failure posture: an answer we cannot get is a DENIAL with a reason the model can read, never an
// approval. Transient network trouble is retried (the request key makes a re-send land on the same
// row); a request AWB says is gone or not ours ends the wait.

import { randomUUID } from 'node:crypto';

import { log } from './logging.js';
import type { AwbConfig } from './rest.js';
import type { AcpPermissionOutcome, AcpPermissionRequest } from './runtime/acp/acp-types.js';

/** What the CLI asked. */
export interface ApprovalPrompt {
  /** The CLI's own request id — AWB de-duplicates re-sends on it. */
  requestKey: string;
  toolName: string;
  title?: string;
  description?: string;
  input?: unknown;
  /** The CLI offered a rule to remember the answer for its session. */
  canAllowSession: boolean;
}

export type ApprovalDecision = 'allow' | 'allow_session' | 'deny';

export interface ApprovalOutcome {
  decision: ApprovalDecision;
  /** For the model: why it was denied / withdrawn, or who approved. */
  message: string;
}

export interface ApprovalBridge {
  request(prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome>;
}

interface WireView {
  id: string | null;
  status: 'pending' | 'approved' | 'denied' | 'cancelled';
  decision: ApprovalDecision | null;
  message: string;
}

export interface ApprovalBridgeOptions {
  roomId: string;
  /** The runtime the CLI runs as (room participant / step assignee). */
  agentId: string;
  /** That runtime's key; the manager key is the fallback on 401/403. */
  apiKey?: string | null;
  /** How long one long-poll may hold on the server. */
  pollTimeoutMs?: number;
  /** Give up re-sending a request AWB never acknowledged after this long. */
  sendDeadlineMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const DEFAULT_POLL_MS = 25_000;
const DEFAULT_SEND_DEADLINE_MS = 5 * 60_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 15_000;

class HttpStatusError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function abortError(): Error {
  const err = new Error('approval wait aborted');
  err.name = 'AbortError';
  return err;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function outcomeOf(view: WireView): ApprovalOutcome | null {
  if (view.status === 'pending') return null;
  if (view.status === 'approved' && (view.decision === 'allow' || view.decision === 'allow_session')) {
    return { decision: view.decision, message: view.message || 'Approved.' };
  }
  return { decision: 'deny', message: view.message || 'Denied.' };
}

export function createOrchestrationApprovalBridge(config: AwbConfig, opts: ApprovalBridgeOptions): ApprovalBridge {
  const base = String(config.url || '').replace(/\/$/, '');
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const pollMs = opts.pollTimeoutMs ?? DEFAULT_POLL_MS;
  const sendDeadlineMs = opts.sendDeadlineMs ?? DEFAULT_SEND_DEADLINE_MS;
  const keys = Array.from(new Set([opts.apiKey, config.apiKey, config.retryApiKey].filter((k): k is string => !!k)));

  async function call(method: 'GET' | 'POST', path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    let lastStatus = 0;
    for (const key of keys) {
      const timeout = AbortSignal.timeout(timeoutMs);
      const resp = await doFetch(`${base}${path}`, {
        method,
        headers: {
          'X-Agent-Key': key,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (resp.ok) return resp.json();
      lastStatus = resp.status;
      // A runtime key that went stale mid-session: the manager key may still speak for it.
      if (resp.status === 401 || resp.status === 403) continue;
      let detail = '';
      try {
        detail = String(((await resp.json()) as any)?.error || '');
      } catch {
        /* no body */
      }
      throw new HttpStatusError(resp.status, detail || `HTTP ${resp.status}`);
    }
    throw new HttpStatusError(lastStatus || 401, 'AWB refused this runtime\'s approval request');
  }

  const transient = (err: any) =>
    !(err instanceof HttpStatusError) || err.status >= 500 || err.status === 408 || err.status === 429;

  async function cancel(id: string, reason: string): Promise<void> {
    try {
      await call('POST', `/api/agent/orchestration/approvals/${encodeURIComponent(id)}/cancel`, { agent_id: opts.agentId, reason }, 10_000);
    } catch (err: any) {
      log(`[approval] cancel ${id.slice(0, 8)} failed: ${err?.message ?? err}`);
    }
  }

  return {
    async request(prompt: ApprovalPrompt, signal?: AbortSignal): Promise<ApprovalOutcome> {
      // 1. Hand the prompt to AWB. Re-sends are idempotent on the request key.
      let view: WireView | null = null;
      const sendStarted = Date.now();
      for (let attempt = 0; !view; attempt++) {
        if (signal?.aborted) throw abortError();
        try {
          view = await call('POST', '/api/agent/orchestration/approvals', {
            room_id: opts.roomId,
            agent_id: opts.agentId,
            request_key: prompt.requestKey,
            tool_name: prompt.toolName,
            title: prompt.title ?? '',
            description: prompt.description ?? '',
            input: prompt.input ?? null,
            can_allow_session: prompt.canAllowSession,
          }, 30_000, signal);
        } catch (err: any) {
          if (signal?.aborted) throw abortError();
          if (!transient(err) || Date.now() - sendStarted > sendDeadlineMs) {
            log(`[approval] request for ${prompt.toolName} in room ${opts.roomId.slice(0, 8)} failed: ${err?.message ?? err}`);
            return { decision: 'deny', message: `Could not ask for approval (${err?.message ?? err}). Treat this action as denied.` };
          }
          await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(attempt, 4)), signal);
        }
      }
      log(`[approval] ${prompt.toolName} in room ${opts.roomId.slice(0, 8)} → ${view.id ? view.id.slice(0, 8) : '-'} ${view.status}`);
      const immediate = outcomeOf(view);
      if (immediate || !view.id) return immediate ?? { decision: 'deny', message: view.message || 'Not asked.' };

      // 2. Long-poll until someone answers. Every poll also tells AWB the session is still waiting.
      const id = view.id;
      const onAbort = () => void cancel(id, 'the requesting CLI session stopped waiting');
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        for (let failures = 0; ;) {
          if (signal?.aborted) throw abortError();
          try {
            const next: WireView = await call(
              'GET',
              `/api/agent/orchestration/approvals/${encodeURIComponent(id)}/wait?agent_id=${encodeURIComponent(opts.agentId)}&timeout_ms=${pollMs}`,
              undefined,
              pollMs + 15_000,
              signal,
            );
            failures = 0;
            const done = outcomeOf(next);
            if (done) {
              log(`[approval] ${id.slice(0, 8)} answered: ${done.decision}`);
              return done;
            }
          } catch (err: any) {
            if (signal?.aborted) throw abortError();
            if (!transient(err)) {
              log(`[approval] ${id.slice(0, 8)} wait refused: ${err?.message ?? err}`);
              return { decision: 'deny', message: `The approval request ended without an answer (${err?.message ?? err}).` };
            }
            failures += 1;
            await sleep(Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(failures, 4)), signal);
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
      }
    },
  };
}

/**
 * ACP runtimes (Hermes): turn a `session/request_permission` into an approval and pick the option
 * that matches the answer. ACP options carry their own kinds (`allow_once`, `allow_always`,
 * `reject_once`, …); a denial with no reject option is a cancel, which the runtime treats as "no".
 */
export function acpApprovalRelay(
  bridge: ApprovalBridge,
): (context: { runId: string }, request: AcpPermissionRequest) => Promise<AcpPermissionOutcome> {
  // Tool call ids are unique per call; the nonce keeps a call without one from colliding with an
  // earlier dispatch's request (AWB would hand back that old answer).
  const nonce = randomUUID().slice(0, 8);
  let seq = 0;
  return async (context, request) => {
    const options = Array.isArray(request.options) ? request.options : [];
    const allowOnce = options.find((o) => o.kind === 'allow_once');
    const allowAlways = options.find((o) => o.kind === 'allow_always' || o.kind === 'allow_session');
    const reject = options.find((o) => String(o.kind || '').startsWith('reject'));
    const toolCallId = String(request.toolCall?.toolCallId || request.subject?.toolCallId || '');
    const outcome = await bridge.request({
      requestKey: `${context.runId}:${toolCallId || `${nonce}-${++seq}`}`,
      toolName: String(request.toolCall?.kind || request.toolCall?.title || request.title || 'tool'),
      title: String(request.title || request.toolCall?.title || ''),
      description: String(request.description || ''),
      input: request.toolCall ?? null,
      canAllowSession: !!allowAlways,
    });
    if (outcome.decision === 'deny') {
      return reject ? { outcome: 'selected', optionId: reject.optionId } : { outcome: 'cancelled' };
    }
    const chosen = (outcome.decision === 'allow_session' ? allowAlways : undefined) ?? allowOnce ?? allowAlways;
    return chosen ? { outcome: 'selected', optionId: chosen.optionId } : { outcome: 'cancelled' };
  };
}
