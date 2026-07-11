// Phase 3 Plan 03-01 — Agent status runtime service (D-38, D-39, D-52, D-53, D-54)
//
// This service is the single runtime source of truth for broadcasting live agent
// status changes over SSE. It LAYERS ON TOP OF AgentConnectionService — it does
// NOT replace it. AgentConnectionService continues to update Agent.is_online in
// the DB (authoritative for admin views); this service reads that state on a
// 30s sweep and emits `agent_status` events on the activityEvents bus whenever
// the in-memory Map<agent_id, AgentStatus> actually changes.
//
// NOTE on multi-workspace: Phase 3 is single-workspace (see REQUIREMENTS Out of
// Scope). The sweep reads every agent in the agents table regardless of workspace.
// When multi-tenant arrives, the sweep + emit path will need a workspace filter
// (see 03-RESEARCH.md §Pitfall 7).
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { MemoryMetricsRegistry } from '../../services/memory-metrics.registry';

// Internal shape — held in memory with Date objects for precision. The wire
// shape (AgentStatusPayload in common/types/stream-events.ts) carries ISO-8601
// strings; conversion happens at the EventsController listener boundary.
//
// `active_tasks` (internal-only) tracks every ticket the agent has an active
// subagent for, keyed by ticket_id. The wire-facing `current_task` (singular)
// is derived as the most-recently-claimed entry so the existing SSE shape
// stays unchanged. Multiple-active-task tracking is what the per-board
// `max_concurrent_tickets_per_agent` gate counts against.
interface ActiveTask {
  ticket_id: string;
  ticket_title: string;
  claimed_at: Date;
  // Role slug the subagent was spawned for (assignee/reporter/reviewer
  // or a workspace-custom slug). Optional because pre-v0.34 plugins do
  // not pin a role; the dashboard renders without it when undefined.
  role?: string;
}
interface AgentStatus {
  agent_id: string;
  is_online: boolean;
  last_seen_at: Date | null;
  // Map<ticket_id, ActiveTask>. Internal store. The full non-stale list is
  // now derived for the wire (AgentStatusPayload.active_tasks) via
  // _nonStaleTaskList / getActiveTasks — concurrency N is what the dashboard
  // renders. The Map stays the source of truth; the id-only view feeds the
  // per-board concurrency gate (getActiveTicketIds).
  active_tasks?: Map<string, ActiveTask>;
  // Derived from active_tasks — most-recently-claimed entry, or undefined
  // when active_tasks is empty. Kept on the object for back-compat: the
  // singular current_task still ships on both SSE and REST so older clients
  // that read only it keep working.
  current_task?: ActiveTask;
}

const SWEEP_INTERVAL_MS = 30_000;
const OFFLINE_THRESHOLD_MS = 90_000;
// current_task is plugin-signal driven. If a plugin crashes between
// setCurrentTask and clearCurrentTask the task would otherwise stay stuck;
// the sweep auto-clears any task older than this so the dashboard recovers
// without manual intervention. Tuned long enough that legitimate long-running
// reviews don't flap, short enough that crashes self-heal within ~one sweep.
const CURRENT_TASK_STALE_MS = 15 * 60_000;
// Output-liveness eviction TTL (ticket fdc69c13, hardened by 47a72129). A
// per-(agent,ticket,role) output timestamp has nobody to clear it once the
// session ends; the 30s sweep drops entries older than the *effective* TTL so
// the map stays bounded.
//
// The effective TTL is NOT a fixed constant — it is derived every sweep as
// clamp(MAX(Workspace.supervisor_stale_ms), FLOOR, CEILING). Why: the
// TicketSupervisor force-suppression gate compares a strand's output age
// against that workspace's supervisor_stale_ms. If retention were a fixed 6 h
// but an operator raised supervisor_stale_ms above it (a real incident-response
// move — see ticket 47a72129), an entry in the (TTL, staleMs) band would be
// evicted while the gate still treats it as recent → getOutputLivenessAt()
// returns undefined → hasRecentOutput=false → a live worker is force_respawned
// (the exit-143 deathloop fdc69c13 fixed, silently regressed). Deriving
// retention from staleMs makes the invariant `retention >= staleMs` hold by
// construction (up to the CEILING). The CEILING bounds the in-memory Map even
// under a pathological supervisor_stale_ms — its write path enforces only
// positive, no upper limit.
export const OUTPUT_LIVENESS_TTL_FLOOR_MS = 6 * 60 * 60_000;     // 6 h — preserves pre-47a72129 retention for normal configs
export const OUTPUT_LIVENESS_TTL_CEILING_MS = 24 * 60 * 60_000;  // 24 h — hard cap so a huge supervisor_stale_ms can't unbound the Map

