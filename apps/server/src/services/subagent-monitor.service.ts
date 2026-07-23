import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, IsNull, LessThan, DataSource, EntityManager } from 'typeorm';
import { Subagent } from '../entities/Subagent';
import { SubagentLogLine } from '../entities/SubagentLogLine';
import { AgentUsageDailyRollup } from '../entities/AgentUsageDailyRollup';
import { activityEvents } from './activity.service';
import { LogService } from './log.service';
import { MemoryMetricsRegistry } from './memory-metrics.registry';

/**
 * Persistent registry + live transcript bus for plugin-spawned subagents.
 *
 * The plugin posts (a) a registration when it spawns a Claude CLI subagent,
 * (b) every stream-json line in/out, (c) an end record when the process exits,
 * and (d) a periodic reconcile call listing the subagent_ids it currently has
 * alive. End and reconcile-driven termination both stamp expires_at = now +
 * retentionMs; the sweep DELETEs rows past expires_at and the FK CASCADE drops
 * the associated log lines.
 *
 * Why DB-backed (was in-memory):
 *   - Survives server restarts, so the UI keeps the transcript while the
 *     plugin process is still alive.
 *   - Reconcile path closes the gap left by plugin crashes: previously a
 *     half-finished run sat in memory until the proxy restarted; now it is
 *     marked ended on the next reconcile tick and reaped 48h later.
 */

export type SubagentKind = 'chat' | 'ticket' | 'oneshot';

export interface SubagentSummary {
  subagent_id: string;
  agent_id: string;
  workspace_id: string;
  kind: SubagentKind;
  session_key: string;
  pid: number;
  started_at: string;
  label?: string;
  ended_at?: string;
  exit_code?: number | null;
  signal?: string | null;
  duration_ms?: number;
  line_count: number;
  // ISO-8601 timestamp at which the ended record will be purged by the sweep.
  // Only set once `ended_at` is set; undefined while the subagent is live.
  expires_at?: string;
  // Ticket-kind subagents carry both fields so the UI can render
  // "Ticket title · reviewer" instead of an opaque session key. Optional
  // because chat/oneshot subagents leave them undefined.
  ticket_id?: string;
  ticket_title?: string;
  role?: string;
}

export interface SubagentLogLineDto {
  direction: 'in' | 'out';
  line: string;
  ts: string;
}

// Token/cost usage the agent-manager reports on the `end` POST (ticket
// 6dd3f968). All fields optional/nullable — a pre-6dd3f968 manager build
// sends no `usage` key at all, and even an instrumented run may not have a
// figure for every field (Codex has no cost concept; Antigravity has none of
// this at all). Every numeric field is independently nullable so aggregation
// can tell "the CLI reported zero" apart from "never instrumented".
export interface SubagentEndUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  total_cost_usd?: number | null;
  model?: string | null;
}

// Sanity ceilings for a single run's reported usage — generous enough for any
// legitimate long multi-turn session, but tight enough to reject a corrupt/
// adversarial payload before it poisons a SUM aggregate. A negative value or
// one past the ceiling is treated as "not reported" (null) rather than
// clamped-and-kept, since a value this implausible carries no useful signal.
const MAX_TOKEN_COUNT = 50_000_000;
const MAX_COST_USD = 1000;
const MAX_MODEL_LEN = 100;

const DEFAULT_ENDED_RETENTION_HOURS = 48;
function endedRetentionMs(): number {
  const raw = process.env.SUBAGENT_ENDED_RETENTION_HOURS;
  const hours = raw ? Number(raw) : DEFAULT_ENDED_RETENTION_HOURS;
  if (!Number.isFinite(hours) || hours < 0) return DEFAULT_ENDED_RETENTION_HOURS * 3_600_000;
  return hours * 3_600_000;
}

@Injectable()
export class SubagentMonitorService {
  private readonly retentionMs = endedRetentionMs();
  // appendLines runs `read line_count → INSERT N lines → UPDATE line_count`,
  // which is racy if two appends for the same subagent overlap. Plugin posts
  // are serialized per subagent today (one-shot taps and session managers
  // each flush behind a single batch timer), but the chain guards against a
  // future change shipping concurrent posts and corrupting `seq`.
  private readonly appendLocks = new Map<string, Promise<unknown>>();

