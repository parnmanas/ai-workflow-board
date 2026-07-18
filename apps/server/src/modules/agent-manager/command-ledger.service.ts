import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

/**
 * In-memory record of dispatched `agent_manager_command` events, used to
 * verify that the API key acking the command belongs to the same manager
 * Agent identity that the command was dispatched to. Without this, the
 * `/api/agent-manager/command/ack` endpoint accepts any
 * `(command_id, status)` pair signed by any manager API key — a hostile
 * (or just buggy) manager could forge acks for someone else's command and
 * pollute the audit log.
 *
 * The ledger is intentionally in-memory and short-lived. A command that
 * outlives `RECORD_TTL_MS` without an ack is forgotten — a late ack beyond
 * that window is rejected as 410 Gone, which is the right behavior:
 * operators who care about a stale outcome should re-dispatch.
 */

export interface CommandRecord {
  command_id: string;
  instance_id: string;
  /** Manager Agent identity that the dispatch SSE was scoped to. */
  agent_id: string;
  command: string;
  /**
   * The MANAGED agent the command acts on (ticket 1f750878). For `spawn_agent`
   * this is `args.agent_id` — DISTINCT from `agent_id` above (the supervising
   * manager). Recorded server-side so the `/command/ack` handler can route a
   * spawn-failure ack to `markStartError(target_agent_id, …)` without the
   * manager having to echo it back (keeps the ack wire contract unchanged).
   * Undefined for verbs that don't target a specific managed agent.
   */
  target_agent_id?: string;
  issued_at: string;
  expires_at: number;
}

const RECORD_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class CommandLedgerService implements OnModuleDestroy {
  private readonly records = new Map<string, CommandRecord>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(metrics: MemoryMetricsRegistry) {
    metrics.register('agentManager.commandRecords', () => this.records.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.records.clear();
  }

  record(input: { command_id: string; instance_id: string; agent_id: string; command: string; issued_at: string; target_agent_id?: string }): void {
    this.records.set(input.command_id, {
      ...input,
      expires_at: Date.now() + RECORD_TTL_MS,
    });
  }

  get(command_id: string): CommandRecord | null {
    const rec = this.records.get(command_id);
    if (!rec) return null;
    if (Date.now() > rec.expires_at) {
      this.records.delete(command_id);
      return null;
    }
    return rec;
  }

  /**
   * One-shot consume: returns the record (or null if missing/expired) and
   * removes it from the ledger so a duplicate ack can't replay against the
   * same dispatch.
   */
  consume(command_id: string): CommandRecord | null {
    const rec = this.get(command_id);
    if (rec) this.records.delete(command_id);
    return rec;
  }

  size(): number {
    return this.records.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, rec] of this.records) {
      if (now > rec.expires_at) this.records.delete(id);
    }
  }
}
