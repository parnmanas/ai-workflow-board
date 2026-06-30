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
 * This compresses the silent-stall detection window from days → hours without
 * touching the heartbeat wire contract, the agent-manager, or the plugin: it
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
 *   - Only `mode === 'manager'` instances are considered. Daemon / proxy and
 *     binary (`npm i -g`, repo_root === null → checker is a no-op,
 *     update_available stays false) installs never trigger.
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

interface AgentDriftState {
  drift: ConditionState | null;
  error: ConditionState | null;
}

export interface DriftSweepStats {
  scanned: number;        // manager instances examined
  agents: number;         // distinct manager agents
  driftAlerts: number;    // drift alerts emitted this sweep
  errorAlerts: number;    // checker-error alerts emitted this sweep
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
      scanned: 0, agents: 0, driftAlerts: 0, errorAlerts: 0, resolved: 0,
      skipped_disabled: !this.config.enabled,
    };
    if (!this.config.enabled) return stats;
    const nowMs = now.getTime();

    // Aggregate per agent_id: a manager Agent identity may be backed by more
    // than one live process (laptop + VM sharing a pairing code). Treat the
    // agent as drifting / erroring if ANY of its manager instances reports it,
    // and keep a representative instance for the alert text.
    const byAgent = new Map<string, { drift: InstanceRecord | null; error: InstanceRecord | null }>();
    for (const inst of this.registry.list()) {
      if (inst.mode !== 'manager') continue;
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
      const tracked = this.state.get(agentId) ?? { drift: null, error: null };
      let mutated = false;

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
    const branch = inst.default_branch || 'main';

    let message: string;
    if (kind === 'drift') {
      message =
        `agent-manager version drift: ${who} running v${inst.plugin_version} has been behind ` +
        `latest v${inst.latest_version || '?'} on ${branch} for ${ageH}h — self-update is not landing. ` +
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
      default_branch: inst.default_branch ?? null,
      update_last_error: inst.update_last_error ?? null,
      age_hours: Number(ageH),
    });

    // Durable record — the retro's missing "영속 기록". Saved directly via the
    // repository (not ActivityService) so it stays an audit row and fires no
    // Discord / SSE notification fan-out. Best-effort: never let it break the
    // sweep or hide the WARN above.
    try {
      const repo = this.dataSource.getRepository(ActivityLog);
      void repo.save(
        repo.create({
          // Managers are workspace-less; leave workspace_id at its '' default.
          entity_type: 'agent_manager',
          entity_id: inst.agent_id,
          action: kind === 'drift' ? 'agent_manager_drift' : 'agent_manager_update_error',
          field_changed: kind === 'drift' ? 'version_drift' : 'update_check_error',
          old_value: String(inst.plugin_version || ''),
          new_value: JSON.stringify({
            instance_id: inst.instance_id,
            hostname: inst.hostname,
            current_version: inst.plugin_version,
            latest_version: inst.latest_version ?? null,
            default_branch: inst.default_branch ?? null,
            update_last_error: inst.update_last_error ?? null,
            age_hours: Number(ageH),
          }),
          actor_id: 'system',
          actor_name: 'ManagerDriftMonitor',
          trigger_source: 'system',
          created_at: now,
        }),
      ).catch?.((e: unknown) => {
        this.logService.warn('AgentManager', 'ManagerDriftMonitor audit-row write failed (continuing)', {
          err: String(e), agent_id: inst.agent_id, kind,
        });
      });
    } catch (e) {
      this.logService.warn('AgentManager', 'ManagerDriftMonitor audit-row write threw (continuing)', {
        err: String(e), agent_id: inst.agent_id, kind,
      });
    }
  }

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