  // _sweepEnded()용 재진입 가드 — 근거는 해당 메서드 docstring 참고.
  private isSweeping = false;

  constructor(
    @InjectRepository(Subagent) private readonly subagents: Repository<Subagent>,
    @InjectRepository(SubagentLogLine) private readonly lines: Repository<SubagentLogLine>,
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
    // 중간이 아니라 맨 뒤에 추가한 이유 — subagent-appendlocks-eviction.test.mjs의
    // 기존 위치 인자 픽스처(`new MonitorClass(subagents, lines, logService,
    // registry)`)가 수정 없이 그대로 바인딩되게 하기 위함. 그 테스트는
    // 이 필드를 쓰는 유일한 메서드인 `_sweepEnded`/`_rollupBeforeDelete`를
    // 전혀 실행하지 않는다.
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    // appendLocks is the highest-churn in-memory map in this service: one
    // transient entry per (concurrently-appending) subagentId. With the
    // _serialize self-eviction working it should sit at ~0 at rest; a
    // non-zero steady-state reading on /api/diagnostics/memory is the early
    // warning that the eviction guard regressed again (see the dead-guard
    // leak fixed for ticket 59090d37).
    metrics.register('subagent.appendLocks', () => this.appendLocks.size);
    setInterval(() => {
      this._sweepEnded().catch((err) =>
        this.logService.warn('SubagentMonitor', `sweep failed: ${err.message}`),
      );
    }, 5 * 60_000).unref?.();
  }

  async register(input: {
    subagent_id: string;
    agent_id: string;
    workspace_id: string;
    kind: SubagentKind;
    session_key: string;
    pid: number;
    started_at?: string;
    label?: string;
    ticket_id?: string;
    ticket_title?: string;
    role?: string;
  }): Promise<SubagentSummary> {
    const startedAt = input.started_at ? new Date(input.started_at) : new Date();
    // Re-register of an existing id is a no-op for idempotency: the plugin
    // POSTs `register` fire-and-forget, and a transient retry must not
    // overwrite line_count / ended_at on a record that has been making
    // progress in the meantime.
    const existing = await this.subagents.findOne({ where: { subagent_id: input.subagent_id } });
    if (existing) {
      return this._summary(existing);
    }
    const row = this.subagents.create({
      subagent_id: input.subagent_id,
      agent_id: input.agent_id,
      workspace_id: input.workspace_id,
      kind: input.kind,
      session_key: input.session_key || '',
      pid: input.pid || 0,
      started_at: startedAt,
      label: input.label ?? null,
      ticket_id: input.ticket_id ?? null,
      ticket_title: input.ticket_title ?? null,
      role: input.role ?? null,
      ended_at: null,
      exit_code: null,
      signal: null,
      duration_ms: null,
      expires_at: null,
      line_count: 0,
    });
    await this.subagents.save(row);
    const summary = this._summary(row);
    activityEvents.emit('subagent_registered', { ...summary });
    this.logService.info(
      'SubagentMonitor',
      `registered ${row.kind} subagent ${row.subagent_id} for agent ${row.agent_id} (${row.session_key})`,
    );
    return summary;
  }

