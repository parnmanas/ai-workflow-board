/**
 * ManagerDriftMonitorService — version-drift / stale self-update health signal
 * (ticket 7485df07).
 *
 * Problem (silent self-update stall): when an agent-manager's background
 * self-update fails for ANY reason (network / git / build) the running
 * process keeps reporting `update_available = true` (it's behind the latest
 * published version) but nothing actively surfaces that. Today the only
 * signals are:
 *   - the transient `update_manager` SSE ack error — visible only to whoever
 *     happens to be watching at the moment the update was attempted; and
 *   - the passive `ManagerVersionBadge` on the admin dashboard — visible only
 *     to whoever happens to open the page.
 * The retro on the source ticket (dc38dce6) proved this is operationally
 * insufficient: a self-update stall sat **2 days unnoticed** before a manual
 * log inspection found it. There was no active alert and no persistent record.
 *
 * What this adds (the cheap, high-signal half): a server-side sweep over the
 * live manager instances in InstanceRegistryService. When a manager reports
 *   - `update_available === true`        (version drift — running behind), or
 *   - a non-empty `update_last_error`    (the periodic UpdateChecker itself is
 *                                          failing: fetch / remote-read error),
 * AND the condition has *persisted* past a threshold, the monitor emits:
 *   1. a deduped `logService.warn('AgentManager', …)` — high-signal and
 *      greppable in /admin/logs, re-emitted on a cooldown so it survives the
 *      2000-entry in-memory log ring rolling over; and
 *   2. a persistent `activity_logs` audit row — the durable record the retro
 *      said was missing, written directly via the repository (NOT through
 *      ActivityService, so it triggers no Discord / SSE fan-out).
 * When the condition clears (manager updated / checker recovered) the monitor
 * logs a one-line resolution and forgets the agent.
 *
 * Disappearance is NOT resolution (ticket bfc34cd5). 매니저 하트비트가 끊기면
 * InstanceRegistryService 가 90초 TTL 로 그 인스턴스를 스윕한다. 예전에는
 * `registry.list()` 에서 인스턴스가 사라진 것과 인스턴스는 살아있는데 조건만
 * 없어진 것을 구분하지 않아, 둘 다 "드리프트 해소"로 기록했다 — 나쁜 빌드가
 * fleet 을 죽이는 바로 그 순간 대시보드가 밝아지는, 정확히 반대 신호였다.
 * 이제 스윕은 세 갈래로 나뉜다:
 *   1. 인스턴스가 살아있고 조건만 사라짐  → 진짜 해소. 기존대로 조용히 기록.
 *   2. 추적 중이던 agent 의 인스턴스가 통째로 사라짐 → 경보로 승격 (WARN +
 *      감사 행). 드리프트/체커오류를 안고 있던 매니저만 해당되므로, 건강한
 *      매니저의 정상 종료·페어링 해제는 여기 걸리지 않는다.
 *   3. 추적한 적 없는 agent 가 사라짐 → 예전과 같이 아무 것도 하지 않는다
 *      (애초에 state 에 없어 순회 대상이 아니다).
 *
 * This compresses the silent-stall detection window from days → hours without
 * touching the heartbeat wire contract or the agent-manager: it
 * consumes data the manager already ships on every heartbeat.
 *
 * Persistence model: onset times are tracked in-process, keyed by the manager
 * Agent.id (stable across the manager's own self-update re-execs, where the
 * ephemeral instance_id churns). A server restart re-observes drift on the
 * next sweep and restarts the onset clock, so the worst-case post-restart
 * alert delay is one threshold window — acceptable for a safety net. The
 * durable artifact is the activity_logs row, which survives both the log ring
 * and a server restart.
 *
 * Scope notes:
 *   - Every accepted instance is a Runtime Host and participates in this check.
 *   - Install-mode aware (ticket 9c9b52eb): a 'git' checkout OR an 'npm-global'
 *     install both run a live UpdateChecker and can report update_available ===
 *     true, so both now participate in drift detection (npm-global self-updates
 *     via `npm i -g` on the Update button). Only an 'unknown'/vendored build
 *     (checker is a no-op, update_available stays false) never triggers.
 *   - A manager legitimately AHEAD of origin (dev branch, current > latest)
 *     has update_available === false → no false alert.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { LogService } from '../../services/log.service';
import { InstanceRegistryService, InstanceRecord } from './instance-registry.service';

const DEFAULTS = {
  ENABLED: true,
  SWEEP_MS: 10 * 60_000,          // 10 min — how often we re-evaluate
  DRIFT_THRESHOLD_MS: 2 * 60 * 60_000,  // 2 h — drift must persist this long
  ERROR_THRESHOLD_MS: 30 * 60_000,      // 30 min — a failing checker is more urgent
  REALERT_MS: 6 * 60 * 60_000,    // 6 h — cooldown between re-alerts for the
                                  //       same ongoing condition
} as const;

export interface DriftMonitorConfig {
  enabled: boolean;
  sweepMs: number;
  driftThresholdMs: number;
  errorThresholdMs: number;
  realertMs: number;
}

export function readConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DriftMonitorConfig {
  const parseMs = (raw: string | undefined, fallback: number): number => {
    if (raw == null || raw === '') return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  // 'false' / '0' / 'no' / 'off' disable; anything else (incl. unset) → default.
  const parseBool = (raw: string | undefined, fallback: boolean): boolean => {
    if (raw == null) return fallback;
    const v = raw.trim().toLowerCase();
    if (v === '') return fallback;
    if (['false', '0', 'no', 'off'].includes(v)) return false;
    return true;
  };
  return {
    enabled:          parseBool(env.MANAGER_DRIFT_MONITOR_ENABLED, DEFAULTS.ENABLED),
    sweepMs:          parseMs(env.MANAGER_DRIFT_SWEEP_MS,          DEFAULTS.SWEEP_MS),
    driftThresholdMs: parseMs(env.MANAGER_DRIFT_THRESHOLD_MS,      DEFAULTS.DRIFT_THRESHOLD_MS),
    errorThresholdMs: parseMs(env.MANAGER_DRIFT_ERROR_THRESHOLD_MS, DEFAULTS.ERROR_THRESHOLD_MS),
    realertMs:        parseMs(env.MANAGER_DRIFT_REALERT_MS,        DEFAULTS.REALERT_MS),
  };
}

// Exposed for unit tests so the spec can assert env parsing without touching
// the host environment.
export const __test__ = { readConfigFromEnv, DEFAULTS };

/** The two independent conditions we age separately. */
type DriftKind = 'drift' | 'error';

