/**
 * ClassificationBridgeService — in-memory bridge from `record_outreach_
 * classification` (an MCP tool call landing on a LATER, separate request)
 * back to the AgentDispatchClassifier.classify() call that is still awaiting
 * it in THIS process.
 *
 * This is a deliberate, narrow exception to how every other "dispatch an
 * agent, get a result later" flow in this codebase works. comment-summary /
 * Action run / QA run / Security run all split into two fully decoupled
 * calls: a `start_*`/`run_action` that creates a ChatRoom + run row and
 * returns immediately, and a `complete_*` that lands later and only ever
 * writes DB state — nothing in-process ever awaits the agent, so a dead
 * agent just leaves a DB row stuck until a background reaper sweeps it
 * (SecurityRunReaperService / QaRunReaperService). That shape doesn't fit
 * here: OutreachClassifier.classify() is `Promise<ClassificationResult>` —
 * a single call that must resolve to an answer — so the wait has to live
 * somewhere. This bridge is that "somewhere," kept deliberately local to
 * this one caller rather than generalized, because:
 *
 *   - The timeout passed to register() IS the cleanup — when it fires, the
 *     pending entry is dropped right here. Unlike Security/QA runs there is
 *     no separate consumer that could still be waiting on this row past the
 *     timeout, so no reaper sweep is needed. The other cleanup path is
 *     cancel(): the caller uses it when it gives up on a run *before* the
 *     timeout (dispatch itself failed, so the agent was never actually told
 *     the run_id and will never call report() for it) — without it, a run of
 *     dispatch failures would each sit in `pending` for up to timeoutMs.
 *   - It is NOT durable: a server restart drops every pending entry (same
 *     tradeoff FsBrowserService — apps/server/src/services/fs-browser.service.ts
 *     — accepts for its own in-memory request map). That's safe here
 *     specifically because OutreachIngestService only commits the claim row
 *     AFTER classify() resolves (see outreach-ingest.service.ts's docstring)
 *     — a crash mid-wait leaves nothing committed, so the item is simply
 *     retried on the channel's next poll.
 *   - It only works when the process that dispatched the classification and
 *     the process whose MCP endpoint receives the report are the SAME Node
 *     process. True for the NestJS-integrated `/mcp` route (where
 *     OutreachPollingService's tick loop also lives); NOT true for the
 *     standalone mcp-server.ts entry point or a horizontally-scaled
 *     multi-instance deployment — both already-unsupported for every other
 *     DI-only MCP service (see ToolContext's optional-service doc comments).
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { OutreachCategory } from './types';

export interface ClassificationReport {
  category: OutreachCategory;
  confidence: number;
}

interface PendingEntry {
  agentId: string;
  resolve: (report: ClassificationReport) => void;
  timer: ReturnType<typeof setTimeout>;
}

@Injectable()
export class ClassificationBridgeService {
  private readonly pending = new Map<string, PendingEntry>();

  /**
   * Register a wait for `agentId` to report back within `timeoutMs`. Returns
   * the run id to embed in the dispatch prompt plus the promise to await —
   * resolves with the report, or `null` if nobody reported in time.
   */
  register(agentId: string, timeoutMs: number): { runId: string; result: Promise<ClassificationReport | null> } {
    const runId = randomUUID();
    const result = new Promise<ClassificationReport | null>((resolve) => {
      // classify()'s caller always awaits this promise for a real result —
      // unref'ing let the timeout go unfulfilled whenever it was the last
      // thing holding the event loop open (same class as fc917f2b's
      // process-tree.ts delay(): Node's test runner reports it as "Promise
      // resolution is still pending but the event loop has already
      // resolved"). Outside tests this is a live hang risk too, not just a
      // CI artifact — an idle process has nothing else to keep the timer
      // alive. Keep it ref'd so the wait is deterministic; graceful-shutdown
      // duration is bounded by the SIGTERM/SIGINT path, not by this timer.
      const timer = setTimeout(() => {
        if (this.pending.delete(runId)) resolve(null);
      }, timeoutMs);
      this.pending.set(runId, {
        agentId,
        timer,
        resolve: (report) => {
          clearTimeout(timer);
          resolve(report);
        },
      });
    });
    return { runId, result };
  }

  /**
   * Called by the record_outreach_classification MCP tool. Returns false
   * when `runId` is unknown (already resolved, already timed out, or never
   * existed) or `agentId` doesn't match who it was dispatched to — the
   * caller surfaces either as a plain "not found" error, never a crash.
   */
  report(runId: string, agentId: string, category: OutreachCategory, confidence: number): boolean {
    const entry = this.pending.get(runId);
    if (!entry || entry.agentId !== agentId) return false;
    this.pending.delete(runId);
    entry.resolve({ category, confidence });
    return true;
  }

  /**
   * Drop a pending entry without resolving it. Called by the dispatcher when
   * it gives up on `runId` before report()/timeout — e.g. the dispatch call
   * itself threw, so the agent was never actually told the run_id and will
   * never report on it. Clears the timer so the entry doesn't linger in
   * `pending` for up to timeoutMs; a no-op if `runId` is already gone
   * (reported or timed out first).
   */
  cancel(runId: string): void {
    const entry = this.pending.get(runId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(runId);
  }

  /** Test/observability seam — never used on a live request path. */
  pendingCount(): number {
    return this.pending.size;
  }
}