  async appendLines(
    subagentId: string,
    expectedAgentId: string,
    incoming: Array<{ direction: 'in' | 'out'; line: string; ts?: string }>,
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!incoming || incoming.length === 0) return { ok: true };
    const run = async () => {
      const rec = await this.subagents.findOne({ where: { subagent_id: subagentId } });
      if (!rec) return { ok: false as const, reason: 'unknown subagent_id' };
      if (rec.agent_id !== expectedAgentId) return { ok: false as const, reason: 'agent mismatch' };

      const baseSeq = rec.line_count;
      const rows: SubagentLogLine[] = [];
      const events: Array<{ direction: 'in' | 'out'; line: string; ts: string }> = [];
      let i = 0;
      for (const entry of incoming) {
        const ts = entry.ts ? new Date(entry.ts) : new Date();
        rows.push(this.lines.create({
          subagent_id: rec.subagent_id,
          seq: baseSeq + i + 1,
          direction: entry.direction,
          line: entry.line,
          ts,
        }));
        events.push({ direction: entry.direction, line: entry.line, ts: ts.toISOString() });
        i++;
      }
      await this.lines.save(rows);
      rec.line_count = baseSeq + rows.length;
      await this.subagents.update({ subagent_id: rec.subagent_id }, { line_count: rec.line_count });

      for (const evt of events) {
        activityEvents.emit('subagent_log', {
          subagent_id: rec.subagent_id,
          agent_id: rec.agent_id,
          workspace_id: rec.workspace_id,
          direction: evt.direction,
          line: evt.line,
          ts: evt.ts,
        });
      }
      return { ok: true as const };
    };
    return this._serialize(subagentId, run);
  }

  async end(input: {
    subagent_id: string;
    agent_id: string;
    exit_code?: number | null;
    signal?: string | null;
    usage?: SubagentEndUsage | null;
  }): Promise<{ ok: boolean; reason?: string }> {
    const rec = await this.subagents.findOne({ where: { subagent_id: input.subagent_id } });
    if (!rec) return { ok: false, reason: 'unknown subagent_id' };
    if (rec.agent_id !== input.agent_id) return { ok: false, reason: 'agent mismatch' };
    if (rec.ended_at) return { ok: true }; // idempotent — usage from a resend is dropped, same as exit_code/signal

    const endedAt = new Date();
    const durationMs = endedAt.getTime() - new Date(rec.started_at).getTime();
    const expiresAt = new Date(endedAt.getTime() + this.retentionMs);
    const usage = this._sanitizeUsage(input.usage);
    rec.ended_at = endedAt;
    rec.exit_code = input.exit_code ?? null;
    rec.signal = input.signal ?? null;
    rec.duration_ms = durationMs;
    rec.expires_at = expiresAt;
    Object.assign(rec, usage);
    await this.subagents.update(
      { subagent_id: rec.subagent_id },
      {
        ended_at: endedAt,
        exit_code: rec.exit_code,
        signal: rec.signal,
        duration_ms: durationMs,
        expires_at: expiresAt,
        ...usage,
      },
    );
    activityEvents.emit('subagent_ended', {
      subagent_id: rec.subagent_id,
      agent_id: rec.agent_id,
      workspace_id: rec.workspace_id,
      exit_code: rec.exit_code,
      signal: rec.signal,
      duration_ms: durationMs,
      ended_at: endedAt.toISOString(),
      expires_at: expiresAt.toISOString(),
    });
    return { ok: true };
  }

  /**
   * Plugin reports the full set of subagent_ids it currently has alive. Any
   * record we have for this agent that isn't in that set — and isn't already
   * ended — gets stamped ended with signal='disappeared'. The 48h retention
   * countdown begins from this moment, so the row is reaped on a later sweep.
   *
   * Empty live_subagent_ids is the post-restart case: plugin lost its tap
   * registry and reports zero, server marks every previously-registered live
   * record for that agent as disappeared.
   */
  async reconcile(agentId: string, liveSubagentIds: string[]): Promise<{ ended: number }> {
    const live = new Set(liveSubagentIds.filter((s): s is string => typeof s === 'string' && s.length > 0));
    // Pull only live records (ended_at IS NULL) for this agent so reconcile
    // doesn't churn through long-retained ended history.
    const candidates = await this.subagents.find({
      where: { agent_id: agentId, ended_at: IsNull() },
    });
    const stale = candidates.filter((c) => !live.has(c.subagent_id));
    if (stale.length === 0) return { ended: 0 };

    const endedAt = new Date();
    const expiresAt = new Date(endedAt.getTime() + this.retentionMs);
    for (const rec of stale) {
      const durationMs = endedAt.getTime() - new Date(rec.started_at).getTime();
      await this.subagents.update(
        { subagent_id: rec.subagent_id },
        {
          ended_at: endedAt,
          signal: 'disappeared',
          duration_ms: durationMs,
          expires_at: expiresAt,
        },
      );
      activityEvents.emit('subagent_ended', {
        subagent_id: rec.subagent_id,
        agent_id: rec.agent_id,
        workspace_id: rec.workspace_id,
        exit_code: null,
        signal: 'disappeared',
        duration_ms: durationMs,
        ended_at: endedAt.toISOString(),
        expires_at: expiresAt.toISOString(),
      });
    }
    this.logService.info(
      'SubagentMonitor',
      `reconcile: ${stale.length} stale subagent(s) marked disappeared for agent=${agentId}`,
    );
    return { ended: stale.length };
  }

  /** All current records (active + recently-ended) for a workspace. */
  async listForWorkspace(workspaceId: string): Promise<SubagentSummary[]> {
    const rows = await this.subagents.find({
      where: { workspace_id: workspaceId },
      order: { started_at: 'DESC' },
    });
    return rows.map((r) => this._summary(r));
  }

  async getTranscript(
    subagentId: string,
    workspaceId: string,
  ): Promise<{ summary: SubagentSummary; lines: SubagentLogLineDto[] } | null> {
    const rec = await this.subagents.findOne({ where: { subagent_id: subagentId } });
    if (!rec || rec.workspace_id !== workspaceId) return null;
    const lineRows = await this.lines.find({
      where: { subagent_id: subagentId },
      order: { seq: 'ASC' },
    });
    const lines = lineRows.map((l) => ({
      direction: l.direction as 'in' | 'out',
      line: l.line,
      ts: l.ts.toISOString(),
    }));
    return { summary: this._summary(rec), lines };
  }

  /**
   * Validate + clamp the optional `usage` block on an `end` POST (ticket
   * 6dd3f968) into the exact Subagent column shape. A malformed/out-of-range
   * value is dropped to null rather than clamped-and-kept — a bad reading is
   * not a useful lower/upper bound once it's this implausible. Never throws;
   * an adversarial or buggy payload degrades to "not reported", same as an
   * older manager build that sends no `usage` key at all.
   */
  private _sanitizeUsage(usage: SubagentEndUsage | null | undefined): {
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_input_tokens: number | null;
    cache_creation_input_tokens: number | null;
    total_cost_usd: number | null;
    usage_model: string | null;
  } {
    const count = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_TOKEN_COUNT) return null;
      return Math.round(v);
    };
    const cost = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_COST_USD) return null;
      return v;
    };
    const model = (v: unknown): string | null => {
      if (typeof v !== 'string') return null;
      const trimmed = v.trim();
      if (!trimmed) return null;
      return trimmed.length > MAX_MODEL_LEN ? trimmed.slice(0, MAX_MODEL_LEN) : trimmed;
    };
    return {
      input_tokens: count(usage?.input_tokens),
      output_tokens: count(usage?.output_tokens),
      cache_read_input_tokens: count(usage?.cache_read_input_tokens),
      cache_creation_input_tokens: count(usage?.cache_creation_input_tokens),
      total_cost_usd: cost(usage?.total_cost_usd),
      usage_model: model(usage?.model),
    };
  }

  private _summary(r: Subagent): SubagentSummary {
    return {
      subagent_id: r.subagent_id,
      agent_id: r.agent_id,
      workspace_id: r.workspace_id,
      kind: r.kind as SubagentKind,
      session_key: r.session_key || '',
      pid: r.pid,
      started_at: r.started_at.toISOString(),
      label: r.label ?? undefined,
      ended_at: r.ended_at ? r.ended_at.toISOString() : undefined,
      exit_code: r.exit_code,
      signal: r.signal,
      duration_ms: r.duration_ms ?? undefined,
      line_count: r.line_count,
      expires_at: r.expires_at ? r.expires_at.toISOString() : undefined,
      ticket_id: r.ticket_id ?? undefined,
      ticket_title: r.ticket_title ?? undefined,
      role: r.role ?? undefined,
    };
  }

  private async _serialize<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prior = this.appendLocks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const next = new Promise<void>((resolve) => { release = resolve; });
    // The value stored under `key` is the CHAINED promise (prior → next), not
    // `next` itself — the next caller awaits this chain so its run starts only
    // after ours releases, preserving per-subagent serialization. Cleanup must
    // therefore compare against `chained`: the previous code compared the map
    // head against `next`, which is never the stored value, so the guard was
    // dead and every subagentId left a permanent entry (prod OOM, ticket
    // 59090d37). Keep both bindings identical.
    const chained = prior.then(() => next);
    this.appendLocks.set(key, chained);
    try {
      await prior;
      return await fn();
    } finally {
      release();
      // Best-effort cleanup so the map doesn't grow unboundedly with finished
      // subagents. Only delete if the head is still ours — a later overlapping
      // append for the same key will have replaced it, and that caller owns
      // the eviction.
      if (this.appendLocks.get(key) === chained) this.appendLocks.delete(key);
    }
  }

  /**
   * 재진입 가드 — 한 번의 실행이 5분 tick 주기를 넘기면 다음 setInterval
   * 콜백이 겹쳐 발동할 수 있다(ticket 3c6422f1, 8d5c6f5d 리뷰 관찰). insert
   * 경로는 롤업 테이블의 `(workspace_id, usage_date, agent_id)` unique
   * 제약이 막아주지만(경합한 쪽이 충돌로 롤백 후 다음 tick이 재시도 —
   * 시끄럽지만 무손실), update 경로(같은 grain에 기존 row가 있을 때
   * `_rollupBeforeDelete`의 read-modify-write 증분)는 두 트랜잭션이 동시에
   * 돌면 격리 수준에 따라 한쪽 증분이 유실될 수 있다(과다가 아니라
   * **과소집계** 방향). `isSweeping`으로 겹친 두 번째 실행을 통째로 skip해
   * 이 창을 없앤다 — 그 배치는 아직 stale 상태 그대로 남아 다음 tick이
   * 마저 reap한다(유실이 아니라 지연일 뿐).
   */
  private async _sweepEnded() {
    if (this.isSweeping) {
      this.logService.warn('SubagentMonitor', 'sweep: previous run still in progress, skipping this tick');
      return;
    }
    this.isSweeping = true;
    try {
      const now = new Date();
      // expires_at < now 필터를 SQL에서 걸어 매 tick마다 풀-테이블 읽기가
      // 앱 메모리로 번지지 않게 한다. expires_at은 live record에서 null이므로
      // 인덱스 히트는 reap/ended row만 건드린다. usage + 귀속 컬럼들도 id와
      // 함께 끌어와서 아래 롤업 접기(ticket 8d5c6f5d)가 별도 쿼리 없이
      // 필요한 걸 갖도록 한다.
      const stale = await this.subagents.find({
        where: { expires_at: LessThan(now) },
        select: [
          'subagent_id', 'workspace_id', 'agent_id', 'started_at',
          'input_tokens', 'output_tokens', 'cache_read_input_tokens',
          'cache_creation_input_tokens', 'total_cost_usd',
        ],
      });
      if (stale.length === 0) return;
      const ids = stale.map((r) => r.subagent_id);

      // 삭제 예정인 usage를 일별 롤업에 접어 넣은 뒤, lines를 지우고, 그 다음
      // subagent row를 지운다 — 이 세 write를 전부 **하나의 트랜잭션**으로
      // 묶는다(ticket 8d5c6f5d). tick 전체가 커밋되거나(롤업 증분 + lines
      // 삭제 + subagents 삭제) 아무것도 안 되거나 둘 중 하나라서, 어떤 row도
      // "live도 아니고 rolled up도 아닌" 상태로 관측될 수 없고 중간에 크래시가
      // 나도 재시도 시 이중 카운트가 안 된다(다음 tick이 여전히 live인 같은
      // row들을 다시 읽을 뿐이다). lines를 subagents보다 먼저 지우는 순서는
      // 그대로 유지 — 기존과 같은 FK 안전성 이유(fresh-sync 스키마에서 CASCADE가
      // 지연될 수 있음)이고, 이제 두 개의 단순 statement가 아니라 트랜잭션
      // 안에서 실행된다는 점만 다르다.
      await this.dataSource.transaction(async (manager) => {
        await this._rollupBeforeDelete(manager, stale);
        await manager.delete(SubagentLogLine, { subagent_id: In(ids) });
        await manager.delete(Subagent, { subagent_id: In(ids) });
      });

      this.logService.info('SubagentMonitor', `sweep: deleted ${ids.length} expired subagent record(s)`);
    } finally {
      this.isSweeping = false;
    }
  }

  /**
   * 곧 reap될 배치를 (workspace_id, usage_date, agent_id)로 묶는다 —
   * `usage_date`는 `started_at`의 UTC 달력 날짜 — 그리고 각 그룹의 합계를
   * `AgentUsageDailyRollup`에 접어 넣는다(기존 row가 있으면 증분, 없으면
   * 신규 삽입). 배치의 delete와 같은 트랜잭션 안에서 호출된다(`_sweepEnded`
   * 참고): 어떤 run도 `subagents`와 이 테이블 중 정확히 한쪽에만 있을 뿐
   * 둘 다이거나 둘 다 아닌 경우가 없다 — `AgentUsageService.
   * getLongTermUsageStats`가 마진/cutoff 로직 없이 두 테이블을 합산할 수
   * 있는 것은 이 불변식 덕분이다.
   *
   * `GROUP BY DATE(started_at)` SQL 쿼리 대신 순수 JS 집계를 쓴 이유: 날짜
   * 함수 문법과 저장 포맷이 sqlite/postgres 사이에 다르고, 이렇게 하면
   * 집계된 row-set이 호출부가 곧 지울 row-set과 정확히 같다는 걸 증명할 수
   * 있다(둘 다 같은 `rows` 배열을 순회하므로).
   */
  private async _rollupBeforeDelete(
    manager: EntityManager,
    rows: Array<Pick<
      Subagent,
      | 'workspace_id' | 'agent_id' | 'started_at'
      | 'input_tokens' | 'output_tokens'
      | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'total_cost_usd'
    >>,
  ): Promise<void> {
    interface Group {
      workspace_id: string;
      usage_date: string;
      agent_id: string;
      runs_total: number;
      runs_with_usage: number;
      priced_runs: number;
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens: number;
      cache_creation_input_tokens: number;
      total_cost_usd: number;
    }
    const groups = new Map<string, Group>();
    for (const r of rows) {
      const usageDate = r.started_at.toISOString().slice(0, 10);
      const key = `${r.workspace_id}|${usageDate}|${r.agent_id}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          workspace_id: r.workspace_id, usage_date: usageDate, agent_id: r.agent_id,
          runs_total: 0, runs_with_usage: 0, priced_runs: 0,
          input_tokens: 0, output_tokens: 0,
          cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
          total_cost_usd: 0,
        };
        groups.set(key, g);
      }
      g.runs_total += 1;
      if (r.input_tokens != null) g.runs_with_usage += 1;
      if (r.total_cost_usd != null) g.priced_runs += 1;
      g.input_tokens += r.input_tokens ?? 0;
      g.output_tokens += r.output_tokens ?? 0;
      g.cache_read_input_tokens += r.cache_read_input_tokens ?? 0;
      g.cache_creation_input_tokens += r.cache_creation_input_tokens ?? 0;
      g.total_cost_usd += r.total_cost_usd ?? 0;
    }
    if (groups.size === 0) return;

    const rollupRepo = manager.getRepository(AgentUsageDailyRollup);
    for (const g of groups.values()) {
      const existing = await rollupRepo.findOne({
        where: { workspace_id: g.workspace_id, usage_date: g.usage_date, agent_id: g.agent_id },
      });
      if (existing) {
        existing.runs_total += g.runs_total;
        existing.runs_with_usage += g.runs_with_usage;
        existing.priced_runs += g.priced_runs;
        existing.input_tokens += g.input_tokens;
        existing.output_tokens += g.output_tokens;
        existing.cache_read_input_tokens += g.cache_read_input_tokens;
        existing.cache_creation_input_tokens += g.cache_creation_input_tokens;
        existing.total_cost_usd += g.total_cost_usd;
        await rollupRepo.save(existing);
      } else {
        await rollupRepo.save(rollupRepo.create(g));
      }
    }
  }
}