/** Per-agent onset + last-alert bookkeeping for one condition. */
interface ConditionState {
  /** When we first observed this condition continuously (ISO ms). */
  since: number;
  /** When we last emitted an alert for it, or 0 if never alerted yet. */
  lastAlertedAt: number;
}

/**
 * 마지막으로 관측된 인스턴스의 경보용 투영. agent 가 레지스트리에서 사라진
 * 뒤에는 InstanceRecord 를 다시 읽을 수 없으므로, 사라짐 경보의 문구와 감사
 * 행을 채울 근거는 이 스냅샷이 유일하다.
 */
interface LastSeenSnapshot {
  instance_id: string;
  hostname: string;
  plugin_version: string;
  latest_version: string | null;
  update_channel: string | null;
  update_last_error: string | null;
  /** 이 스냅샷을 마지막으로 갱신한 스윕 시각(ms). */
  at: number;
}

interface AgentDriftState {
  drift: ConditionState | null;
  error: ConditionState | null;
  /** 조건을 관측할 때마다 갱신. 사라짐 경보가 참조한다. */
  lastSeen: LastSeenSnapshot | null;
}

export interface DriftSweepStats {
  scanned: number;        // manager instances examined
  agents: number;         // distinct manager agents
  driftAlerts: number;    // drift alerts emitted this sweep
  errorAlerts: number;    // checker-error alerts emitted this sweep
  vanishedAlerts: number; // 이번 스윕에 통째로 사라진 추적 중이던 매니저 수
  resolved: number;       // conditions that cleared this sweep
  skipped_disabled: boolean;
}

