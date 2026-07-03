/**
 * RespawnStormDetectorService — cause-agnostic last line of defence against
 * respawn storms / death-loops / twin-echo spawns (ticket ab06eac2).
 *
 * Why this exists
 * ───────────────
 * exit-143 / re-spawn incidents recurred at least four times and a HUMAN found
 * every one by reading logs:
 *   - 876b7679: watchdog UNHEALTHY false-positive self-kill (turns=5, ~85s loop)
 *   - fdc69c13: TicketSupervisor force_respawn read ONLY ticket-write staleness
 *     and killed a live worker every ~5 min (be2f998a died 14×)
 *   - twin-echo: a ticket's own @[role] comment self-mention-spawned 3 strands
 *   - 672f6fc7: gemini auth exit-41 re-dispatched 27× (the exit-code circuit
 *     breaker landed then, but it is EXIT-CODE based and can't see a
 *     supervisor-driven death-loop)
 * Each root cause was patched at the source, but there was no general layer that
 * notices the PATTERN — "the same (ticket,role) is dying abnormally fast, over
 * and over, with zero forward progress". The next variant would need a human
 * again. This detector is that layer.
 *
 * What it does (mirrors StuckTicketDetectorService's shape)
 * ─────────────────────────────────────────────────────────
 *   - Background `setInterval` sweep from `onModuleInit`; `sweep(now)` is the
 *     public test hook (one tick).
 *   - Groups QUICK abnormal subagent deaths per (ticket, role) off the durable
 *     `subagents` table. Past `min_deaths` inside `window_minutes`, with ZERO
 *     forward-progress signal, it HALTS the ticket:
 *       · auto-`pend` (surfaces on the User tab, drops future triggers)
 *       · chat-room alert to the workspace
 *       · a first-class `respawn_storm_halted` activity row (rides SSE)
 *   - Detects twins: 2+ concurrently-live strands on the same (ticket, role) →
 *     `respawn_twin_detected` event (+ optional `respawn_twin_autostop_intent`
 *     for the late strand; the real process-kill lives in agent-manager
 *     spawn-dedup 52e581ce/66bddd2e, this is the last-resort detector).
 *
 * False-positive discipline (watchdog-lesson, DoD 오탐 회귀)
 * ────────────────────────────────────────────────────────
 * TWO independent guards, either of which vetoes a storm:
 *   1. Duration gate — only 즉사-shaped deaths count. A subagent that ran longer
 *      than `quick_death_seconds` did real work and is excluded, so a slow-but-
 *      productive strand that gets killed is never mistaken for a crash loop.
 *   2. Forward-progress veto — if ANY fresh non-system comment OR column move
 *      landed inside the window, the ticket is making progress → never flagged.
 * Config is per-board (`Board.respawn_storm_config`) folded over an env-tunable
 * baseline; defaults are ON but conservative (see common/respawn-storm-config.ts).
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { ChatRoom } from '../../entities/ChatRoom';
import { Comment } from '../../entities/Comment';
import { QaRun } from '../../entities/QaRun';
import { StuckTicketAlert } from '../../entities/StuckTicketAlert';
import { Subagent } from '../../entities/Subagent';
import { SubagentLogLine } from '../../entities/SubagentLogLine';
import { Ticket } from '../../entities/Ticket';
import { Workspace } from '../../entities/Workspace';
import { LogService } from '../../services/log.service';
import { ActivityService } from '../../services/activity.service';
import { RoomMessagingService } from '../chat-rooms/room-messaging.service';
import {
  ResolvedRespawnStorm,
  respawnStormDefaultsFromEnv,
  resolveRespawnStormConfig,
} from '../../common/respawn-storm-config';

// Global operational knob (not per-board): how often the background sweep runs.
// Storms are acute, so we sweep faster than the stuck detector (15 min).
const SWEEP_MS_DEFAULT = 5 * 60_000;

function readSweepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RESPAWN_STORM_SWEEP_MS;
  if (raw == null || raw === '') return SWEEP_MS_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : SWEEP_MS_DEFAULT;
}

export interface RespawnSweepStats {
  scanned_groups: number;
  storms_detected: number;
  storms_halted: number;
  twins_detected: number;
  skipped_progress: number;
  skipped_disabled: number;
  skipped_already_halted: number;
}

/** One (ticket, role) group of subagent rows the sweep evaluates. */
interface StrandGroup {
  ticketId: string;
  role: string;
  rows: Subagent[];
}

