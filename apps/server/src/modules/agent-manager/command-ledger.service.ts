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

/**
 * 매니저가 `/command/ack` 로 보고한 한 커맨드의 종단 결과 (ticket 40110b64).
 *
 * `consume()` 가 원장 레코드를 지워 버리므로, 그것만으로는 "그 커맨드가 어떻게
 * 끝났는지" 를 나중에 물어볼 수단이 없다. 디스패치 202 응답은 수락 신호일 뿐이라
 * UI 가 완료를 판정하려면 발급한 `command_id` 와 그 커맨드의 ack 를 명시적으로
 * 상관시켜야 한다 — 하트비트 도착 같은 간접 신호로 대신하면 커맨드와 무관한 정기
 * 하트비트가 조건을 충족시켜 "완료" 를 오표시한다.
 */
export interface CommandOutcome {
  command_id: string;
  instance_id: string;
  /** Manager Agent identity the dispatch was scoped to. */
  agent_id: string;
  command: string;
  status: 'ok' | 'error';
  /** 매니저가 보고한 사람이 읽는 결과 문자열 (최대 2000자, 없으면 빈 문자열). */
  detail: string;
  issued_at: string;
  acked_at: string;
  expires_at: number;
}

const RECORD_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

@Injectable()
export class CommandLedgerService implements OnModuleDestroy {
  private readonly records = new Map<string, CommandRecord>();
  /** ack 를 받은 커맨드의 종단 결과. 레코드와 같은 TTL 로 만료된다. */
  private readonly outcomes = new Map<string, CommandOutcome>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(metrics: MemoryMetricsRegistry) {
    metrics.register('agentManager.commandRecords', () => this.records.size);
    metrics.register('agentManager.commandOutcomes', () => this.outcomes.size);
    this.timer = setInterval(() => this.sweep(), SWEEP_INTERVAL_MS);
    if (this.timer && typeof (this.timer as any).unref === 'function') {
      (this.timer as any).unref();
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.records.clear();
    this.outcomes.clear();
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

  /**
   * ack 수용 직후 그 커맨드의 결과를 남긴다 (ticket 40110b64). `consume()` 이
   * 레코드를 지운 **바로 다음** 동기 구간에서 불려야 한다 — 그 사이에 await 가
   * 끼면 폴링 중인 클라이언트가 레코드도 결과도 없는 순간을 만나 "알 수 없음"
   * 으로 오판한다.
   */
  recordOutcome(record: CommandRecord, status: 'ok' | 'error', detail: string): void {
    this.outcomes.set(record.command_id, {
      command_id: record.command_id,
      instance_id: record.instance_id,
      agent_id: record.agent_id,
      command: record.command,
      status,
      detail,
      issued_at: record.issued_at,
      acked_at: new Date().toISOString(),
      expires_at: Date.now() + RECORD_TTL_MS,
    });
  }

  getOutcome(command_id: string): CommandOutcome | null {
    const out = this.outcomes.get(command_id);
    if (!out) return null;
    if (Date.now() > out.expires_at) {
      this.outcomes.delete(command_id);
      return null;
    }
    return out;
  }

  size(): number {
    return this.records.size;
  }

  outcomeSize(): number {
    return this.outcomes.size;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, rec] of this.records) {
      if (now > rec.expires_at) this.records.delete(id);
    }
    for (const [id, out] of this.outcomes) {
      if (now > out.expires_at) this.outcomes.delete(id);
    }
  }
}