@Injectable()
export class ManagerDriftMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly config: DriftMonitorConfig;
  private readonly state = new Map<string, AgentDriftState>();
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    private readonly registry: InstanceRegistryService,
    private readonly logService: LogService,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {
    this.config = readConfigFromEnv();
  }

  onModuleInit(): void {
    if (!this.config.enabled) {
      this.logService.info('AgentManager', 'ManagerDriftMonitor disabled via MANAGER_DRIFT_MONITOR_ENABLED=false', {
        config: this.config,
      });
      return;
    }
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('AgentManager', 'ManagerDriftMonitor sweep failed', { err: String(e) });
      });
    }, this.config.sweepMs);
    // Don't let the sweep timer keep the process alive — the Nest lifecycle
    // owns shutdown, same as the other detector services.
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('AgentManager', 'ManagerDriftMonitor sweep loop initialized', { config: this.config });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Test helper — read the loaded config so a spec can assert env parsing. */
  getConfig(): DriftMonitorConfig {
    return { ...this.config };
  }

  /**
   * One sweep over the live manager instances. Public + clock-injectable so a
   * unit test can drive threshold crossings, dedup, and resolution by advancing
   * `now` without real timers or a DB.
   */
  async sweep(now: Date = new Date()): Promise<DriftSweepStats> {
    const stats: DriftSweepStats = {
      scanned: 0, agents: 0, driftAlerts: 0, errorAlerts: 0, vanishedAlerts: 0, resolved: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;
    const nowMs = now.getTime();

    // Aggregate per agent_id: a manager Agent identity may be backed by more
    // than one live process (laptop + VM sharing a pairing code). Treat the
    // agent as drifting / erroring if ANY of its manager instances reports it,
    // and keep a representative instance for the alert text.
    const byAgent = new Map<string, { drift: InstanceRecord | null; error: InstanceRecord | null }>();
    // 프레즌스는 텔레메트리와 **무관하게** 별도로 모은다. 아래 `continue` 로
    // 걸러지는 구버전 매니저도 엄연히 살아있는 인스턴스이므로, "조건만 사라짐"과
    // "인스턴스가 통째로 사라짐"을 가르는 기준은 이 집합이어야 한다. byAgent 를
    // 그 기준으로 쓰면 텔레메트리 중단을 사라짐으로 오인한다.
    const liveAgentIds = new Set<string>();
    for (const inst of this.registry.list()) {
      liveAgentIds.add(inst.agent_id);
      // Managers that don't ship update-checker telemetry (pre-update builds)
      // leave update_available undefined — nothing to evaluate.
      if (inst.update_available === undefined && !inst.update_last_error) continue;
      stats.scanned += 1;
      const agg = byAgent.get(inst.agent_id) ?? { drift: null, error: null };
      if (inst.update_available === true && !agg.drift) agg.drift = inst;
      if (typeof inst.update_last_error === 'string' && inst.update_last_error.trim() && !agg.error) {
        agg.error = inst;
      }
      byAgent.set(inst.agent_id, agg);
    }
    stats.agents = byAgent.size;

    // Evaluate every agent we currently track OR currently see, so a condition
    // that just cleared (agent no longer drifting) is detected and forgotten.
    const agentIds = new Set<string>([...byAgent.keys(), ...this.state.keys()]);
    for (const agentId of agentIds) {
      const agg = byAgent.get(agentId) ?? { drift: null, error: null };
      const tracked: AgentDriftState = this.state.get(agentId) ?? { drift: null, error: null, lastSeen: null };

      // ── 사라짐(disappearance) 승격 ──────────────────────────────────
      // 추적 중이던 매니저의 인스턴스가 레지스트리에서 통째로 없어졌다면 이건
      // 해소가 아니다 — 하트비트가 끊겨 90초 TTL 로 스윕된 것이고, 나쁜 빌드가
      // fleet 을 죽이는 순간이 정확히 이 모양이다. `agentIds` 는 byAgent 와
      // this.state 의 합집합이므로, 여기 걸리는 agent 는 반드시 추적 중이던
      // (= 드리프트나 체커오류를 안고 있던) agent 다. 건강한 매니저는 애초에
      // state 에 없어 이 분기에 도달하지 않는다 — 정상 종료 오탐이 없는 이유.
      if (!liveAgentIds.has(agentId)) {
        this._emitVanished(agentId, tracked, nowMs, now);
        stats.vanishedAlerts += 1;
        // 한 번 쏘고 잊는다. 다음 스윕에는 registry 에도 state 에도 없으므로
        // 이 agent 는 순회 대상에서 아예 빠진다 → 스윕마다 중복 발화 없음.
        this.state.delete(agentId);
        continue;
      }

      let mutated = false;

      // 살아있는 동안의 마지막 관측을 계속 갱신해 둔다 — 사라진 뒤 경보 문구와
      // 감사 행이 참조할 유일한 근거다.
      const representative = agg.drift ?? agg.error;
      if (representative) {
        tracked.lastSeen = {
          instance_id: representative.instance_id,
          hostname: representative.hostname,
          plugin_version: representative.plugin_version,
          latest_version: representative.latest_version ?? null,
          update_channel: representative.update_channel ?? null,
          update_last_error: representative.update_last_error ?? null,
          at: nowMs,
        };
        mutated = true;
      }

      // ── drift ──
      const driftRes = this._evaluateCondition('drift', agentId, agg.drift, tracked.drift, nowMs, now);
      tracked.drift = driftRes.next;
      mutated = mutated || driftRes.mutated;
      if (driftRes.alerted) stats.driftAlerts += 1;
      if (driftRes.resolved) stats.resolved += 1;

      // ── checker error ──
      const errRes = this._evaluateCondition('error', agentId, agg.error, tracked.error, nowMs, now);
      tracked.error = errRes.next;
      mutated = mutated || errRes.mutated;
      if (errRes.alerted) stats.errorAlerts += 1;
      if (errRes.resolved) stats.resolved += 1;

      if (!tracked.drift && !tracked.error) {
        // Nothing left to remember for this agent.
        this.state.delete(agentId);
      } else if (mutated || !this.state.has(agentId)) {
        this.state.set(agentId, tracked);
      }
    }

    return stats;
  }

  /**
   * Pure-ish per-condition transition. Returns the next ConditionState (or null
   * when the condition is absent) plus flags for the sweep stats. Side effects
   * (log + audit row) are fired here so the threshold / cooldown decision and
   * the emission stay in one place.
   */
  private _evaluateCondition(
    kind: DriftKind,
    agentId: string,
    instance: InstanceRecord | null,
    prev: ConditionState | null,
    nowMs: number,
    now: Date,
  ): { next: ConditionState | null; alerted: boolean; resolved: boolean; mutated: boolean } {
    if (!instance) {
      // Condition absent this sweep. If we were tracking it, it just resolved.
      if (prev) {
        this._logResolved(kind, agentId, nowMs - prev.since);
        return { next: null, alerted: false, resolved: true, mutated: true };
      }
      return { next: null, alerted: false, resolved: false, mutated: false };
    }

    // Condition present. Establish / keep the onset clock.
    const since = prev?.since ?? nowMs;
    const ageMs = nowMs - since;
    const threshold = kind === 'drift' ? this.config.driftThresholdMs : this.config.errorThresholdMs;

    let lastAlertedAt = prev?.lastAlertedAt ?? 0;
    let alerted = false;
    let mutated = !prev; // first observation is a state change

    if (ageMs >= threshold) {
      const sinceLastAlert = lastAlertedAt > 0 ? nowMs - lastAlertedAt : Infinity;
      if (sinceLastAlert >= this.config.realertMs) {
        this._emitAlert(kind, instance, ageMs, now);
        lastAlertedAt = nowMs;
        alerted = true;
        mutated = true;
      }
    }

    return { next: { since, lastAlertedAt }, alerted, resolved: false, mutated };
  }

  /**
   * Emit the operator-facing WARN + the durable audit row. WARN first (best-
   * effort, but it's the high-signal line); the audit write is wrapped so a DB
   * hiccup can't swallow the alert or wedge the sweep.
   */
  private _emitAlert(kind: DriftKind, inst: InstanceRecord, ageMs: number, now: Date): void {
    const ageH = (ageMs / 3_600_000).toFixed(1);
    const who = `${inst.hostname} (agent ${inst.agent_id.slice(0, 8)})`;
    const channel = inst.update_channel || 'latest';

    let message: string;
    if (kind === 'drift') {
      message =
        `agent-manager version drift: ${who} running v${inst.plugin_version} has been behind ` +
        `latest v${inst.latest_version || '?'} on the ${channel} channel for ${ageH}h — ` +
        `self-update is not landing. ` +
        `Check the manager's update logs / re-run update_manager.`;
    } else {
      message =
        `agent-manager self-update checker failing: ${who} (v${inst.plugin_version}) has reported ` +
        `update-check errors for ${ageH}h — last_error: ${inst.update_last_error}. ` +
        `The manager cannot see new versions until this clears.`;
    }

    this.logService.warn('AgentManager', message, {
      kind: kind === 'drift' ? 'version_drift' : 'update_check_error',
      agent_id: inst.agent_id,
      instance_id: inst.instance_id,
      hostname: inst.hostname,
      current_version: inst.plugin_version,
      latest_version: inst.latest_version ?? null,
      update_channel: inst.update_channel ?? null,
      update_last_error: inst.update_last_error ?? null,
      age_hours: Number(ageH),
    });

    this._writeAuditRow({
      agentId: inst.agent_id,
      kind,
      action: kind === 'drift' ? 'agent_manager_drift' : 'agent_manager_update_error',
      fieldChanged: kind === 'drift' ? 'version_drift' : 'update_check_error',
      oldValue: String(inst.plugin_version || ''),
      payload: {
        instance_id: inst.instance_id,
        hostname: inst.hostname,
        current_version: inst.plugin_version,
        latest_version: inst.latest_version ?? null,
        update_channel: inst.update_channel ?? null,
        update_last_error: inst.update_last_error ?? null,
        age_hours: Number(ageH),
      },
      now,
    });
  }

  /**
   * 추적 중이던 매니저가 레지스트리에서 통째로 사라졌을 때의 경보 (ticket
   * bfc34cd5). `_emitAlert` 와 달리 살아있는 InstanceRecord 가 없으므로 마지막
   * 관측 스냅샷으로 문구를 채운다.
   *
   * dedupe: 발화 직후 호출부가 이 agent 의 state 를 지우므로 사라짐 1회당 정확히
   * 한 번만 발화한다 (`realertMs` 쿨다운은 "지속되는 조건"을 위한 것이라 여기엔
   * 해당이 없다 — 사라짐은 지속 상태가 아니라 단발 전이다).
   */
  private _emitVanished(agentId: string, tracked: AgentDriftState, nowMs: number, now: Date): void {
    const seen = tracked.lastSeen;
    const conditions: string[] = [];
    if (tracked.drift) conditions.push('version_drift');
    if (tracked.error) conditions.push('update_check_error');

    // 가장 먼저 시작된 조건을 기준으로 "이 상태로 얼마나 버티다 사라졌나"를 잰다.
    const onsets = [tracked.drift?.since, tracked.error?.since]
      .filter((v): v is number => typeof v === 'number');
    const ageMs = onsets.length ? nowMs - Math.min(...onsets) : 0;
    const ageH = (ageMs / 3_600_000).toFixed(1);
    const hostname = seen?.hostname || 'unknown-host';
    const who = `${hostname} (agent ${agentId.slice(0, 8)})`;
    const version = seen?.plugin_version || '?';

    this.logService.warn(
      'AgentManager',
      `agent-manager vanished while unhealthy: ${who} last reported v${version} with ` +
      `[${conditions.join(', ') || 'unknown'}] for ${ageH}h and has now stopped heartbeating — ` +
      `its instance aged out of the registry TTL. This is NOT a resolution: a failed ` +
      `self-update or a bad build that kills the manager on boot looks exactly like this. ` +
      `Check the host is up and the manager process is running. ` +
      `(A deliberate operator shutdown of an already-drifting manager produces the same signal.)`,
      {
        kind: 'manager_vanished',
        agent_id: agentId,
        instance_id: seen?.instance_id ?? null,
        hostname: seen?.hostname ?? null,
        current_version: seen?.plugin_version ?? null,
        latest_version: seen?.latest_version ?? null,
        update_channel: seen?.update_channel ?? null,
        update_last_error: seen?.update_last_error ?? null,
        unresolved_conditions: conditions,
        age_hours: Number(ageH),
        last_seen_sweep_at: seen ? new Date(seen.at).toISOString() : null,
      },
    );

    this._writeAuditRow({
      agentId,
      kind: 'vanished',
      action: 'agent_manager_vanished',
      fieldChanged: 'manager_vanished',
      oldValue: String(seen?.plugin_version || ''),
      payload: {
        instance_id: seen?.instance_id ?? null,
        hostname: seen?.hostname ?? null,
        current_version: seen?.plugin_version ?? null,
        latest_version: seen?.latest_version ?? null,
        update_channel: seen?.update_channel ?? null,
        update_last_error: seen?.update_last_error ?? null,
        unresolved_conditions: conditions,
        age_hours: Number(ageH),
        last_seen_sweep_at: seen ? new Date(seen.at).toISOString() : null,
      },
      now,
    });
  }

  /**
   * 영속 기록 — 소스 티켓 회고가 없다고 지적했던 바로 그 durable record.
   * ActivityService 가 아니라 repository 로 직접 저장하므로 감사 행으로만 남고
   * Discord / SSE 팬아웃을 일으키지 않는다. best-effort 로 감싸서, DB 장애가
   * 스윕을 멈추거나 바로 앞서 발화한 WARN 을 삼키지 못하게 한다.
   */
  private _writeAuditRow(input: {
    agentId: string;
    kind: string;
    action: string;
    fieldChanged: string;
    oldValue: string;
    payload: Record<string, unknown>;
    now: Date;
  }): void {
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      void repo.save(
        repo.create({
          // Managers are workspace-less; leave workspace_id at its '' default.
          entity_type: 'agent_manager',
          entity_id: input.agentId,
          action: input.action,
          field_changed: input.fieldChanged,
          old_value: input.oldValue,
          new_value: JSON.stringify(input.payload),
          actor_id: 'system',
          actor_name: 'ManagerDriftMonitor',
          trigger_source: 'system',
          created_at: input.now,
        }),
      ).catch?.((e: unknown) => {
        this.logService.warn('AgentManager', 'ManagerDriftMonitor audit-row write failed (continuing)', {
          err: String(e), agent_id: input.agentId, kind: input.kind,
        });
      });
    } catch (e) {
      this.logService.warn('AgentManager', 'ManagerDriftMonitor audit-row write threw (continuing)', {
        err: String(e), agent_id: input.agentId, kind: input.kind,
      });
    }
  }

  /**
   * 진짜 해소만 여기로 온다 — 호출부가 사라진 agent 를 먼저 걸러내므로 (ticket
   * bfc34cd5), 이 시점의 agent 는 레지스트리에 살아있고 조건만 없어진 상태다.
   */
  private _logResolved(kind: DriftKind, agentId: string, ageMs: number): void {
    const ageH = (ageMs / 3_600_000).toFixed(1);
    this.logService.info(
      'AgentManager',
      kind === 'drift'
        ? `agent-manager version drift resolved for agent ${agentId.slice(0, 8)} after ${ageH}h (now up to date)`
        : `agent-manager self-update checker recovered for agent ${agentId.slice(0, 8)} after ${ageH}h`,
      { kind: kind === 'drift' ? 'version_drift_resolved' : 'update_check_error_resolved', agent_id: agentId },
    );
  }
}