@Injectable()
export class RespawnStormDetectorService implements OnModuleInit, OnModuleDestroy {
  private readonly baseline: ResolvedRespawnStorm;
  private readonly sweepMs: number;
  private tickHandle: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly activityService: ActivityService,
    private readonly messaging: RoomMessagingService,
  ) {
    this.baseline = respawnStormDefaultsFromEnv();
    this.sweepMs = readSweepMs();
  }

  onModuleInit(): void {
    // Even a globally-disabled baseline can be overridden ON per-board, so the
    // loop always runs; the per-group `enabled` check is where an opt-out lands.
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('RespawnStorm', 'sweep failed', { err: String(e) });
      });
    }, this.sweepMs);
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('RespawnStorm', 'sweep loop initialized', {
      baseline: this.baseline, sweepMs: this.sweepMs,
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /** Test hook — equivalent to one interval tick. */
  async sweep(now: Date = new Date()): Promise<RespawnSweepStats> {
    const stats: RespawnSweepStats = {
      scanned_groups: 0, storms_detected: 0, storms_halted: 0, twins_detected: 0,
      skipped_progress: 0, skipped_disabled: 0, skipped_already_halted: 0,
    };

    // Resolve per-board config once. `configByBoard` maps board_id → resolved.
    const configByBoard = await this._loadBoardConfigs();
    // Widest window across every enabled config bounds the death query. If NO
    // config is enabled anywhere (baseline off AND no board opts in), skip.
    const enabledWindows: number[] = [];
    if (this.baseline.enabled) enabledWindows.push(this.baseline.windowMs);
    for (const c of configByBoard.values()) if (c.enabled) enabledWindows.push(c.windowMs);
    if (enabledWindows.length === 0) {
      stats.skipped_disabled = 1;
      return stats;
    }
    const maxWindowMs = Math.max(...enabledWindows);

    // Candidate subagent rows: any strand for a (ticket, role) that started
    // inside the widest window. Quick deaths start≈end, and live twins are
    // caught by started_at too. Ignore rows with no ticket/role — they can't
    // form a (ticket, role) group.
    const subRepo = this.dataSource.getRepository(Subagent);
    const sinceStart = new Date(now.getTime() - maxWindowMs);
    const rows = await subRepo
      .createQueryBuilder('s')
      .where('s.started_at >= :since', { since: sinceStart })
      .andWhere('s.ticket_id IS NOT NULL')
      .andWhere("s.role IS NOT NULL AND s.role != ''")
      .getMany();
    if (rows.length === 0) return stats;

    // Group by (ticket_id, role).
    const groups = new Map<string, StrandGroup>();
    for (const r of rows) {
      const key = `${r.ticket_id} ${r.role}`;
      let g = groups.get(key);
      if (!g) { g = { ticketId: r.ticket_id as string, role: r.role as string, rows: [] }; groups.set(key, g); }
      g.rows.push(r);
    }

    // Batch-resolve the board config for every group's ticket.
    const ticketIds = Array.from(new Set(Array.from(groups.values()).map(g => g.ticketId)));
    const ticketsById = await this._loadTicketsWithBoard(ticketIds);

    for (const g of groups.values()) {
      stats.scanned_groups += 1;
      try {
        await this._evaluateGroup(g, ticketsById, configByBoard, now, stats);
      } catch (e) {
        this.logService.warn('RespawnStorm', 'group evaluation failed (continuing)', {
          err: String(e), ticket_id: g.ticketId, role: g.role,
        });
      }
    }

    this.logService.info('RespawnStorm', 'sweep complete', { stats });
    return stats;
  }

  private async _evaluateGroup(
    g: StrandGroup,
    ticketsById: Map<string, { ticket: Ticket; boardId: string | null }>,
    configByBoard: Map<string, ResolvedRespawnStorm>,
    now: Date,
    stats: RespawnSweepStats,
  ): Promise<void> {
    const entry = ticketsById.get(g.ticketId);
    if (!entry) return; // ticket vanished — nothing to halt
    const { ticket, boardId } = entry;
    if (ticket.archived_at) return;

    const cfg = (boardId && configByBoard.get(boardId)) || this.baseline;
    if (!cfg.enabled) { stats.skipped_disabled += 1; return; }

    const windowStart = new Date(now.getTime() - cfg.windowMs);

    // ── Twin detection (independent of storm) ──
    if (cfg.detectTwins) {
      const live = g.rows.filter(r => r.ended_at == null && r.started_at.getTime() >= windowStart.getTime());
      if (live.length >= 2) {
        await this._handleTwins(ticket, g.role, live, cfg, windowStart, now, stats);
      }
    }

    // ── Storm detection ──
    const quickDeaths = g.rows.filter(r => this._isQuickAbnormalDeath(r, cfg.quickDeathMs, windowStart));
    if (quickDeaths.length < cfg.minDeaths) return;
    stats.storms_detected += 1;

    // Guard 1 already applied (duration gate in _isQuickAbnormalDeath).
    // Guard 2 — forward-progress veto: any fresh non-system comment or column
    // move inside the window means the ticket is progressing → never a storm.
    if (await this._hasForwardProgress(ticket.id, windowStart)) {
      stats.skipped_progress += 1;
      return;
    }

    // Dedup: if we already halted this ticket for a storm inside the window,
    // or it is already pending for ANY reason, do nothing (a pended ticket
    // drops triggers, so no new deaths accrue). Activity-based dedup survives
    // restarts and covers the notify-only (autoPend=false) board too.
    if (ticket.pending_user_action) { stats.skipped_already_halted += 1; return; }
    if (await this._recentActivityExists(ticket.id, 'respawn_storm_halted', windowStart)) {
      stats.skipped_already_halted += 1;
      return;
    }

    await this._haltStorm(ticket, g.role, quickDeaths, cfg, now, stats);
  }

  /**
   * A death counts toward a storm only when it is BOTH abnormal (non-zero exit
   * or a signal — e.g. 143/SIGTERM, or the reconcile 'disappeared' marker) AND
   * 즉사-shaped (ran no longer than quick_death_seconds). A clean exit_code=0
   * completion, or an abnormal exit that ran long enough to have done real work,
   * is excluded. `ended_at` must also fall inside the board's window.
   */
  private _isQuickAbnormalDeath(row: Subagent, quickDeathMs: number, windowStart: Date): boolean {
    if (row.ended_at == null) return false;
    if (row.ended_at.getTime() < windowStart.getTime()) return false;
    const abnormal =
      (row.exit_code != null && row.exit_code !== 0) ||
      (row.exit_code == null && !!row.signal);
    if (!abnormal) return false;
    const dur = row.duration_ms != null && row.duration_ms >= 0
      ? row.duration_ms
      : Math.max(0, row.ended_at.getTime() - row.started_at.getTime());
    return dur <= quickDeathMs;
  }

  /** Fresh non-system comment OR column move inside the window = progress. */
  private async _hasForwardProgress(ticketId: string, windowStart: Date): Promise<boolean> {
    const commentRepo = this.dataSource.getRepository(Comment);
    const freshComments = await commentRepo
      .createQueryBuilder('c')
      .where('c.ticket_id = :tid', { tid: ticketId })
      .andWhere("c.type != 'system'")
      .andWhere('c.created_at >= :from', { from: windowStart })
      .getCount();
    if (freshComments > 0) return true;

    const activityRepo = this.dataSource.getRepository(ActivityLog);
    const moves = await activityRepo
      .createQueryBuilder('a')
      .where('a.ticket_id = :tid', { tid: ticketId })
      .andWhere('a.created_at >= :from', { from: windowStart })
      .andWhere("a.action = 'moved' AND a.field_changed = 'column'")
      .getCount();
    return moves > 0;
  }

  private async _recentActivityExists(ticketId: string, action: string, since: Date): Promise<boolean> {
    const repo = this.dataSource.getRepository(ActivityLog);
    const count = await repo
      .createQueryBuilder('a')
      .where('a.ticket_id = :tid', { tid: ticketId })
      .andWhere('a.action = :action', { action })
      .andWhere('a.created_at >= :since', { since })
      .getCount();
    return count > 0;
  }

  /**
   * Confirmed storm: halt the ticket. auto-pend (if configured) + first-class
   * `respawn_storm_halted` activity + chat alert (if configured).
   */
  private async _haltStorm(
    ticket: Ticket,
    role: string,
    quickDeaths: Subagent[],
    cfg: ResolvedRespawnStorm,
    now: Date,
    stats: RespawnSweepStats,
  ): Promise<void> {
    const exitCodes = Array.from(new Set(quickDeaths.map(d =>
      d.exit_code != null ? String(d.exit_code) : (d.signal || 'signal')))).join(',');
    const windowMin = Math.round(cfg.windowMs / 60_000);
    const tail = await this._lastOutputTail(quickDeaths);
    const summary =
      `Respawn-storm: role=${role} — ${quickDeaths.length} quick deaths ` +
      `in ${windowMin}m (exit ${exitCodes}), zero forward progress. ` +
      `Auto-halted; investigate the death-loop before resuming.`;

    // (a) auto-pend — replicate the pend field writes (no shared service).
    if (cfg.autoPend) {
      const ticketRepo = this.dataSource.getRepository(Ticket);
      const wasPending = !!ticket.pending_user_action;
      ticket.pending_user_action = true;
      ticket.pending_reason = summary;
      if (!wasPending) {
        ticket.pending_set_at = now;
        ticket.pending_set_by = 'RespawnStormDetector';
      }
      await ticketRepo.save(ticket);
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'pending_user_action',
        old_value: wasPending ? 'true' : 'false', new_value: 'true',
        ticket_id: ticket.id, actor_id: 'system', actor_name: 'RespawnStormDetector',
        role, trigger_source: 'respawn_storm',
      });
    }

    // (b) first-class event — rides SSE via the board_update event-registry entry.
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'respawn_storm_halted',
      field_changed: 'respawn_storm',
      old_value: '',
      new_value: JSON.stringify({
        role,
        deaths: quickDeaths.length,
        window_minutes: windowMin,
        exit_codes: exitCodes,
        auto_pended: cfg.autoPend,
        subagent_ids: quickDeaths.map(d => d.subagent_id).slice(0, 10),
        last_output_tail: tail,
      }),
      ticket_id: ticket.id, actor_id: 'system', actor_name: 'RespawnStormDetector',
      role, trigger_source: 'respawn_storm',
    });
    stats.storms_halted += 1;
    this.logService.warn('RespawnStorm', 'storm halted', {
      ticket_id: ticket.id, role, deaths: quickDeaths.length, exit_codes: exitCodes,
      auto_pended: cfg.autoPend,
    });

    // (c) chat alert.
    if (cfg.notify) {
      const lines = [
        `🌀 **Respawn-storm halted** — \`${ticket.id}\``,
        `**${ticket.title}**`,
        `role: ${role} · deaths: ${quickDeaths.length} in ${windowMin}m · exit: ${exitCodes}`,
        cfg.autoPend
          ? 'Ticket auto-pended (triggers dropped). Clear the pend after fixing the death-loop.'
          : 'Notify-only (auto-pend off for this board). Investigate the death-loop.',
        tail ? `Last output: _${tail}_` : '',
        `[Open ticket](/ws/${ticket.workspace_id}/ticket/${ticket.id})`,
      ].filter(Boolean);
      await this._postAlert(ticket.workspace_id, lines.join('\n\n'), ticket.id);
    }
  }

  private async _handleTwins(
    ticket: Ticket,
    role: string,
    live: Subagent[],
    cfg: ResolvedRespawnStorm,
    windowStart: Date,
    now: Date,
    stats: RespawnSweepStats,
  ): Promise<void> {
    // Dedup: one twin event per (ticket, role) per window.
    if (await this._recentActivityExists(ticket.id, 'respawn_twin_detected', windowStart)) return;

    // Latest-started strand is the "late" twin (the echo).
    const sorted = [...live].sort((a, b) => a.started_at.getTime() - b.started_at.getTime());
    const lateTwin = sorted[sorted.length - 1];

    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'respawn_twin_detected',
      field_changed: 'respawn_twin',
      old_value: '', new_value: JSON.stringify({
        role, live_count: live.length,
        subagent_ids: sorted.map(s => s.subagent_id),
        late_twin_id: lateTwin.subagent_id,
      }),
      ticket_id: ticket.id, actor_id: 'system', actor_name: 'RespawnStormDetector',
      role, trigger_source: 'respawn_storm',
    });
    stats.twins_detected += 1;

    // Optional autostop INTENT for the late strand. The real process-kill lives
    // in agent-manager spawn-dedup; the server only surfaces intent here.
    if (cfg.autoStopLateTwin) {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'respawn_twin_autostop_intent',
        field_changed: 'respawn_twin',
        old_value: '', new_value: JSON.stringify({ role, late_twin_id: lateTwin.subagent_id }),
        ticket_id: ticket.id, actor_id: 'system', actor_name: 'RespawnStormDetector',
        role, trigger_source: 'respawn_storm',
      });
    }

    this.logService.warn('RespawnStorm', 'twin detected', {
      ticket_id: ticket.id, role, live_count: live.length, late_twin_id: lateTwin.subagent_id,
    });

    if (cfg.notify) {
      const lines = [
        `👯 **Twin strands detected** — \`${ticket.id}\``,
        `**${ticket.title}**`,
        `role: ${role} · concurrent live strands: ${live.length}`,
        cfg.autoStopLateTwin
          ? `Autostop intent recorded for late strand \`${lateTwin.subagent_id}\`.`
          : 'Detection-only. The late strand should self-exit via agent-manager dedup.',
        `[Open ticket](/ws/${ticket.workspace_id}/ticket/${ticket.id})`,
      ];
      await this._postAlert(ticket.workspace_id, lines.join('\n\n'), ticket.id);
    }
  }

  /** Best-effort last output line(s) from the most-recently-ended dead strand. */
  private async _lastOutputTail(deaths: Subagent[], max = 200): Promise<string> {
    if (deaths.length === 0) return '';
    const newest = [...deaths].sort((a, b) =>
      (b.ended_at?.getTime() ?? 0) - (a.ended_at?.getTime() ?? 0))[0];
    try {
      const line = await this.dataSource.getRepository(SubagentLogLine)
        .createQueryBuilder('l')
        .where('l.subagent_id = :sid', { sid: newest.subagent_id })
        .orderBy('l.seq', 'DESC')
        .limit(1)
        .getOne();
      if (!line?.line) return '';
      const flat = line.line.replace(/\s+/g, ' ').trim();
      return flat.length <= max ? flat : flat.slice(0, max - 1) + '…';
    } catch {
      return '';
    }
  }

  private async _postAlert(workspaceId: string, content: string, ticketId: string): Promise<void> {
    const roomId = await this._resolveAlertRoomId(workspaceId);
    if (!roomId) {
      this.logService.warn('RespawnStorm', 'no chat room for alert — skipping post', {
        ticket_id: ticketId, workspace_id: workspaceId,
      });
      return;
    }
    try {
      await this.messaging.sendSystemMessage(roomId, workspaceId, content);
    } catch (e) {
      this.logService.error('RespawnStorm', 'alert post failed', {
        err: String(e), ticket_id: ticketId, room_id: roomId,
      });
    }
  }

  /** Copy of the stuck-detector resolution: configured alerts room → oldest room. */
  private async _resolveAlertRoomId(workspaceId: string): Promise<string | null> {
    if (!workspaceId) return null;
    const ws = await this.dataSource.getRepository(Workspace).findOne({ where: { id: workspaceId } });
    const roomRepo = this.dataSource.getRepository(ChatRoom);
    if (ws?.alerts_chat_room_id) {
      const configured = await roomRepo.findOne({
        where: { id: ws.alerts_chat_room_id, workspace_id: workspaceId },
      });
      if (configured) return configured.id;
    }
    const fallback = await roomRepo
      .createQueryBuilder('r')
      .where('r.workspace_id = :wsId', { wsId: workspaceId })
      .orderBy('r.created_at', 'ASC')
      .limit(1)
      .getOne();
    return fallback?.id ?? null;
  }

  private async _loadBoardConfigs(): Promise<Map<string, ResolvedRespawnStorm>> {
    const boards = await this.dataSource.getRepository(Board).find();
    const map = new Map<string, ResolvedRespawnStorm>();
    for (const b of boards) {
      map.set(b.id, resolveRespawnStormConfig(b.respawn_storm_config, this.baseline));
    }
    return map;
  }

  /** Resolve each ticket + its board_id (ticket → column → board), batched. */
  private async _loadTicketsWithBoard(
    ticketIds: string[],
  ): Promise<Map<string, { ticket: Ticket; boardId: string | null }>> {
    const out = new Map<string, { ticket: Ticket; boardId: string | null }>();
    if (ticketIds.length === 0) return out;
    const tickets = await this.dataSource.getRepository(Ticket).findByIds(ticketIds);
    const colIds = Array.from(new Set(tickets.map(t => t.column_id).filter(Boolean) as string[]));
    const cols = colIds.length
      ? await this.dataSource.getRepository(BoardColumn).findByIds(colIds)
      : [];
    const boardByCol = new Map(cols.map(c => [c.id, c.board_id]));
    for (const t of tickets) {
      const boardId = t.column_id ? (boardByCol.get(t.column_id) ?? null) : null;
      out.set(t.id, { ticket: t, boardId });
    }
    return out;
  }

  // ─────────────────────────── Dashboard helpers ────────────────────────────

  /** Test/admin helper — read the resolved baseline config. */
  getBaseline(): ResolvedRespawnStorm {
    return { ...this.baseline };
  }

  /**
   * Tickets currently halted by a respawn storm (pended by this detector), with
   * board context. Powers the "active storms/halts" dashboard tile.
   */
  async listActiveStorms(): Promise<Array<{
    ticket_id: string; title: string; board_id: string; board_name: string;
    workspace_id: string; pending_reason: string; pending_set_at: Date | null;
  }>> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const halted = await ticketRepo.find({
      where: { pending_user_action: true, pending_set_by: 'RespawnStormDetector' },
    });
    if (halted.length === 0) return [];
    const withBoard = await this._loadTicketsWithBoard(halted.map(t => t.id));
    const boardNames = await this._boardNameMap(
      Array.from(withBoard.values()).map(v => v.boardId).filter(Boolean) as string[],
    );
    return halted.map(t => {
      const boardId = withBoard.get(t.id)?.boardId ?? '';
      return {
        ticket_id: t.id, title: t.title,
        board_id: boardId || '', board_name: boardId ? (boardNames.get(boardId) ?? '(unknown)') : '(no board)',
        workspace_id: t.workspace_id, pending_reason: t.pending_reason,
        pending_set_at: t.pending_set_at,
      };
    });
  }

  /**
   * Top (ticket, role) pairs by abnormal quick-death count inside `windowMs`.
   * `boardId` optionally scopes the rollup to one board.
   */
  async topRespawnCounts(opts: { windowMs?: number; limit?: number; boardId?: string; now?: Date } = {}): Promise<Array<{
    ticket_id: string; title: string; role: string; board_id: string; board_name: string; deaths: number;
  }>> {
    const now = opts.now ?? new Date();
    const windowMs = opts.windowMs ?? this.baseline.windowMs;
    const limit = opts.limit ?? 10;
    const since = new Date(now.getTime() - windowMs);
    const rows = await this.dataSource.getRepository(Subagent)
      .createQueryBuilder('s')
      .where('s.started_at >= :since', { since })
      .andWhere('s.ticket_id IS NOT NULL')
      .andWhere("s.role IS NOT NULL AND s.role != ''")
      .getMany();

    const counts = new Map<string, { ticketId: string; role: string; deaths: number }>();
    for (const r of rows) {
      if (!this._isQuickAbnormalDeath(r, this.baseline.quickDeathMs, since)) continue;
      const key = `${r.ticket_id} ${r.role}`;
      const c = counts.get(key) ?? { ticketId: r.ticket_id as string, role: r.role as string, deaths: 0 };
      c.deaths += 1;
      counts.set(key, c);
    }
    if (counts.size === 0) return [];

    const ticketIds = Array.from(new Set(Array.from(counts.values()).map(c => c.ticketId)));
    const withBoard = await this._loadTicketsWithBoard(ticketIds);
    const boardNames = await this._boardNameMap(
      Array.from(withBoard.values()).map(v => v.boardId).filter(Boolean) as string[],
    );

    let list = Array.from(counts.values()).map(c => {
      const entry = withBoard.get(c.ticketId);
      const boardId = entry?.boardId ?? '';
      return {
        ticket_id: c.ticketId, title: entry?.ticket.title ?? '(ticket missing)', role: c.role,
        board_id: boardId || '',
        board_name: boardId ? (boardNames.get(boardId) ?? '(unknown)') : '(no board)',
        deaths: c.deaths,
      };
    });
    if (opts.boardId) list = list.filter(x => x.board_id === opts.boardId);
    list.sort((a, b) => b.deaths - a.deaths);
    return list.slice(0, limit);
  }

  private async _boardNameMap(boardIds: string[]): Promise<Map<string, string>> {
    const ids = Array.from(new Set(boardIds));
    if (ids.length === 0) return new Map();
    const boards = await this.dataSource.getRepository(Board).findByIds(ids);
    return new Map(boards.map(b => [b.id, b.name]));
  }

  /**
   * Full workflow-health rollup for the admin dashboard. `boardId` optionally
   * scopes everything to one board; omitted = workspace-wide (all boards).
   * Every sub-rollup is defensive — a failing query degrades that tile to a
   * zero/empty value rather than 500-ing the whole dashboard.
   */
  async getWorkflowHealth(opts: { boardId?: string; now?: Date } = {}): Promise<{
    generated_at: string;
    window_minutes: number;
    active_storms: Awaited<ReturnType<RespawnStormDetectorService['listActiveStorms']>>;
    top_respawns: Awaited<ReturnType<RespawnStormDetectorService['topRespawnCounts']>>;
    stale_wait_alerts: number;
    pending_tickets: number;
    avg_cycle_time_ms: number | null;
    qa_pass_trend: { passed: number; failed: number; error: number; total: number };
  }> {
    const now = opts.now ?? new Date();
    const windowMs = this.baseline.windowMs;

    const activeStorms = await this.listActiveStorms().catch(() => []);
    const topRespawns = await this.topRespawnCounts({ now, boardId: opts.boardId }).catch(() => []);

    // Scope helper: which ticket column_ids belong to boardId (if scoped).
    const scopedColIds = opts.boardId
      ? (await this.dataSource.getRepository(BoardColumn)
          .find({ where: { board_id: opts.boardId } })).map(c => c.id)
      : null;

    // Stale-WAIT alerts (StuckTicketDetector rows). Scope by ticket→column.
    let staleWait = 0;
    try {
      const alerts = await this.dataSource.getRepository(StuckTicketAlert).find();
      if (!scopedColIds) {
        staleWait = alerts.length;
      } else {
        const tickets = await this.dataSource.getRepository(Ticket).findByIds(alerts.map(a => a.ticket_id));
        const colSet = new Set(scopedColIds);
        staleWait = tickets.filter(t => t.column_id && colSet.has(t.column_id)).length;
      }
    } catch { staleWait = 0; }

    // Pending tickets (any reason).
    let pending = 0;
    try {
      const qb = this.dataSource.getRepository(Ticket).createQueryBuilder('t')
        .where('t.pending_user_action = :p', { p: true });
      if (scopedColIds) {
        if (scopedColIds.length === 0) { pending = 0; }
        else { qb.andWhere('t.column_id IN (:...cols)', { cols: scopedColIds }); pending = await qb.getCount(); }
      } else {
        pending = await qb.getCount();
      }
    } catch { pending = 0; }

    // Avg cycle time — created_at → terminal_entered_at for tickets that reached
    // a terminal column (bounded to the last 30 days to stay a "recent" signal).
    let avgCycleMs: number | null = null;
    try {
      const since = new Date(now.getTime() - 30 * 24 * 3_600_000);
      const qb = this.dataSource.getRepository(Ticket).createQueryBuilder('t')
        .where('t.terminal_entered_at IS NOT NULL')
        .andWhere('t.terminal_entered_at >= :since', { since });
      if (scopedColIds) {
        if (scopedColIds.length === 0) throw new Error('no columns');
        qb.andWhere('t.column_id IN (:...cols)', { cols: scopedColIds });
      }
      const done = await qb.getMany();
      const spans = done
        .map(t => (t.terminal_entered_at as Date).getTime() - new Date(t.created_at).getTime())
        .filter(ms => ms >= 0);
      avgCycleMs = spans.length ? Math.round(spans.reduce((a, b) => a + b, 0) / spans.length) : null;
    } catch { avgCycleMs = null; }

    // QA pass trend — recent QaRun terminal statuses (last 7 days).
    const qaTrend = { passed: 0, failed: 0, error: 0, total: 0 };
    try {
      const since = new Date(now.getTime() - 7 * 24 * 3_600_000);
      const qb = this.dataSource.getRepository(QaRun).createQueryBuilder('q')
        .where('q.created_at >= :since', { since });
      if (opts.boardId) qb.andWhere('q.board_id = :bid', { bid: opts.boardId });
      const runs = await qb.getMany();
      for (const r of runs) {
        if (r.status === 'passed') qaTrend.passed += 1;
        else if (r.status === 'failed') qaTrend.failed += 1;
        else if (r.status === 'error') qaTrend.error += 1;
      }
      qaTrend.total = qaTrend.passed + qaTrend.failed + qaTrend.error;
    } catch { /* leave zeros */ }

    return {
      generated_at: now.toISOString(),
      window_minutes: Math.round(windowMs / 60_000),
      active_storms: activeStorms,
      top_respawns: topRespawns,
      stale_wait_alerts: staleWait,
      pending_tickets: pending,
      avg_cycle_time_ms: avgCycleMs,
      qa_pass_trend: qaTrend,
    };
  }
}