/**
 * Effective output-liveness retention TTL (ticket 47a72129), derived from the
 * largest supervisor_stale_ms across workspaces so the supervisor's force-gate
 * window (which compares output age against supervisor_stale_ms) is always
 * backed by a still-present entry. Pure + exported for unit testing.
 *   - maxStaleMs <= FLOOR (normal config) → FLOOR (unchanged 6 h behavior)
 *   - FLOOR < maxStaleMs <= CEILING       → maxStaleMs (retention tracks the knob)
 *   - maxStaleMs > CEILING (pathological) → CEILING (Map stays bounded)
 *   - null / non-finite / <= 0            → FLOOR
 */
export function resolveOutputLivenessTtlMs(
  maxStaleMs: number | null | undefined,
  floorMs: number = OUTPUT_LIVENESS_TTL_FLOOR_MS,
  ceilingMs: number = OUTPUT_LIVENESS_TTL_CEILING_MS,
): number {
  const base =
    typeof maxStaleMs === 'number' && Number.isFinite(maxStaleMs) && maxStaleMs > 0
      ? Math.floor(maxStaleMs)
      : 0;
  return Math.min(ceilingMs, Math.max(floorMs, base));
}

@Injectable()
export class AgentStatusService implements OnModuleInit, OnModuleDestroy {
  private readonly state = new Map<string, AgentStatus>();
  // Output-liveness (ticket fdc69c13): last server-receipt time (epoch ms) that
  // agent-manager reported a subagent for `${agent_id}:${ticket_id}:${role}`
  // emitted model output (thinking/tool/text). DISTINCT from active_tasks
  // (spawn time) and from Ticket.my_last_update_at (ticket writes). Purely
  // in-memory; never emitted on SSE nor written to the DB, so recording it can
  // never re-enter TriggerLoopService._handleActivity (self-echo guard, DoD#4).
  // Read by TicketSupervisorService to suppress force_respawn for a worker
  // that's alive-but-quiet-on-the-ticket (the exit-143 deathloop fix).
  private readonly outputLiveness = new Map<string, number>();
  // Effective output-liveness retention TTL (ticket 47a72129), recomputed each
  // sweep as resolveOutputLivenessTtlMs(MAX(supervisor_stale_ms)). Seeded at the
  // FLOOR so the pre-first-sweep window (and any workspace-query failure) is
  // safe — it never starts shorter than the historical fixed 6 h.
  private outputLivenessTtlMs: number = OUTPUT_LIVENESS_TTL_FLOOR_MS;
  private sweepHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectRepository(Agent) private readonly agentRepo: Repository<Agent>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    metrics: MemoryMetricsRegistry,
  ) {
    // Size gauge for /api/diagnostics/memory + the [Memory] watchdog row.
    // Pre-fix the `state` Map only ever grew (sweep set, never deleted), so a
    // non-zero-and-climbing reading here is the early warning that the
    // deleted-agent eviction in _sweep regressed. At rest it should equal the
    // live agent-row count.
    metrics.register('agentStatus.state', () => this.state.size);
    // Bound-check gauge for the output-liveness map (ticket fdc69c13). At rest
    // it tracks live (agent,ticket,role) strands producing output; a persistent
    // climb means the sweep's TTL eviction regressed.
    metrics.register('agentStatus.outputLiveness', () => this.outputLiveness.size);
    // Effective retention TTL gauge (ticket 47a72129). Surfaces the derived
    // output-liveness TTL (ms) so an operator can watch it track a raised
    // supervisor_stale_ms — and see it pinned at the CEILING under a
    // pathological value.
    metrics.register('agentStatus.outputLivenessTtlMs', () => this.outputLivenessTtlMs);
  }

  async onModuleInit(): Promise<void> {
    // Seed the in-memory map from the current DB snapshot so that the first
    // sweep after startup compares against real state (not an empty map).
    const agents = await this.agentRepo.find();
    for (const a of agents) {
      this.state.set(a.id, {
        agent_id: a.id,
        is_online: !!a.is_online,
        last_seen_at: a.last_seen_at,
      });
    }

    // Note: previously a `agent_trigger` listener auto-set current_task on
    // every trigger emit. That made "processing" indistinguishable from
    // "trigger queued" — agents that never picked the trigger up (proxy
    // disconnected, subagent silent-exit, spawn failure) appeared busy
    // forever. current_task is now strictly plugin-signal driven via
    // setCurrentTask / clearCurrentTask, so the dashboard reflects what's
    // actually executing rather than what was dispatched.

    // D-53: 30s sweep handle stored in field (cleared in onModuleDestroy per §Pitfall 8).
    this.sweepHandle = setInterval(() => {
      this._sweep().catch((e: unknown) => {
        this.logService.error('AgentStatus', 'sweep failed', { err: e });
      });
    }, SWEEP_INTERVAL_MS);

    this.logService.info('AgentStatus', 'Service initialized with N agents seeded', {
      count: agents.length,
    });
  }

  onModuleDestroy(): void {
    if (this.sweepHandle) {
      clearInterval(this.sweepHandle);
      this.sweepHandle = null;
    }
  }

  /** Snapshot accessor for REST endpoints (Plan 03-02 dashboard GET). */
  getSnapshot(): AgentStatus[] {
    return Array.from(this.state.values());
  }

  /** Single-agent lookup for REST endpoints (Plan 03-02 agent detail GET). */
  getOne(agentId: string): AgentStatus | undefined {
    return this.state.get(agentId);
  }

  /**
   * Distinct ticket_ids this agent currently has live subagents on, after
   * the stale-cutoff filter (mirrors what the sweep would clear). Used by
   * TriggerLoopService's per-board cap check — comparing list length
   * against `Board.max_concurrent_tickets_per_agent` decides whether a
   * new trigger emits or gets skipped.
   */
  getActiveTicketIds(agent_id: string): string[] {
    const status = this.state.get(agent_id);
    if (!status?.active_tasks || status.active_tasks.size === 0) return [];
    const cutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    const out: string[] = [];
    for (const [ticketId, task] of status.active_tasks) {
      if (task.claimed_at >= cutoff) out.push(ticketId);
    }
    return out;
  }

  /**
   * Full non-stale ActiveTask list for this agent (concurrency N), newest-first.
   * Same stale cutoff as getActiveTicketIds — mirrors what the sweep would keep.
   * Powers the multi-task dashboard surfaces (the SSE active_tasks list + the
   * REST /dashboard and /:id rollups). getActiveTicketIds stays the id-only
   * concurrency-gate input, untouched.
   */
  getActiveTasks(agent_id: string): ActiveTask[] {
    return this._nonStaleTaskList(this.state.get(agent_id)?.active_tasks);
  }

  /** Non-stale entries (CURRENT_TASK_STALE_MS cutoff) of a task Map, newest-first. */
  private _nonStaleTaskList(tasks?: Map<string, ActiveTask>): ActiveTask[] {
    if (!tasks || tasks.size === 0) return [];
    const cutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    const out: ActiveTask[] = [];
    for (const t of tasks.values()) {
      if (t.claimed_at >= cutoff) out.push(t);
    }
    out.sort((a, b) => b.claimed_at.getTime() - a.claimed_at.getTime());
    return out;
  }

  /**
   * Is there a LIVE (non-stale) subagent strand for this exact (agent,
   * ticket, role) right now? Used by TriggerLoopService's in-flight gate
   * (ticket c9622a40) to serialize same-(ticket, role) strands: the focus
   * selector already caps the agent to ONE focus ticket per (board, role),
   * but two distinct events (column_move + comment_mention + supervisor
   * tick) for the SAME (ticket, role) both pass the focus gate (same ticket
   * id) and spawn racing strands. On a review gate that produces the
   * reviewer-vs-reviewer self-LGTM race — a fast strand LGTMs + advances
   * before the slow strand's BLOCKER review lands, discarding the careful
   * verdict as a post-merge no-op (ticket 86bfb8af live repro). proposal 2's
   * review-approval-guard only checks author_role, so it can't tell the two
   * reviewer strands apart; serializing the strands is the residual fix.
   *
   * The "lock" is the existing current_task lifecycle, no new store:
   *   - acquired  → plugin's set_current_task when the subagent starts work
   *   - released  → clear_current_task / agent_idle on exit or crash
   *   - TTL       → CURRENT_TASK_STALE_MS auto-clears a crashed strand's
   *                 entry so the gate can't wedge a ticket forever.
   *
   * active_tasks is keyed by ticket_id only, so it holds at most one entry
   * per (agent, ticket). We additionally require the live entry's role to
   * match: a live ASSIGNEE strand must NOT block a REVIEWER trigger (those
   * are legitimately distinct strands on a single-agent multi-role board).
   * Same-role match → there's already a live strand serving this seat → the
   * caller drops the redundant emit.
   */
  hasLiveRoleStrand(agent_id: string, ticket_id: string, role: string): boolean {
    if (!agent_id || !ticket_id) return false;
    const status = this.state.get(agent_id);
    const task = status?.active_tasks?.get(ticket_id);
    if (!task) return false;
    // Stale entry (plugin crashed before clearing) — treat as no live strand
    // so a re-trigger can recover, mirroring getActiveTicketIds' cutoff.
    const cutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    if (task.claimed_at < cutoff) return false;
    // Role must match the live strand's seat. An undefined role on the live
    // task (pre-v0.34 plugin that didn't pin a role) is treated as matching
    // any role — conservative: better to serialize than to race.
    return !task.role || task.role === role;
  }

  private _outputLivenessKey(agentId: string, ticketId: string, role: string): string {
    return `${agentId}:${ticketId}:${role || ''}`;
  }

  /**
   * agent-manager signal (ticket fdc69c13): a subagent for (agent, ticket,
   * role) just emitted model output. Records the SERVER-receipt time (not the
   * manager's clock — avoids skew) so TicketSupervisorService can tell a worker
   * that's actively producing tokens but hasn't written to the ticket from a
   * genuinely wedged one, and suppress force_respawn for the former.
   *
   * In-memory only: no SSE emit, no DB write, no ActivityLog — so this can
   * never re-enter TriggerLoopService._handleActivity (self-echo guard, DoD#4).
   */
  recordOutputLiveness(agent_id: string, ticket_id: string, role: string): void {
    if (!agent_id || !ticket_id) return;
    this.outputLiveness.set(this._outputLivenessKey(agent_id, ticket_id, role), Date.now());
  }

  /**
   * Last output-liveness timestamp (epoch ms) for (agent, ticket, role), or
   * undefined when none was recorded (or the entry aged past the sweep TTL).
   * Read by TicketSupervisorService's force_respawn gate.
   */
  getOutputLivenessAt(agent_id: string, ticket_id: string, role: string): number | undefined {
    return this.outputLiveness.get(this._outputLivenessKey(agent_id, ticket_id, role));
  }

  /**
   * Effective output-liveness retention TTL (ms window) currently in force
   * (ticket 47a72129). TicketSupervisorService clamps its force-gate comparison
   * window to this so the window can never exceed what the map actually retains
   * (the `gate-window <= retention` invariant). Derived each sweep from
   * MAX(supervisor_stale_ms); seeded at the FLOOR before the first sweep.
   */
  getOutputLivenessTtlMs(): number {
    return this.outputLivenessTtlMs;
  }

  /**
   * Emit the internal (Date-containing) shape on the activityEvents bus.
   * EventsController.agentStatusListener converts Date → ISO string at the
   * envelope construction boundary.
   */
  private _emit(status: AgentStatus): void {
    // Emit a fresh object: keep the Date-carrying singular current_task (the
    // EventsController map() converts Date → ISO) AND attach the full non-stale
    // task list (concurrency N) as an array. The stored `status` in `this.state`
    // is untouched — its active_tasks stays a Map (the gate reads it). Board-
    // ticket tasks only; QA runs are merged at the REST layer, not here.
    activityEvents.emit('agent_status', {
      ...status,
      active_tasks: this._nonStaleTaskList(status.active_tasks),
    });
  }

  /**
   * Plugin signal: an agent has just spawned a ticket-session subagent and
   * actually started working on the ticket. Stamps current_task + is_online +
   * last_seen_at so the dashboard reflects "in progress" the instant the
   * subagent process is alive — not when the trigger was queued.
   */
  async setCurrentTask(agent_id: string, ticket_id: string, role?: string): Promise<void> {
    if (!agent_id || !ticket_id) return;

    const ticket = await this.dataSource
      .getRepository(Ticket)
      .findOne({ where: { id: ticket_id } });

    const existing = this.state.get(agent_id) ?? {
      agent_id,
      is_online: true,
      last_seen_at: new Date(),
    };
    const tasks = new Map(existing.active_tasks ?? []);
    const task: ActiveTask = {
      ticket_id,
      ticket_title: ticket?.title ?? '(unknown ticket)',
      claimed_at: new Date(),
      role: role || undefined,
    };
    tasks.set(ticket_id, task);
    const updated: AgentStatus = {
      ...existing,
      is_online: true,
      last_seen_at: new Date(),
      active_tasks: tasks,
      current_task: pickMostRecent(tasks),
    };
    this.state.set(agent_id, updated);
    this._emit(updated);
  }

  /**
   * Plugin signal: subagent for the ticket has exited (idle TTL, normal
   * completion, or crash). Clears current_task so the dashboard releases the
   * "processing" badge.
   *
   * `expectedTicketId` lets the caller assert intent — if a newer task
   * already overwrote current_task we must not clobber it. Pass undefined to
   * force-clear unconditionally (e.g. agent shutdown).
   */
  clearCurrentTask(agent_id: string, expectedTicketId?: string): void {
    if (!agent_id) return;
    const status = this.state.get(agent_id);
    if (!status?.active_tasks || status.active_tasks.size === 0) return;

    const tasks = new Map(status.active_tasks);
    if (expectedTicketId) {
      // Targeted clear: drop just this ticket's entry. No-op if a newer
      // setCurrentTask already replaced it (which on a Map means the same
      // key is still present but with a fresher claimed_at — caller's
      // intent was to clear THIS task, so we still drop it; the manager
      // would call setCurrentTask again on the next session anyway).
      if (!tasks.delete(expectedTicketId)) return;
    } else {
      // Force-clear all (agent shutdown). Mirrors pre-multi-task behavior.
      tasks.clear();
    }

    const updated: AgentStatus = {
      ...status,
      active_tasks: tasks.size > 0 ? tasks : undefined,
      current_task: tasks.size > 0 ? pickMostRecent(tasks) : undefined,
    };
    this.state.set(agent_id, updated);
    this._emit(updated);

    // 'agent_idle' broadcast — preserved for BacklogPromotionService,
    // which subscribes to attempt a single promotion pass on each board
    // the freed agent has any role assignment on. The dispatch-queue
    // listener that used to consume this signal was removed in ticket
    // 4a6cdfd7 (focus-selector replacement); the supervisor 60s tick
    // is the canonical recovery path for missed focus rotations.
    activityEvents.emit('agent_idle', {
      agent_id,
      cleared_ticket_id: expectedTicketId,
      remaining_active_count: tasks.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * D-53/D-54: Periodic reconciliation against Agent.last_seen_at (which MCP
   * `ping` tool updates every 30s). Any agent with last_seen_at older than
   * OFFLINE_THRESHOLD_MS is considered offline. On state change, emit and
   * persist is_online=0 to the DB so admin views stay consistent.
   */
  private async _sweep(): Promise<void> {
    const threshold = new Date(Date.now() - OFFLINE_THRESHOLD_MS);
    const staleTaskCutoff = new Date(Date.now() - CURRENT_TASK_STALE_MS);
    const agents = await this.agentRepo.find();
    const seen = new Set<string>();
    for (const a of agents) {
      seen.add(a.id);
      const prev = this.state.get(a.id);
      const is_online = !!(a.last_seen_at && a.last_seen_at > threshold);

      // Stale-task auto-clear: covers plugin crashes that skipped
      // clearCurrentTask. Never blocks legitimate long work — sweep just
      // forgets the badge after CURRENT_TASK_STALE_MS, the next setCurrentTask
      // re-establishes it. With multi-task tracking we filter the Map and
      // keep entries newer than the cutoff (offline agents drop everything).
      let nextTasks: Map<string, ActiveTask> | undefined;
      if (is_online && prev?.active_tasks) {
        const kept = new Map<string, ActiveTask>();
        for (const [tid, t] of prev.active_tasks) {
          if (t.claimed_at >= staleTaskCutoff) kept.set(tid, t);
        }
        if (kept.size > 0) nextTasks = kept;
      }
      const next_current_task = nextTasks ? pickMostRecent(nextTasks) : undefined;

      const prevLastSeenMs = prev?.last_seen_at?.getTime();
      const nextLastSeenMs = a.last_seen_at?.getTime();
      const prevTaskCount = prev?.active_tasks?.size ?? 0;
      const nextTaskCount = nextTasks?.size ?? 0;
      const tasksChanged = prevTaskCount !== nextTaskCount;
      const stateChanged =
        !prev ||
        prev.is_online !== is_online ||
        prevLastSeenMs !== nextLastSeenMs ||
        tasksChanged;
      if (!stateChanged) continue;

      const updated: AgentStatus = {
        agent_id: a.id,
        is_online,
        last_seen_at: a.last_seen_at,
        active_tasks: nextTasks,
        current_task: next_current_task,
      };
      this.state.set(a.id, updated);
      this._emit(updated);

      // v0.41 — sweep-driven idle signal. If active_tasks shrank as a
      // result of stale-task cleanup (plugin crashed before clearing),
      // surface the same 'agent_idle' event so the dispatch queue gets
      // a chance to drain its head item. Same contract as the
      // clearCurrentTask path; only the trigger differs.
      if (is_online && tasksChanged && nextTaskCount < prevTaskCount) {
        activityEvents.emit('agent_idle', {
          agent_id: a.id,
          cleared_ticket_id: undefined,
          remaining_active_count: nextTaskCount,
          timestamp: new Date().toISOString(),
        });
      }

      // D-54: persist is_online flip when crossing from online → offline.
      // We only write when it actually changed to avoid write amplification.
      if (!is_online && a.is_online === 1) {
        await this.agentRepo.update(a.id, { is_online: 0 });
      }
    }

    // Evict in-memory entries for agents whose DB row no longer exists (agent
    // deleted / moved out of this single-workspace scope). Without this the
    // sweep only ever `set`s, so a deleted agent's AgentStatus lingered for the
    // life of the process — a slow unbounded grower over months of churn.
    // active_tasks for a vanished agent goes with the entry; nothing else holds
    // a reference. (setCurrentTask can transiently re-add an id the next time
    // that agent signals; only ids absent from the DB snapshot are dropped.)
    for (const id of this.state.keys()) {
      if (!seen.has(id)) this.state.delete(id);
    }

    // Refresh the effective output-liveness retention TTL (ticket 47a72129)
    // from the largest supervisor_stale_ms across workspaces, so retention is
    // always >= any workspace's force-gate window (up to the CEILING).
    this.outputLivenessTtlMs = await this._resolveOutputLivenessTtlMs();

    // Evict aged output-liveness entries (ticket fdc69c13) so the map stays
    // bounded — a finished/dead session's last entry has nobody to clear it.
    // The effective TTL is derived to sit at or above every workspace's
    // supervisor_stale_ms, so an entry still within the supervisor's force-gate
    // window is never dropped early (the exit-143 deathloop guard).
    const outputCutoff = Date.now() - this.outputLivenessTtlMs;
    for (const [k, ts] of this.outputLiveness) {
      if (ts < outputCutoff) this.outputLiveness.delete(k);
    }
  }

  /**
   * Derive the effective output-liveness retention TTL (ticket 47a72129) from
   * the largest Workspace.supervisor_stale_ms. A single cheap aggregate per 30s
   * sweep. On any failure returns the CURRENT TTL — never shrinks retention on a
   * transient DB blip, since a shrink is exactly what would re-open the
   * exit-143 deathloop.
   */
  private async _resolveOutputLivenessTtlMs(): Promise<number> {
    try {
      const row = await this.dataSource
        .getRepository(Workspace)
        .createQueryBuilder('ws')
        .select('MAX(ws.supervisor_stale_ms)', 'max')
        .getRawOne<{ max: number | string | null }>();
      const maxStaleMs = row?.max != null ? Number(row.max) : 0;
      return resolveOutputLivenessTtlMs(maxStaleMs);
    } catch (e) {
      this.logService.warn('AgentStatus', 'output-liveness TTL derivation failed — keeping current TTL', {
        err: String(e),
        current_ttl_ms: this.outputLivenessTtlMs,
      });
      return this.outputLivenessTtlMs;
    }
  }
}

// Pick the most-recently-claimed entry from a non-empty active_tasks map.
// Used to derive the wire-facing `current_task` (singular) so the existing
// dashboard doesn't need to learn about the multi-task internal shape.
function pickMostRecent(tasks: Map<string, ActiveTask>): ActiveTask | undefined {
  let best: ActiveTask | undefined;
  for (const t of tasks.values()) {
    if (!best || t.claimed_at > best.claimed_at) best = t;
  }
  return best;
}
