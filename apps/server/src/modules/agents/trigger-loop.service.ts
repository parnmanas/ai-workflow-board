import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In } from 'typeorm';
import { randomUUID } from 'crypto';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Agent } from '../../entities/Agent';
import { PromptTemplate } from '../../entities/PromptTemplate';
import { Resource } from '../../entities/Resource';
import { Workspace } from '../../entities/Workspace';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { Comment } from '../../entities/Comment';
import { LogService } from '../../services/log.service';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { GitHubConnectorService, parseGitHubUrl } from '../../services/github-connector.service';
import { AgentWorkloadService } from './agent-workload.service';
import { AgentStatusService } from './agent-status.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { priorityIndex } from './priority';
import { appendBoardLanguageInstruction, resolveHarnessConfig, HarnessConfig } from '../../common/harness-config';
import { resolveEffortPreset, ResolvedEffortPreset } from '../../common/effort-presets';
import { mergeEnvironmentConfig, resolveEnvironmentConfig, ResolvedEnvironmentConfig } from '../../common/environment-config';
import { resolveBoardUsePr, resolveBoardWorktreeMode, resolveWorktreeRelPath, renderUsePrTemplate, WorktreeMode } from '../../common/worktree-config';
import { appendBoardLessons, MAX_INJECTED_LESSONS } from '../../common/board-lessons';
import { BoardLesson } from '../../entities/BoardLesson';
import { isConsensusVoteComment } from '../../common/consensus-meta';

// Sentinel actor written onto auto-advance `moved` activities. Deliberately
// non-'system' so the trigger loop re-enters and processes the destination
// column (the 'system' actor short-circuits at the top of `_handleActivity`).
// Single string constant so audit greps and tests can match it.
const AUTO_ADVANCE_ACTOR_ID = 'auto-advance';
const AUTO_ADVANCE_ACTOR_NAME = 'Auto-Advance';

// Pure SSE emitter. The AgentTrigger DB table was removed in v0.25.0 —
// delivery is fire-and-forget. Backstop for dropped SSE is now
// TicketSupervisorService (server-side), which re-pushes stale allocations.
// No cooldown here (the plugin dedupes in-session by trigger_id), no TTL
// sweep (no persistence).
//
// Activities we convert to agent_trigger events:
//   - 'moved': ticket moved to a new column
//   - 'created' on entity_type 'comment': new comment on a ticket
//   - 'updated': ticket field changed
//
// All resolve the ticket's current column, look up routing_config, and emit
// one agent_trigger per (role, role-holding agent_id) pair — but ONLY if
// the (agent, board, role) focus selector picks THIS ticket. Non-focus
// triggers are silently dropped (no DB row, no SSE emit) so a board with
// N parked tickets doesn't thrash the agent.
//
// Focus gate (ticket 4a6cdfd7):
//   - `AgentWorkloadService.getFocusTicket(agent, board, role)` returns
//     the single ticket id that the agent should be working on for this
//     (board, role) right now. Trigger emits iff the candidate ticket is
//     that focus ticket.
//   - Manual triggers (`emitManualTrigger`) explicitly opt out of the
//     gate via `opts.bypassFocus = true` — they're deliberate user
//     overrides and the audit trail already records the human / agent
//     actor on the `trigger_dispatched` row.

const COMMENT_ACTION = 'created';
const COMMENT_ENTITY = 'comment';

@Injectable()
export class TriggerLoopService implements OnModuleInit, OnModuleDestroy {
  // Stored reference so OnModuleDestroy can detach the listener. In
  // production this is harmless (single init, process lives until restart),
  // but integration test rigs build/tear down the Nest module per spec —
  // without removal the listener count grows by one per spec until the
  // EventEmitter's MaxListenersExceededWarning fires. Finding-004 in
  // docs/audit/2026-05-system-cascade-audit.md.
  private _activityListener?: (log: ActivityLog) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly agentWorkload: AgentWorkloadService,
    private readonly agentStatus: AgentStatusService,
    private readonly activityService: ActivityService,
    private readonly ticketPrerequisites: TicketPrerequisitesService,
  ) {}

  onModuleInit() {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _handleActivity', { err: e });
      });
    };
    activityEvents.on('activity', this._activityListener);
  }

  onModuleDestroy() {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
  }

  private async _handleActivity(log: ActivityLog): Promise<void> {
    if (!log.ticket_id) return;

    // Prereq cascade (ticket 48d14fff) — a ticket that other tickets depend on
    // was archived. Drop those links, re-evaluate each dependent, and wake any
    // that just lost their last open prereq. Runs ahead of the trigger-source
    // switch ('archived' is neither moved/comment/update so it would return
    // below) AND ahead of the system-actor gate (the auto-archiver sweep writes
    // a system-ish actor and we still want the cascade). Delete is handled at
    // the delete chokepoints themselves — by the time a 'deleted' activity
    // fires, the row + its FK-cascaded links are already gone, so there is
    // nothing left here to read.
    if (log.action === 'archived') {
      await this._resumePrerequisiteDependents(log.ticket_id, log.actor_id || '', 'prerequisite_archived');
      return;
    }

    let triggerSource: string;
    if (log.action === 'moved') {
      triggerSource = 'column_move';
    } else if (log.entity_type === COMMENT_ENTITY && log.action === COMMENT_ACTION) {
      triggerSource = 'comment';
    } else if (log.action === 'updated') {
      // Comment edits never re-trigger. The runaway loop on 2026-05-28 fired
      // here: silent_exit dedupe writes a comment.updated activity (field_changed
      // 'repeat_count'); without this guard the comment.updated landed in the
      // ticket_update arm, woke the same agent that just silent-exited, fired
      // another silent-exit, and so on — 131k cycles in a single afternoon. We
      // sourced the audit row from the SAME runaway in `agent-api.controller.ts`
      // (now stamps actor_id='system'), but the guard here is defence-in-depth:
      // any future comment-edit path, no matter how it's stamped, is contained.
      if (log.entity_type === COMMENT_ENTITY) return;
      triggerSource = 'ticket_update';
    } else {
      return;
    }

    // Skip system-generated activity to prevent loops. Also covers actor_id===''
    // (the legacy default for plugin / agent-manager-emitted system events) —
    // a real human actor always carries a UUID, so an empty string here is
    // categorically a system emit that mustn't self-trigger.
    if (log.actor_id === 'system' || log.actor_id === '') return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket) return;

    // v0.41 — column resolution is column-id driven, not name-driven.
    // The ticket's current column_id is the ground truth (the previous
    // code resolved by lowercased column name to look up routing_config,
    // a hardcoded path now banned). For 'moved' activities the ticket
    // already points at the destination column row by the time the
    // ActivityLog is written, so reading ticket.column_id covers both
    // cases without a name match.
    if (!ticket.column_id) return;
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!col) return;

    // Terminal columns never trigger themselves. Completion is the
    // terminal column's job. But a terminal landing can hand off to the
    // next ticket in a chain: if `column_move` lands on a terminal column
    // AND the moved ticket has `next_ticket_id` set, dispatch a
    // `trigger_source: 'next_ticket'` round for the linked ticket's
    // current column. This is the only path where one ticket's activity
    // wakes a different ticket's roles.
    const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (isTerminal) {
      if (log.action === 'moved' && ticket.next_ticket_id) {
        await this._dispatchNextTicket(ticket, log.actor_id || '');
      }
      // Prereq auto-resume (ticket 48d14fff): this ticket just landed on a
      // terminal column. Wake every dependent whose full prereq set is now
      // satisfied. The backward M:N pull counterpart to next_ticket's forward
      // 1:1 push above — both fire on the same terminal-landing event but a
      // dependent stays blocked until ALL its prereqs are terminal.
      if (log.action === 'moved') {
        await this._resumePrerequisiteDependents(ticket.id, log.actor_id || '', 'prerequisite_reached');
      }
      // Self-improvement: when a ticket lands on a terminal column AND the
      // board opts in via `self_improvement_mode != 'off'`, dispatch a
      // `ticket_done_review` trigger to the reviewer so they can analyse
      // what just shipped and file follow-up improvement tickets.
      // Gated tightly by `_dispatchPostDoneReview` (action=moved, reviewer
      // assignment exists, recursion-guard label not set).
      if (log.action === 'moved') {
        await this._dispatchPostDoneReview(ticket, col.board_id, log.actor_id || '');
      }
      return;
    }

    // Benchmark evaluator dispatch (ticket 684c012b). A candidate child that
    // lands on a `review`-kind column is scored by the run's evaluator agents
    // rather than flowing through the normal reviewer routing — evaluators are
    // recorded on the run as `evaluator:<id>` labels (not reviewer role
    // assignments, which are unique per (ticket, role)). This branch is gated
    // strictly on the `benchmark-candidate` label so non-benchmark tickets are
    // entirely unaffected. We RETURN after dispatching so the candidate parks
    // in Review for scoring instead of auto-advancing past it (it has an
    // assignee but no reviewer, which would otherwise trip `_autoAdvanceUnassigned`).
    if (log.action === 'moved' && (col as any).kind === 'review') {
      const candidateLabels = safeJsonParse<string[]>((ticket as any).labels, []);
      if (Array.isArray(candidateLabels) && candidateLabels.includes('benchmark-candidate')) {
        await this._dispatchBenchmarkEvaluators(ticket, col, log.actor_id || '');
        return;
      }
    }

    // v0.41 — read role slugs straight off the column row. Replaces the
    // old `Board.routing_config[col.name.toLowerCase()]` lookup; column
    // name compares are forbidden in the dispatch path.
    const roles = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(roles) || roles.length === 0) return;

    // Resolve role slugs against the ticket's workspace roles + assignments.
    // Pre-v0.34 this loop indexed `ROLE_TO_FIELD[role]` and read the agent ID
    // off `ticket.assignee_id` / `reporter_id` / `reviewer_id`. Now slugs are
    // workspace-scoped so we look up the WorkspaceRole row, then the
    // TicketRoleAssignment that pins a holder onto this ticket.
    //
    // Two-phase: gather every (slug, role, holder) tuple before dispatch so the
    // auto-advance check below can ask "did ANY routed role on this column
    // resolve to a holder on this ticket?". A single-pass loop that emits + skips
    // can't answer that without a second scan.
    // 다중담당자 T2 (#1): resolve EVERY agent holder of each routed slug, not
    // just the first. `_resolveRoleHolders` returns the WorkspaceRole plus its
    // distinct agent holders (earliest-created first; user holders skipped —
    // humans receive no agent_trigger). The two-phase gather is still what the
    // auto-advance / halt decision below reads via `columnHasHolder`.
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);
    const resolved: Array<{ slug: string; role: WorkspaceRole; targetAgentIds: string[] }> = [];
    for (const slug of roles) {
      const holders = await this._resolveRoleHolders(ticket, slug);
      if (!holders) continue;
      resolved.push({ slug, role: holders.role, targetAgentIds: holders.agentIds });
    }

    // AUTO-ADVANCE vs HALT (ticket c5951280). A non-terminal column with no
    // servable holder used to mean a single thing — "push the ticket forward".
    // That one heuristic conflated two very different situations and produced
    // two opposite failure modes:
    //   ① over-advance: a *completely unassigned* ticket (no holder on ANY
    //      role) registered as "no holder" at every column and cascaded
    //      silently Backlog → Done. Parn's "skip the no-owner case" exception
    //      was never in the code.
    //   ② under-advance / infinite wait: a column whose routed slugs don't
    //      resolve to a WorkspaceRole at all (`resolved.length === 0`, config
    //      drift) fell OUT of the old `resolved.length > 0` advance condition
    //      and stalled forever with nobody to wake.
    //
    // Fix: split the judgment into two independent axes —
    //   1. Is THIS column servable? `columnHasHolder` — does any routed slug
    //      resolve to a real WorkspaceRole AND have a holder on this ticket.
    //      An unservable column is one nobody routed here can work: covers both
    //      `resolved.length === 0` (config drift) and `resolved.length > 0 &&
    //      every holder null` (routed but unstaffed). A partially-filled column
    //      (e.g. Review → ['reviewer','assignee'] with assignee set) IS
    //      servable — `columnHasHolder` is true, we skip the advance/halt
    //      branch and emit to the filled role(s) in the per-role loop below.
    //   2. Is the TICKET staffed at all? `_ticketHasAnyHolder` — does ANY role
    //      on the ticket (not just this column's routed roles) have a holder.
    //      The reporter counts (a reporter-only follow-up is staffed enough to
    //      cascade through active stages; the gate guard below still stops it
    //      before any review/merging gate — ticket cc48f06f / 519fad18).
    //
    // Decision when the column is unservable (column_move only — comments and
    // ticket-field updates are local events that must not shove an unrelated
    // ticket downstream just because its column lacks a holder):
    //   - ticket staffed elsewhere → this stage is a legitimate skip; advance
    //     to the next non-terminal column. Cases (b) empty Review with an
    //     assignee set, and (c) slug→role config-drift column — both fill the
    //     would-be dead-end and move on.
    //   - ticket completely unassigned → HALT in place + flag (case a). Never
    //     cascade a no-owner ticket to Done; a human has to assign someone.
    //
    // Pending-user-action gate (ticket a57517be):
    // A ticket parked behind pending_user_action does not auto-advance — the
    // whole point of the flag is to stop the System ↔ Agent column ping-pong
    // and wait for a human. The trigger-emit gate below also drops events for
    // pending tickets, but `_autoAdvanceUnassigned` is a separate side-channel
    // (it doesn't call `_emitTrigger`) so it needs its own short-circuit here.
    if (ticket.pending_user_action || ticket.pending_on_tickets) {
      this.logService.info('MCP', 'auto_advance skipped (ticket pending)', {
        ticket_id: ticket.id, current_column_id: col.id,
        pending_user_action: !!ticket.pending_user_action,
        pending_on_tickets: !!ticket.pending_on_tickets,
      });
      return;
    }

    const columnHasHolder = resolved.some((r) => r.targetAgentIds.length > 0);
    if (triggerSource === 'column_move' && !columnHasHolder) {
      if (this._isGateColumn(col)) {
        // GATE COLUMN (review / merging) with no holder — never auto-advance a
        // gate, in OR out (ticket cc48f06f). The benchmark short-circuit at the
        // top of this method already parks a `benchmark-candidate` on a review
        // column rather than letting it auto-advance past; this generalizes that
        // to every review/merging gate and every ticket. A reviewer/merger seat
        // must be staffed by a human — silently skipping it produces a
        // "ready to merge" ticket with zero review (a3d25202 live repro). Halt
        // in place + flag regardless of whether the ticket is staffed elsewhere.
        await this._flagGateHalt(ticket, col, col);
      } else if (await this._ticketHasAnyHolder(ticket.id)) {
        // Staffed somewhere else — this empty stage is an intended skip.
        await this._autoAdvanceUnassigned(ticket, col);
      } else {
        // Orphan ticket — halt where it sits and flag; do not cascade to Done.
        await this._flagUnassignedHalt(ticket, col);
      }
      return;
    }

    // 다중담당자 T2 fan-out (#1 / #2 / #6). Emit to EVERY holder of each routed
    // slug, with three refinements over the single-holder loop:
    //   - agent_id dedup (`emittedAgentIds`): a 겸직 agent that holds several
    //     routed roles on this column wakes ONCE (carrying the first routed role
    //     it holds, role_routing order). Deduping avoids the twin-subagent
    //     double-spawn a single-agent-multi-role ticket would otherwise get.
    //   - the self-trigger guard is applied PER HOLDER: the actor being one
    //     holder of a role must not re-wake ITSELF, but the OTHER holders of
    //     that role still fan out.
    //   - a comment fanned out to non-author holders passes through the
    //     recursion-prevention hook so consensus/vote comments don't ping-pong.
    const emittedAgentIds = new Set<string>();
    let commentFanoutSuppressed: boolean | null = null;
    for (const { slug, role, targetAgentIds } of resolved) {
      for (const targetAgentId of targetAgentIds) {
        if (!targetAgentId) continue;
        // Self-trigger guard, action-type aware (v0.34 onward, refined v0.41,
        // per-holder in T2). Only the ACTOR's own emit is gated here — other
        // holders of the same role are always candidates (T2 #2).
        //
        //   - comment / ticket_update: same agent_id implies the actor's own
        //     role context — re-firing on the same (ticket, role) would just
        //     wake the same persistent subagent that just produced the event,
        //     which is a deadlock-shaped feedback loop. Always skip.
        //
        //   - column_move: the destination column may shift role responsibility
        //     (e.g. Review → Merging changes owner from reviewer → assignee).
        //     With v0.34's per-(ticket, role) plugin subagents, a SAME-agent
        //     DIFFERENT-role transition spawns a separate subagent for the new
        //     role — there's no LLM-level loop to prevent and dropping the
        //     trigger would silently deadlock single-agent multi-role workflows
        //     (a single AWB agent holding assignee+reviewer+merger on the same
        //     ticket is the production default).
        //
        //     But a SAME-agent SAME-role transition (e.g. assignee moves their
        //     own ticket To Do → In Progress, both columns route to assignee)
        //     IS a self-loop: the actor just performed the move that would
        //     have triggered them, and re-emitting just spawns a redundant
        //     subagent.
        //
        //     Discriminator: the actor is in role-shift (don't skip) iff the
        //     actor holds at least one role on THIS ticket that is NOT the
        //     target role. Otherwise the actor's only role is the target
        //     role, the move is a same-role self-action, and we skip.
        if (targetAgentId === log.actor_id) {
          if (triggerSource !== 'column_move') continue;
          const actorAssignments = await assignRepo.find({
            where: { ticket_id: ticket.id, agent_id: log.actor_id || '' },
          });
          const hasOtherRole = actorAssignments.some(
            (a) => a.role_id && a.role_id !== role.id,
          );
          if (!hasOtherRole) continue;
        } else if (triggerSource === 'comment') {
          // Non-author holder on a comment trigger — the fan-out target
          // (author≠holder). Recursion-prevention hook (T2 #6): a
          // consensus/vote comment must NOT re-dispatch the other holders, or
          // mutual holder comments ping-pong into an infinite re-trigger loop
          // (the self-echo / watchdog exit-143 failure family). Resolve the
          // suppression verdict lazily, once per activity.
          if (commentFanoutSuppressed === null) {
            commentFanoutSuppressed = await this._commentSuppressesFanout(log);
          }
          if (commentFanoutSuppressed) continue;
        }

        // agent_id dedup: one physical agent wakes at most once per dispatch.
        if (emittedAgentIds.has(targetAgentId)) continue;
        emittedAgentIds.add(targetAgentId);

        await this._emitTrigger(ticket, targetAgentId, slug, triggerSource, log.actor_id || '');
      }
    }
  }

  /**
   * 다중담당자 T2 fan-out primitive. Resolve a routed role slug against the
   * ticket's workspace to its WorkspaceRole and the DISTINCT agent holders of
   * that role on the ticket, earliest-created first (deterministic order,
   * mirroring the T1 `getOne` tiebreak). User holders are skipped — humans
   * receive no agent_trigger. Returns null when the slug maps to no
   * WorkspaceRole (config drift); an empty `agentIds` means the role exists but
   * has no agent holder (vacant / user-only) — the caller reads that as
   * "column unservable by an agent".
   *
   * Query shape matches the pre-fan-out single-holder lookup (one role findOne
   * + one assignment read) — it turns the old `findOne` into a `find`, so
   * fanning out does NOT add an N+1 per slug.
   */
  private async _resolveRoleHolders(
    ticket: Ticket,
    slug: string,
  ): Promise<{ role: WorkspaceRole; agentIds: string[] } | null> {
    const role = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: ticket.workspace_id, slug },
    });
    if (!role) return null;
    const rows = await this.dataSource.getRepository(TicketRoleAssignment).find({
      where: { ticket_id: ticket.id, role_id: role.id },
      order: { created_at: 'ASC', id: 'ASC' },
    });
    const seen = new Set<string>();
    const agentIds: string[] = [];
    for (const r of rows) {
      const a = r.agent_id;
      if (a && !seen.has(a)) {
        seen.add(a);
        agentIds.push(a);
      }
    }
    // Agent Manager(type='manager')는 절대 트리거 대상이 아니다 (ticket 941c72d3).
    // 이미 배정돼 있던 manager holder 도 여기서 제외해, 컬럼-서비스가능 판정
    // (columnHasHolder = agentIds.length > 0) 이 manager 만으로 성립해 자동 이동을
    // 막아버리는 일이 없게 한다.
    const nonManager = await this._excludeManagerAgents(agentIds);
    return { role, agentIds: nonManager };
  }

  /**
   * 주어진 agent_id 목록에서 manager(type='manager')를 제거해 반환 (ticket 941c72d3).
   * manager 가 하나도 없으면 입력 배열을 그대로 돌려준다(추가 질의 없음).
   */
  private async _excludeManagerAgents(agentIds: string[]): Promise<string[]> {
    if (agentIds.length === 0) return agentIds;
    const managers = await this.dataSource.getRepository(Agent).find({
      where: { id: In(agentIds), type: 'manager' },
      select: ['id'],
    });
    if (managers.length === 0) return agentIds;
    const managerSet = new Set(managers.map(a => a.id));
    return agentIds.filter(a => !managerSet.has(a));
  }

  /**
   * 다중담당자 T2 recursion-prevention hook (#6). A comment authored by one
   * holder of a routed role fans out a re-trigger to the OTHER holders
   * (author≠holder). Left unchecked, mutual holder comments ping-pong into an
   * infinite re-trigger loop — the self-echo / watchdog exit-143 failure
   * family. This predicate is the single suppression point: a consensus / vote
   * comment must NOT re-dispatch the other holders.
   *
   * T4 introduces the consensus comment type and stamps `metadata.consensus_vote`
   * on it; until then nothing sets the marker so this returns false (no
   * behavior change) — securing the hook point is what T2 delivers. Consulted
   * only on the comment path and lazily (once per activity), so a normal note
   * on a single-holder role costs nothing. A missing / unreadable comment row
   * (tests fire synthetic comment activities with no backing row) reads as
   * "not a consensus comment" → false.
   *
   * The marker string + predicate live in `common/consensus-meta` (T3) so the
   * discussion tooling, the future T4 consensus tool, and this dispatch path all
   * agree on ONE definition of "this comment is a consensus vote" and cannot
   * drift on the literal key.
   */
  private async _commentSuppressesFanout(log: ActivityLog): Promise<boolean> {
    if (log.entity_type !== COMMENT_ENTITY || !log.entity_id) return false;
    const comment = await this.dataSource
      .getRepository(Comment)
      .findOne({ where: { id: log.entity_id } });
    if (!comment) return false;
    const meta = safeJsonParse<Record<string, unknown>>(comment.metadata, {});
    return isConsensusVoteComment(meta);
  }

  /**
   * Auto-advance an "unheld" ticket: when a non-terminal column triggered on a
   * column_move has no holder for any of its routed roles, push the ticket
   * forward to the next non-terminal column on the same board (ordered by
   * column.position ASC) so the workflow doesn't stall at an empty seat.
   *
   * Mechanics:
   *   - Mirrors the position-shift / column-id update done by the
   *     `move_ticket` MCP tool (close gap in source column, open slot in
   *     destination, set column_id/position) inside one transaction.
   *   - Writes a `moved` ActivityLog with actor_id=AUTO_ADVANCE_ACTOR_ID
   *     (deliberately NOT 'system' — the system-actor early-return at the top
   *     of _handleActivity would otherwise swallow the re-entry and the next
   *     column would never get its holders fired). The same row is what makes
   *     the UI render the move and what re-enters this loop, so the cascade
   *     continues until a column has a holder or the next column is terminal.
   *   - When there is no eligible next column (e.g. ticket already sits on
   *     the last non-terminal column), logs a skip and leaves the ticket put.
   *
   * Cascade safety: bounded by the column count on the board. Each iteration
   * lands on a strictly higher-position column, so the recursion can advance
   * at most `columns.length - currentPosition - 1` steps before either firing
   * a holder or running out of non-terminal columns.
   */
  private async _autoAdvanceUnassigned(
    ticket: Ticket,
    currentCol: BoardColumn,
  ): Promise<void> {
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const cols = await colRepo.find({
      where: { board_id: currentCol.board_id },
      order: { position: 'ASC' },
    });
    const nextCol = cols.find(
      (c) =>
        c.position > currentCol.position &&
        !((c as any).is_terminal === true || (c as any).kind === 'terminal'),
    );
    if (!nextCol) {
      this.logService.info('MCP', 'auto_advance skipped (no next non-terminal column)', {
        ticket_id: ticket.id,
        current_column_id: currentCol.id,
        current_column_position: currentCol.position,
      });
      return;
    }

    // GATE GUARD (ticket cc48f06f): never auto-advance an unstaffed ticket INTO
    // a review/merging gate column. Cascading through active stages (Plan, In
    // Progress) is fine, but a gate must be staffed by a human — auto-passing it
    // silently produces a "ready to merge" ticket with zero work/review
    // (a3d25202 live repro). Halt at the current (last active) column + flag,
    // leaving the ticket one short of the gate for a human to staff. NOTE this
    // checks the IMMEDIATE next non-terminal column only — we never skip OVER a
    // gate to land on a later active column, which would bypass the gate entirely.
    if (this._isGateColumn(nextCol)) {
      await this._flagGateHalt(ticket, currentCol, nextCol);
      return;
    }

    const fromPosition = ticket.position;
    const fromColumnId = currentCol.id;

    await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);

      // Close the gap left by the ticket in its current column (root tickets only).
      await tRepo
        .createQueryBuilder()
        .update()
        .set({ position: () => 'position - 1' })
        .where(
          'column_id = :colId AND position > :pos AND parent_id IS NULL',
          { colId: fromColumnId, pos: fromPosition },
        )
        .execute();

      // Land at the tail of the destination column.
      const destCount = await tRepo
        .createQueryBuilder('t')
        .where(
          't.column_id = :colId AND t.id != :id AND t.parent_id IS NULL',
          { colId: nextCol.id, id: ticket.id },
        )
        .getCount();

      // Auto-advance always moves between non-terminal columns (the loop
      // returns on terminal entry above), so terminal_entered_at can't be
      // stamped here — but defensively clear it in case a legacy row had
      // a stale stamp from a previous run.
      await tRepo.update(ticket.id, {
        column_id: nextCol.id,
        position: destCount,
        terminal_entered_at: null,
      });
    });

    // Emit the `moved` activity via ActivityService so SSE listeners (UI,
    // agent-manager) get the update AND the trigger loop re-enters with the
    // new column. Non-'system' actor keeps the early-return at the top of
    // _handleActivity from swallowing the re-entry.
    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'moved',
      field_changed: 'column',
      old_value: currentCol.name,
      new_value: nextCol.name,
      ticket_id: ticket.id,
      actor_id: AUTO_ADVANCE_ACTOR_ID,
      actor_name: AUTO_ADVANCE_ACTOR_NAME,
      role: '',
      trigger_source: 'auto_advance',
    });

    this.logService.info(
      'MCP',
      'auto_advance moved ticket forward (no holder for any routed role)',
      {
        ticket_id: ticket.id,
        from_column_id: fromColumnId,
        from_column_name: currentCol.name,
        to_column_id: nextCol.id,
        to_column_name: nextCol.name,
      },
    );
  }

  /**
   * Does this ticket have a holder on ANY role — agent OR user, across every
   * role on the ticket, not just the current column's routed roles? Drives the
   * auto-advance-vs-halt split (ticket c5951280): a ticket staffed somewhere
   * legitimately skips an unservable stage and advances, while a ticket with no
   * holder anywhere is an orphan that must halt in place and be flagged rather
   * than cascade silently to Done.
   *
   * Both `agent_id` and `user_id` count as a holder. A ticket whose only
   * holders are humans still has an owner who can act, so the empty agent-routed
   * stage is a legitimate skip — not the orphan case.
   *
   * The reporter IS counted (ticket cc48f06f / 519fad18): a reporter-only ticket
   * — the common shape of an agent-created follow-up, since create_ticket
   * auto-fills the reporter to the caller — is treated as "staffed enough" to
   * cascade through ACTIVE stages, but the gate guard (`_isGateColumn` /
   * `_flagGateHalt`) still halts it one short of the first review/merging gate so
   * it never silently skips to Done. The completely-unassigned (zero-holder)
   * orphan is the only case that halts on the spot via `_flagUnassignedHalt`.
   */
  private async _ticketHasAnyHolder(ticketId: string): Promise<boolean> {
    const count = await this.dataSource
      .getRepository(TicketRoleAssignment)
      .createQueryBuilder('a')
      .where('a.ticket_id = :ticketId', { ticketId })
      .andWhere(
        "((a.agent_id IS NOT NULL AND a.agent_id != '') OR (a.user_id IS NOT NULL AND a.user_id != ''))",
      )
      .getCount();
    return count > 0;
  }

  /**
   * Is this a review/merging GATE column? Gate columns require a human-staffed
   * holder (reviewer / merger) and must never be crossed by the auto-advance
   * cascade — neither entered nor exited while unstaffed (ticket cc48f06f).
   * Distinct from active columns, where an empty seat is a legitimate skip:
   * a gate's empty seat means "a human still has to staff this review", not
   * "nobody routed here, move along". Kept in one place so the caller-side
   * (cascade-OUT) and `_autoAdvanceUnassigned`-side (cascade-IN) guards agree.
   */
  private _isGateColumn(col: BoardColumn): boolean {
    const kind = (col as any).kind;
    return kind === 'review' || kind === 'merging';
  }

  /**
   * Halt + flag an unstaffed GATE-column crossing (ticket cc48f06f). The
   * auto-advance cascade reached a review/merging gate with no holder — either
   * the ticket sits ON the gate (`col === gateCol`, cascade-OUT, e.g. an empty
   * Review with only the assignee set) or the next forward column IS the gate
   * (`col` is the last active column before it, cascade-IN). Unlike
   * `_autoAdvanceUnassigned` we must NOT push through: a gate has to be staffed
   * by a human (assign a reviewer / merger), so the ticket halts in place and we
   * write a grepable `auto_advance_halted_gate` flag so the UI activity feed and
   * operator greps surface "stuck: gate needs staffing". `system` actor so the
   * row does NOT re-enter `_handleActivity` (it is not a move and carries no
   * holder to wake). Failing the write must not change the halt outcome.
   */
  private async _flagGateHalt(
    ticket: Ticket,
    col: BoardColumn,
    gateCol: BoardColumn,
  ): Promise<void> {
    this.logService.warn(
      'MCP',
      'auto_advance halted at gate (review/merging requires a staffed holder)',
      {
        ticket_id: ticket.id,
        column_id: col.id,
        column_name: col.name,
        gate_column_id: gateCol.id,
        gate_column_name: gateCol.name,
        gate_kind: (gateCol as any).kind,
      },
    );
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      await activityLogRepo.save(
        activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'TriggerLoopService',
          action: 'auto_advance_halted_gate',
          new_value: `column=${col.id} gate=${gateCol.id} gate_kind=${(gateCol as any).kind} reason=gate_requires_staffing`,
          role: '',
          trigger_source: 'auto_advance',
        }),
      );
    } catch (e) {
      this.logService.warn('MCP', 'auto_advance gate-halt flag write failed (halt still applied)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }

  /**
   * Halt + flag an ORPHAN ticket (ticket c5951280). The current non-terminal
   * column can't be served (no holder for any routed role) AND the ticket has
   * no holder on any role at all. Unlike `_autoAdvanceUnassigned` we must NOT
   * push it forward — a completely unassigned ticket cascading to Done is the
   * silent-flow bug (case ①) this ticket fixes. Leave it where it sits and
   * write a grepable warning flag so the UI activity feed and operator greps
   * surface "stuck: nobody assigned".
   *
   * The flag is an ActivityLog row with action `auto_advance_halted_unassigned`
   * and a `system` actor — `system` so the row does NOT re-enter
   * `_handleActivity` (it is not a move and carries no holder to wake; it's a
   * pure audit flag). Failing the write must not change the halt outcome.
   */
  private async _flagUnassignedHalt(
    ticket: Ticket,
    col: BoardColumn,
  ): Promise<void> {
    this.logService.warn(
      'MCP',
      'auto_advance halted (ticket fully unassigned — no holder on any role)',
      { ticket_id: ticket.id, column_id: col.id, column_name: col.name },
    );
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      await activityLogRepo.save(
        activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'TriggerLoopService',
          action: 'auto_advance_halted_unassigned',
          new_value: `column=${col.id} reason=no_holder_on_any_role`,
          role: '',
          trigger_source: 'auto_advance',
        }),
      );
    } catch (e) {
      this.logService.warn('MCP', 'auto_advance halt flag write failed (halt still applied)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }

  /**
   * Hand off from a finished ticket to its `next_ticket_id`: dispatch a
   * `trigger_source: 'next_ticket'` round for the linked ticket's CURRENT
   * column's routing roles. Mirrors the `column_move` loop body — workspace
   * scope, role-slug → WorkspaceRole → TicketRoleAssignment, one emit per
   * unique (slug, holder agent_id) pair.
   *
   * Skip cases (silent — log only):
   *   - linked ticket missing
   *   - linked ticket has no column (child / orphan)
   *   - linked column itself is terminal (would just dead-end)
   *   - linked column has no routing entry
   *   - role unset on the linked ticket (no holder to wake)
   *
   * `actorId` is the original mover so the activity log audit trail still
   * points at the human/agent who closed the source ticket.
   */
  /**
   * Prereq auto-resume sweep (ticket 48d14fff). A ticket either reached a
   * terminal column (`prerequisite_reached`) or was archived
   * (`prerequisite_archived`). Re-evaluate every dependent's full prereq set;
   * for each dependent that just lost its last open prereq, the service flips
   * `pending_on_tickets=false`. Here we log the unblock and wake the
   * dependent's current-column role holders.
   *
   *   - `reached` keeps the links (the prereq is satisfied in place and stays
   *     visible in get_ticket); `archived` drops them.
   *   - The unblock activity is written with a `system` actor on purpose so it
   *     does NOT re-enter `_handleActivity` and double-dispatch — this method
   *     dispatches explicitly via `dispatchCurrentColumn`.
   *   - `actorId` is the mover/archiver, carried onto the dispatch so the
   *     audit trail attributes the wake to the action that unblocked it.
   *
   * Edge note (moving a prereq back OUT of terminal): deliberately NOT handled
   * here. Once a dependent has been unblocked, re-blocking it is a human /
   * agent decision (per spec) — we never auto-re-block.
   */
  private async _resumePrerequisiteDependents(
    prereqTicketId: string,
    actorId: string,
    source: 'prerequisite_reached' | 'prerequisite_archived',
  ): Promise<void> {
    let unblocked: string[];
    try {
      unblocked =
        source === 'prerequisite_reached'
          ? await this.ticketPrerequisites.onPrerequisiteReached(prereqTicketId)
          : await this.ticketPrerequisites.onPrerequisiteRemoved(prereqTicketId);
    } catch (e) {
      this.logService.warn('MCP', 'prereq auto-resume evaluation failed (continuing)', {
        err: String(e), prereq_ticket_id: prereqTicketId, source,
      });
      return;
    }
    if (unblocked.length === 0) return;
    this.logService.info('MCP', 'prereq auto-resume unblocked dependents', {
      prereq_ticket_id: prereqTicketId, source, dependents: unblocked,
    });
    for (const dependentId of unblocked) {
      try {
        await this.activityService.logActivity({
          entity_type: 'ticket', entity_id: dependentId, action: 'updated',
          field_changed: 'pending_on_tickets',
          old_value: 'true', new_value: 'false',
          ticket_id: dependentId,
          // System actor — keeps this row from re-entering _handleActivity and
          // double-dispatching; we dispatch explicitly below.
          actor_id: 'system', actor_name: 'Auto-Resume',
          trigger_source: source,
        });
      } catch (e) {
        this.logService.warn('MCP', 'prereq unblock activity write failed (continuing)', {
          err: String(e), ticket_id: dependentId,
        });
      }
      try {
        await this.dispatchCurrentColumn(dependentId, 'prerequisite_resolved', actorId);
      } catch (e) {
        this.logService.warn('MCP', 'prereq auto-resume dispatch failed (continuing)', {
          err: String(e), ticket_id: dependentId,
        });
      }
    }
  }

  private async _dispatchNextTicket(sourceTicket: Ticket, actorId: string): Promise<void> {
    const nextId = sourceTicket.next_ticket_id;
    if (!nextId) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const nextTicket = await ticketRepo.findOne({ where: { id: nextId } });
    if (!nextTicket) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket missing)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }
    if (!nextTicket.column_id) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket has no column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }

    // v0.41 — resolve the linked ticket's column row by id. Routing reads
    // `BoardColumn.role_routing` directly; no Board.routing_config /
    // lowercased-name lookup is performed.
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: nextTicket.column_id } });
    if (!col) return;

    const nextIsTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (nextIsTerminal) {
      // The linked ticket already finished — nothing to do.
      this.logService.info('MCP', 'next_ticket dispatch skipped (linked ticket sits on terminal column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId,
      });
      return;
    }

    const roles = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(roles) || roles.length === 0) {
      this.logService.info('MCP', 'next_ticket dispatch skipped (no role_routing on linked column)', {
        source_ticket_id: sourceTicket.id, next_ticket_id: nextId, column_id: col.id,
      });
      return;
    }

    // 다중담당자 T2 (#1): fan out to EVERY agent holder of each routed slug,
    // deduped by agent_id across the whole chain dispatch (a 겸직 agent wakes
    // once, carrying the first routed role it holds). The focus selector inside
    // _emitTrigger still gates whether each emit actually lands.
    const emittedAgentIds = new Set<string>();
    for (const slug of roles) {
      const holders = await this._resolveRoleHolders(nextTicket, slug);
      if (!holders) continue;
      for (const targetAgentId of holders.agentIds) {
        if (emittedAgentIds.has(targetAgentId)) continue;
        emittedAgentIds.add(targetAgentId);
        // No self-trigger guard here — by definition the actor that closed the
        // source ticket may also hold a role on the next ticket, and we DO
        // want to wake that subagent now (the chain semantics promise it).
        await this._emitTrigger(nextTicket, targetAgentId, slug, 'next_ticket', actorId);
      }
    }
  }

  /**
   * Self-improvement dispatch: when a ticket lands on a terminal column,
   * wake the reviewer one more time with `trigger_source: 'ticket_done_review'`
   * so they can analyse the finished work and (optionally) file follow-up
   * improvement tickets — either on the same board or against the remote AWB
   * instance configured in admin SystemSetting.
   *
   * Gating (all must hold; first failure = silent skip):
   *   - board exists and `self_improvement_mode != 'off'`
   *   - ticket labels do NOT include 'self-improvement' (recursion guard —
   *     stops improvement tickets from spawning more improvement tickets)
   *   - workspace has a `reviewer` WorkspaceRole AND the ticket has a
   *     TicketRoleAssignment row pinning a reviewer agent
   *
   * Bypasses the focus selector via `bypassFocus: true` — the reviewer may
   * legitimately be focused on a different ticket but we still want them to
   * file the retrospective. This mirrors `emitManualTrigger` semantics.
   *
   * `actorId` is the human / agent that moved the ticket to Done; carried
   * through so the audit trail attributes the trigger to that mover.
   */
  private async _dispatchPostDoneReview(
    ticket: Ticket,
    boardId: string,
    actorId: string,
  ): Promise<void> {
    // Recursion guard: skip tickets that are themselves self-improvement
    // follow-ups so we don't loop. Labels live as a JSON string on the row.
    const labels = safeJsonParse<string[]>((ticket as any).labels, []);
    if (Array.isArray(labels) && labels.includes('self-improvement')) {
      this.logService.info('MCP', 'post_done_review skipped (recursion guard: self-improvement label)', {
        ticket_id: ticket.id,
      });
      return;
    }

    if (!boardId) return;
    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } });
    if (!board) return;
    const mode = (board as any).self_improvement_mode || 'off';
    if (mode === 'off') return;

    // Resolve reviewer holders (다중담당자 T2 #1 — every reviewer files their
    // own retrospective). Reuse the shared fan-out primitive so custom
    // workspace role naming still works — reviewer is a builtin slug
    // everywhere, so this is the common case.
    const reviewer = await this._resolveRoleHolders(ticket, 'reviewer');
    if (!reviewer) {
      this.logService.info('MCP', 'post_done_review skipped (no reviewer WorkspaceRole)', {
        ticket_id: ticket.id, workspace_id: ticket.workspace_id,
      });
      return;
    }
    if (reviewer.agentIds.length === 0) {
      this.logService.info('MCP', 'post_done_review skipped (no reviewer assigned)', {
        ticket_id: ticket.id,
      });
      return;
    }

    for (const reviewerAgentId of reviewer.agentIds) {
      await this._emitTrigger(
        ticket, reviewerAgentId, 'reviewer', 'ticket_done_review', actorId,
        {
          bypassFocus: true,
          columnPromptOverride: {
            template_id: 'self-improvement-inline',
            name: 'Self-Improvement Review',
            content: TriggerLoopService.SELF_IMPROVEMENT_PROMPT,
          },
        },
      );
    }
  }

  /**
   * Benchmark evaluator dispatch (ticket 684c012b): when a candidate child
   * lands on a `review`-kind column, wake every evaluator agent recorded on the
   * run so they score the candidate and call `submit_benchmark_score`.
   *
   * Evaluators are read from the RUN ticket's `evaluator:<agentId>` labels, not
   * from a reviewer role assignment — `TicketRoleAssignment` is unique on
   * (ticket, role) so the reviewer slot holds one agent, but a benchmark wants
   * an arbitrary evaluator pool. The score table + these labels model that.
   *
   * Gating (all must hold; first failure = silent skip):
   *   - the candidate carries the `benchmark-candidate` label (checked by caller)
   *   - the candidate has a parent run ticket
   *   - the run's board has `benchmark_mode = 'on'` (belt-and-suspenders so a
   *     stray label on an ordinary board does nothing)
   *   - the run carries at least one `evaluator:<id>` label
   *
   * Each evaluator trigger bypasses the focus selector (an evaluator may be
   * focused elsewhere but must still score) and carries an inline column prompt
   * telling the agent to score via `submit_benchmark_score`, mirroring how
   * `_dispatchPostDoneReview` injects the self-improvement prompt.
   */
  private async _dispatchBenchmarkEvaluators(
    ticket: Ticket,
    col: BoardColumn,
    actorId: string,
  ): Promise<void> {
    if (!ticket.parent_id) {
      this.logService.info('MCP', 'benchmark_eval skipped (candidate has no run parent)', {
        ticket_id: ticket.id,
      });
      return;
    }
    const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
    if (!board || (board as any).benchmark_mode !== 'on') {
      this.logService.info('MCP', 'benchmark_eval skipped (board not in benchmark_mode)', {
        ticket_id: ticket.id, board_id: col.board_id,
      });
      return;
    }
    const run = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticket.parent_id } });
    if (!run) return;
    const runLabels = safeJsonParse<string[]>((run as any).labels, []);
    const evaluatorIds = Array.isArray(runLabels)
      ? runLabels
          .filter((l) => typeof l === 'string' && l.startsWith('evaluator:'))
          .map((l) => l.slice('evaluator:'.length))
          .filter(Boolean)
      : [];
    if (evaluatorIds.length === 0) {
      this.logService.info('MCP', 'benchmark_eval skipped (run has no evaluator:<id> labels)', {
        ticket_id: ticket.id, run_ticket_id: run.id,
      });
      return;
    }

    for (const evaluatorAgentId of evaluatorIds) {
      // Self-trigger guard: an evaluator that just moved the candidate into
      // Review shouldn't immediately re-fire itself.
      if (evaluatorAgentId === actorId) continue;
      await this._emitTrigger(
        ticket, evaluatorAgentId, 'evaluator', 'benchmark_review', actorId,
        {
          bypassFocus: true,
          columnPromptOverride: {
            template_id: 'benchmark-eval-inline',
            name: 'Benchmark Evaluation',
            content: TriggerLoopService.BENCHMARK_EVAL_PROMPT,
          },
        },
      );
    }
  }

  /**
   * Manually wake an agent on a ticket — bound to the "Trigger" button on the
   * ticket UI and any other deliberate user-initiated kick. Just emits the SSE
   * event; no DB row beyond the explicit `trigger_dispatched` audit, no
   * cooldown, no ack. Returns the ephemeral trigger_id.
   *
   * Manual triggers BYPASS the focus selector gate (opts.bypassFocus = true).
   * The button is a deliberate user override — clicking it on five
   * different tickets is a documented way to wake five separate subagents.
   */
  async emitManualTrigger(
    ticketId: string,
    targetAgentId: string,
    role: string,
    actor: { id: string; name: string },
  ): Promise<{ trigger_id: string; ticket_id: string; agent_id: string; role: string }> {
    if (!targetAgentId) {
      throw Object.assign(new Error('No target agent (set ticket role agent or pass agent_id)'), { status: 400 });
    }

    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) {
      throw Object.assign(new Error('Ticket not found'), { status: 404 });
    }

    // Validate the slug against the ticket's workspace roles. Custom slugs
    // are allowed as long as a row exists; an unknown slug is a 400.
    const roleRow = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: ticket.workspace_id, slug: role },
    });
    if (!roleRow) {
      throw Object.assign(new Error(`Invalid role: ${role}`), { status: 400 });
    }

    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: targetAgentId } });
    if (!agent) {
      throw Object.assign(new Error(`Target agent ${targetAgentId} not found`), { status: 404 });
    }

    // Audit trail — manual triggers are user-initiated so leaving a trace in
    // ActivityLog is worth the single INSERT.
    const activityLogRepo = this.dataSource.getRepository(ActivityLog);
    await activityLogRepo.save(activityLogRepo.create({
      entity_type: 'ticket',
      entity_id: ticketId,
      ticket_id: ticketId,
      actor_id: 'system',
      actor_name: `manual by ${actor.name}`,
      action: 'trigger_dispatched',
      new_value: role,
      role,
      trigger_source: 'manual',
    }));

    const triggerId = await this._emitTrigger(
      ticket, targetAgentId, role, 'manual', actor.id, { bypassFocus: true },
    );
    return { trigger_id: triggerId, ticket_id: ticketId, agent_id: targetAgentId, role };
  }

  /**
   * Public emitter for server-side schedulers (e.g. TicketSupervisorService).
   * Delegates to the private _emitTrigger with the same payload composition
   * (role_prompt / ticket_prompt / column_prompt loaded fresh). Pass
   * `opts.forceRespawn: true` to tell the plugin to kill any live subagent for
   * this ticket before handling — used when a wedged session hasn't advanced
   * my_last_update_at after an initial re-push.
   *
   * Note: supervisor / backlog-promotion / activity-driven emits ALL pass
   * through the focus selector gate inside `_emitTrigger`. Only
   * `emitManualTrigger` bypasses it. This is intentional: even a
   * supervisor 30-min stale re-push for a non-focus ticket should stay
   * silent — the focus ticket is what wakes the agent each cycle.
   */
  async emitAgentTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: { forceRespawn?: boolean; bypassFocus?: boolean },
  ): Promise<string> {
    return this._emitTrigger(ticket, agentId, role, triggerSource, triggeredBy, opts);
  }

  /**
   * Wake every role holder routed to the ticket's CURRENT column.
   *
   * Mirrors the `_handleActivity` column_move dispatch (read
   * BoardColumn.role_routing → resolve WorkspaceRole → look up
   * TicketRoleAssignment → emit per holder) but is callable directly from
   * paths that are NOT activity-driven and shouldn't be made to fake a
   * `system`-actor activity row (which `_handleActivity` would early-return
   * on anyway). Currently used by the unpend path (ticket a57517be) — the
   * MCP `unpend_ticket` tool and the REST PATCH that clears
   * `pending_user_action` need an explicit wake, because the
   * `field_changed='pending_user_action'` activity row that the unpend
   * writes does not by itself route to the column's role holders (it's a
   * field-update, but `_handleActivity` is keyed off comments / moves /
   * any update — and on a previously-pending ticket the focus gate would
   * have dropped activity-driven triggers up until this moment).
   *
   * Skip cases (silent, one info log each):
   *   - ticket missing / has no column_id
   *   - current column is terminal
   *   - column's role_routing is empty
   *   - ticket still has `pending_user_action=true` (caller forgot to clear)
   *
   * Per-holder emit goes through `_emitTrigger`, which applies the focus
   * selector gate (no `bypassFocus` here — if some other ticket is the
   * agent's focus on this (board, role), the wake stays silent and the
   * focus model decides when this ticket comes back into rotation).
   *
   * Returns the count of emits attempted (NOT a count of "landed" — that's
   * the focus gate's call, and a 0 return is fine if the focus selector
   * is gating on a different ticket).
   */
  async dispatchCurrentColumn(
    ticketId: string,
    triggerSource: string,
    triggeredBy: string,
  ): Promise<{ emitted: number }> {
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: ticketId } });
    if (!ticket || !ticket.column_id) return { emitted: 0 };

    if (ticket.pending_user_action || ticket.pending_on_tickets) {
      this.logService.info('MCP', 'dispatchCurrentColumn skipped (ticket still pending)', {
        ticket_id: ticket.id, source: triggerSource,
        pending_user_action: !!ticket.pending_user_action,
        pending_on_tickets: !!ticket.pending_on_tickets,
      });
      return { emitted: 0 };
    }

    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!col) return { emitted: 0 };

    const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (isTerminal) {
      this.logService.info('MCP', 'dispatchCurrentColumn skipped (terminal column)', {
        ticket_id: ticket.id, column_id: col.id, source: triggerSource,
      });
      return { emitted: 0 };
    }

    const slugs = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(slugs) || slugs.length === 0) {
      this.logService.info('MCP', 'dispatchCurrentColumn skipped (empty role_routing)', {
        ticket_id: ticket.id, column_id: col.id, source: triggerSource,
      });
      return { emitted: 0 };
    }

    // 다중담당자 T2 (#1): fan out to EVERY agent holder of each routed slug,
    // deduped by agent_id (a 겸직 agent wakes once). The focus selector inside
    // _emitTrigger still gates whether each emit actually lands.
    let emitted = 0;
    const emittedAgentIds = new Set<string>();
    for (const slug of slugs) {
      const holders = await this._resolveRoleHolders(ticket, slug);
      if (!holders) continue;
      for (const targetAgentId of holders.agentIds) {
        if (emittedAgentIds.has(targetAgentId)) continue;
        emittedAgentIds.add(targetAgentId);
        try {
          await this._emitTrigger(ticket, targetAgentId, slug, triggerSource, triggeredBy);
          emitted++;
        } catch (e) {
          this.logService.warn('MCP', 'dispatchCurrentColumn emit failed (continuing)', {
            err: String(e), ticket_id: ticket.id, role: slug, agent_id: targetAgentId,
          });
        }
      }
    }
    return { emitted };
  }

  /**
   * Static self-improvement analysis prompt injected as `column_prompt` on
   * `ticket_done_review` triggers. Kept inline (not table-driven) so the
   * post-done flow is self-contained: an admin only has to flip
   * `Board.self_improvement_mode`, no extra prompt-template seeding step.
   * Admins who want a custom analysis prompt can map a PromptTemplate to the
   * board's terminal column via `column_prompts` and the in-line override
   * here will be ignored — but the table-mapped prompt only ever fires for
   * normal (non-`ticket_done_review`) terminal-column landings, so the two
   * paths don't collide.
   */
  private static readonly SELF_IMPROVEMENT_PROMPT = `# Self-Improvement Review

This ticket just landed on a terminal column (Done). You are being woken up one
last time as the reviewer to look back over what shipped and decide whether the
team can learn something repeatable from it.

## What to do

1. Read the ticket title, description, the comments thread, and the activity log
   (use \`mcp__awb__get_ticket\` and \`mcp__awb__get_ticket_activity\`). Pay
   attention to where time was spent, what surprised the assignee, and any
   reviewer kickbacks.

2. Decide if there is a concrete, actionable improvement worth filing. Examples
   that DO warrant a new ticket:
   - A repeated pain point that better tooling / docs / convention would fix.
   - A test gap exposed by a regression that landed and was hot-patched.
   - A workflow friction the assignee called out explicitly in a comment.
   - A reviewer comment that started "next time we should…".

   Examples that do NOT warrant a new ticket:
   - One-off bugs that were fixed cleanly in this very ticket.
   - Personal style preferences with no team-wide impact.
   - Speculative refactor itches without a real driver.

3. If you found one, file it via ONE (or more) of:
   - \`mcp__awb__add_board_lesson\` — PREFERRED when the lesson is a repeatable
     "next strand must remember this" runbook rather than a unit of work:
     an environment gotcha, a build/QA/git trap, a preflight step, a
     recurrence someone already hit more than once. This registers a
     board-scoped Lesson that is auto-injected into EVERY future dispatch
     prompt on this board, so the knowledge stops dying in one ticket's
     comment thread. Keep the \`body\` short and imperative; set
     \`source_ticket_id\` to this ticket. A lesson is the right home for
     "how not to repeat this" — a ticket is the right home for "work someone
     must do". File both when both apply.
   - \`mcp__awb__create_ticket\` — to file on THIS board (Backlog column,
     priority=low unless clearly urgent). Add label \`self-improvement\` and a
     short \`Source:\` link back to this ticket id in the description. Use this
     when there is concrete work to be done (tooling/tests/docs to build).
   - \`mcp__awb__create_remote_improvement_ticket\` — to file against the
     remote AWB instance configured by the admin (only available when the
     board's \`self_improvement_mode\` is \`remote_awb\` or \`both\`). Use
     this for improvements that are about AWB itself, not the project.

4. If you found NONE: leave one short comment summarising what you checked
   and why nothing crossed the bar. That short comment is the audit trail
   that the retrospective ran.

## Recursion guard

If the ticket you are reviewing already has the \`self-improvement\` label,
you should never have been woken — exit immediately with no action.

## Tone

Keep follow-up ticket titles tight and outcome-shaped:
  GOOD: "Add lint rule that bans cross-module entity imports"
  BAD:  "We had some import problems we should look at"
`;

  /**
   * Inline column prompt injected when a benchmark candidate lands in Review and
   * its run's evaluator agents are woken to score it (ticket 684c012b). Mirrors
   * SELF_IMPROVEMENT_PROMPT — delivered via `columnPromptOverride` so the
   * evaluator gets scoring instructions without a board column_prompt row.
   */
  private static readonly BENCHMARK_EVAL_PROMPT = `# Benchmark Evaluation

You are an EVALUATOR for a benchmark run. A candidate ticket (one agent's
attempt at the run's task) has reached Review. Score it — do NOT modify the
candidate's branch or move the ticket.

## What to do

1. Read the candidate ticket (\`mcp__awb__get_ticket\`): its description is the
   task, and its comments + branch summarise what the candidate's assignee
   produced. Read the parent run ticket too for the full task prompt and any
   \`## Rubric\` section that defines the scoring dimensions and range.

2. Inspect the candidate's actual work — the feature branch it pushed and the
   comment it left in Review (build/test results, caveats). Judge it on the
   run's rubric. If the run defines no rubric, default to these dimensions on a
   0..10 scale: \`correctness\`, \`quality\`, \`speed\`.

3. For EACH dimension, call \`mcp__awb__submit_benchmark_score\` with:
   - \`candidate_ticket_id\` — this candidate ticket's id
   - \`dimension\` — the dimension name
   - \`score\` — your numeric score within the rubric's range
   - \`rationale\` — one or two sentences justifying the score
   Re-scoring the same dimension overwrites your previous row, so it is safe to
   correct yourself.

## Rules

- Score only. Do not edit code, push commits, or move the candidate ticket —
  the candidate parks in Review for scoring by design.
- Your scores are recorded as your own evaluator identity; other evaluators
  score the same candidate independently. Do not coordinate or average.
- Keep rationales concrete and tied to what you actually inspected.
`;

  /**
   * Compose the trigger payload (role_prompt / ticket_prompt / column_prompt
   * loaded fresh at dispatch time) and emit via activityEvents so the
   * EventsController SSE listener forwards it to connected agents.
   *
   * Focus selector gate (ticket 4a6cdfd7):
   *   Unless `opts.bypassFocus` is true, the emit only lands if the
   *   focus selector picks THIS ticket as the agent's focus for
   *   (board, role). Otherwise the call returns '' and writes no
   *   DB rows — non-focus triggers are silent (AC #8).
   *
   * Fire-and-forget after the gate: no DB row, no ack, no retry.
   * TicketSupervisorService re-pushes stale allocations
   * (my_last_update_at older than 30 min) and escalates to
   * force_respawn after the cooldown if silence persists.
   */
  private async _emitTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: {
      forceRespawn?: boolean;
      bypassFocus?: boolean;
      // Inline override for `column_prompt` — used by `_dispatchPostDoneReview`
      // to inject the self-improvement analysis prompt onto a terminal-column
      // trigger that the normal `board.column_prompts[column_id]` path can't
      // serve (the terminal column's mapped prompt, if any, exists for normal
      // merging workflow — distinct from the post-done retrospective).
      columnPromptOverride?: { template_id: string; name: string; content: string };
    },
  ): Promise<string> {
    const now = new Date();

    // Resolve the ticket's column ONCE up front — needed for board_id
    // (focus selector), the audit-row ranking summary, and any
    // downstream lookup. Cheap, single repo hit, avoids the three
    // separate findOne calls the pre-fix code did.
    const col = ticket.column_id
      ? await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
      : null;
    const boardId = col?.board_id ?? '';

    // Agent Manager(type='manager') 드롭 게이트 (ticket 941c72d3). Manager 는 절대
    // 작업하지 않는다 — holder-resolution(_resolveRoleHolders) 에서 대부분 걸러
    // 지지만, 수동 트리거(emitManualTrigger)나 legacy 배정 경로로 manager id 가
    // 이 최종 chokepoint 까지 올 수 있으므로 여기서도 명시적으로 드롭한다. 다른
    // 드롭 게이트와 동일하게 info 로그 + audit row(action='agent_trigger_dropped_manager')
    // 를 남겨 "manager 는 왜 안 깨어나나" 를 grep 할 수 있게 한다.
    {
      const targetAgent = await this.dataSource.getRepository(Agent).findOne({
        where: { id: agentId },
        select: ['id', 'type'],
      });
      if (targetAgent?.type === 'manager') {
        this.logService.info('MCP', 'agent_trigger dropped (manager agent)', {
          ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
        });
        try {
          const activityLogRepo = this.dataSource.getRepository(ActivityLog);
          await activityLogRepo.save(activityLogRepo.create({
            entity_type: 'ticket',
            entity_id: ticket.id,
            ticket_id: ticket.id,
            actor_id: 'system',
            actor_name: 'TriggerLoopService',
            action: 'agent_trigger_dropped_manager',
            new_value: `agent=${agentId} type=manager`,
            role,
            trigger_source: triggerSource,
          }));
        } catch (e) {
          this.logService.warn('MCP', 'manager-drop audit write failed (drop still applied)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
        return '';
      }
    }

    // Board pause gate. _emitTrigger is the SINGLE chokepoint every dispatch
    // path funnels through (activity-driven column_move / comment /
    // ticket_update, supervisor stale-re-push, backlog_promotion, and even
    // emitManualTrigger which bypasses the focus gate but not this one). So
    // a non-null Board.paused_at here drops the trigger regardless of source.
    //
    // Drop semantics mirror the focus-selector drop: silent on the wire (no
    // SSE emit), one info-level log line, and an ActivityLog row so an
    // operator can grep "why did my agent never wake up" → "board paused".
    // The audit row uses action='agent_trigger_dropped_board_paused' to
    // distinguish it from the focus-selector silent drop (which logs only).
    if (boardId) {
      const board = await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } });
      if (board?.paused_at) {
        this.logService.info('MCP', 'agent_trigger dropped (board paused)', {
          ticket_id: ticket.id, agent_id: agentId, role,
          source: triggerSource, board_id: boardId,
          paused_at: new Date(board.paused_at).toISOString(),
        });
        try {
          const activityLogRepo = this.dataSource.getRepository(ActivityLog);
          await activityLogRepo.save(activityLogRepo.create({
            entity_type: 'ticket',
            entity_id: ticket.id,
            ticket_id: ticket.id,
            actor_id: 'system',
            actor_name: 'TriggerLoopService',
            action: 'agent_trigger_dropped_board_paused',
            new_value: `agent=${agentId} board=${boardId} paused_at=${new Date(board.paused_at).toISOString()}`,
            role,
            trigger_source: triggerSource,
          }));
        } catch (e) {
          // Audit failure must not gate the drop itself — pause is already
          // in effect, the missed row is the only collateral.
          this.logService.warn('MCP', 'paused-drop audit write failed (drop still applied)', {
            err: String(e), ticket_id: ticket.id, board_id: boardId,
          });
        }
        return '';
      }
    }

    // Archived-ticket gate (ticket 9b44526b). Single chokepoint shared with
    // the pause / pending gates below. Re-reads the ticket so a manual
    // archive that races a queued trigger still wins — same fresh-read
    // pattern as the pending gate. Even manual triggers honor this; the
    // documented escape hatch is `unarchive_ticket`.
    {
      const freshForArchive = await this.dataSource
        .getRepository(Ticket)
        .findOne({ where: { id: ticket.id } });
      if (freshForArchive?.archived_at) {
        this.logService.info('MCP', 'agent_trigger dropped (ticket archived)', {
          ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
          archived_at: new Date(freshForArchive.archived_at).toISOString(),
        });
        try {
          const activityLogRepo = this.dataSource.getRepository(ActivityLog);
          await activityLogRepo.save(activityLogRepo.create({
            entity_type: 'ticket',
            entity_id: ticket.id,
            ticket_id: ticket.id,
            actor_id: 'system',
            actor_name: 'TriggerLoopService',
            action: 'agent_trigger_dropped_archived',
            new_value: `agent=${agentId} archived_at=${new Date(freshForArchive.archived_at).toISOString()}`,
            role,
            trigger_source: triggerSource,
          }));
        } catch (e) {
          this.logService.warn('MCP', 'archived-drop audit write failed (drop still applied)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
        return '';
      }
    }

    // Pending-user-action gate (ticket a57517be). Single chokepoint that
    // every dispatch path runs through — including manual triggers (the
    // "Trigger" button on a pending ticket would otherwise re-wake the agent
    // and undo the pause). Operator-grade override: clearing the flag is the
    // documented way out. Audit row uses `agent_trigger_dropped_pending_user`
    // so it's grepable separately from the board_paused drop.
    {
      const freshForGate = await this.dataSource
        .getRepository(Ticket)
        .findOne({ where: { id: ticket.id } });
      // Two distinct pending flavors funnel through this one gate (ticket
      // 48d14fff): `pending_user_action` (waiting on a human) and
      // `pending_on_tickets` (blocked behind prerequisite tickets). Either
      // drops the trigger. The audit action is suffixed so a grep can tell the
      // two apart — `_pending_user` vs `_pending_tickets`.
      if (freshForGate?.pending_user_action || freshForGate?.pending_on_tickets) {
        const onTickets = !freshForGate.pending_user_action && !!freshForGate.pending_on_tickets;
        const dropAction = onTickets
          ? 'agent_trigger_dropped_pending_tickets'
          : 'agent_trigger_dropped_pending_user';
        this.logService.info('MCP', 'agent_trigger dropped (ticket pending)', {
          ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
          pending_user_action: !!freshForGate.pending_user_action,
          pending_on_tickets: !!freshForGate.pending_on_tickets,
          pending_set_at: freshForGate.pending_set_at
            ? new Date(freshForGate.pending_set_at).toISOString()
            : null,
          pending_set_by: freshForGate.pending_set_by || '',
        });
        try {
          const activityLogRepo = this.dataSource.getRepository(ActivityLog);
          await activityLogRepo.save(activityLogRepo.create({
            entity_type: 'ticket',
            entity_id: ticket.id,
            ticket_id: ticket.id,
            actor_id: 'system',
            actor_name: 'TriggerLoopService',
            action: dropAction,
            new_value: `agent=${agentId} reason=${(freshForGate.pending_reason || '').slice(0, 200)}`,
            role,
            trigger_source: triggerSource,
          }));
        } catch (e) {
          this.logService.warn('MCP', 'pending-drop audit write failed (drop still applied)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
        return '';
      }
    }

    // Focus selector gate. The selector returns the single ticket id
    // this agent should be working on for (board, role) right now —
    // ranked by column.position DESC, is_chain_target ASC, priority
    // ASC, created_at ASC. Manual triggers bypass via opts.bypassFocus.
    //
    // Drops are SILENT: no SSE emit, no DB row, no audit. Per AC #8 of
    // ticket 4a6cdfd7 we want zero queue churn on drops. The selector
    // result is logged at info level so an operator running the server
    // log tail can still see why a particular emit dropped.
    if (!opts?.bypassFocus && boardId) {
      const focusTicketId = await this.agentWorkload.getFocusTicket(agentId, boardId, role);
      if (focusTicketId !== ticket.id) {
        this.logService.info('MCP', 'agent_trigger dropped (not focus)', {
          ticket_id: ticket.id, agent_id: agentId, role,
          source: triggerSource, focus_ticket_id: focusTicketId,
        });
        return '';
      }
    }

    // In-flight strand serialization gate (ticket c9622a40). The focus gate
    // above caps the agent to ONE focus ticket per (board, role); it does NOT
    // stop a SECOND trigger for the SAME (ticket, role) — fired from a distinct
    // event (column_move + comment_mention + supervisor / unpend / ticket_update
    // tick) — from spawning a redundant racing strand (both pass focus with the
    // same ticket id). On a review gate that is the reviewer-vs-reviewer
    // self-LGTM race: a fast reviewer strand LGTMs → Merging → Done before the
    // slow strand's independent BLOCKER review lands, discarding the careful
    // verdict as a post-merge no-op (ticket 86bfb8af live repro). proposal 2's
    // review-approval-guard (a3d25202) only inspects author_role, so it waves
    // both reviewer strands through — serializing the strands is the residual
    // fix (this ticket = same-role strand axis; proposal 2 = self-merge axis).
    //
    // The lock is the existing current_task lifecycle (no new store): acquired
    // on the plugin's set_current_task when the subagent starts work, released
    // on clear_current_task / agent_idle (exit or crash), and TTL-swept after
    // CURRENT_TASK_STALE_MS so a crashed strand can't wedge the seat forever —
    // exactly the claim_ticket-style advisory lock the ticket proposes (#1).
    // forceRespawn bypasses: the supervisor's wedged-session re-push and the
    // self-improvement remote dispatch deliberately want to replace a live
    // strand, and they carry their own audit actor. The known set_current_task
    // lag (trigger emits before the subagent registers its task) is backstopped
    // manager-side by the same defensive cap that guards the per-ticket limit
    // (stream-events.ts AgentTriggerPayload.max_concurrent_tickets_per_agent).
    if (opts?.forceRespawn !== true && this.agentStatus.hasLiveRoleStrand(agentId, ticket.id, role)) {
      this.logService.info('MCP', 'agent_trigger dropped (live same-role strand in flight)', {
        ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
      });
      try {
        const activityLogRepo = this.dataSource.getRepository(ActivityLog);
        await activityLogRepo.save(activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'TriggerLoopService',
          action: 'agent_trigger_dropped_inflight_strand',
          new_value: `agent=${agentId} role=${role} source=${triggerSource}`,
          role,
          trigger_source: triggerSource,
        }));
      } catch (e) {
        // Audit write must not gate the drop — the serialization already
        // applied; a missed row is the only collateral (mirrors the
        // pause / pending / archived drop audit error handling above).
        this.logService.warn('MCP', 'inflight-strand-drop audit write failed (drop still applied)', {
          err: String(e), ticket_id: ticket.id, agent_id: agentId,
        });
      }
      return '';
    }

    // Compose role_prompt = workspace role's prompt + agent's own prompt.
    // Both layers loaded fresh here so any edits since last dispatch propagate
    // (Agent.role_prompt or WorkspaceRole.role_prompt). Empty layers are
    // skipped — neither side is a hard requirement. Plugin sees the joined
    // text in the same `role_prompt` field on the wire, so no plugin change
    // is needed for v0.34's prepend semantics.
    const agent = await this.dataSource.getRepository(Agent).findOne({ where: { id: agentId } });
    const workspaceRole = await this.dataSource.getRepository(WorkspaceRole).findOne({
      where: { workspace_id: ticket.workspace_id, slug: role },
    });
    const rolePrompt = [workspaceRole?.role_prompt, agent?.role_prompt]
      .filter((s): s is string => !!s && s.trim().length > 0)
      .join('\n\n');

    // Re-fetch ticket for fresh prompt_text — the one from _handleActivity may be stale
    const freshTicket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticket.id } });
    const ticketPrompt = freshTicket?.prompt_text || '';

    // Resolve the ticket's base repository snapshot (if any). Embedded in the
    // SSE payload so agent-manager doesn't need a second round-trip to render
    // the prompt block — name/url/default_branch come along for free. Failing
    // the lookup is non-fatal; the agent prompt just omits the repo line.
    // Workspace-scoped lookup (defense-in-depth — writes are guarded too):
    // a stale id pointing at another workspace's Resource never gets its
    // url/name shipped out to the assignee here.
    const baseRepoId = freshTicket?.base_repo_resource_id || ticket.base_repo_resource_id || '';
    const baseBranch = freshTicket?.base_branch || ticket.base_branch || '';
    const baseRepoWorkspaceId = freshTicket?.workspace_id || ticket.workspace_id || '';
    let baseRepo: { id: string; name: string; url: string; default_branch: string } | null = null;
    if (baseRepoId && baseRepoWorkspaceId) {
      try {
        const r = await this.dataSource.getRepository(Resource).findOne({
          where: { id: baseRepoId, workspace_id: baseRepoWorkspaceId },
        });
        if (r) {
          baseRepo = {
            id: r.id,
            name: r.name,
            url: r.url || '',
            default_branch: r.default_branch || '',
          };
        }
      } catch (e) {
        this.logService.warn('MCP', 'base_repo lookup failed (continuing without)', {
          err: String(e), ticket_id: ticket.id, base_repo_id: baseRepoId,
        });
      }
    }

    // Column workflow prompt: Board.column_prompts[column_id] → PromptTemplate.content.
    // Override path: callers that need to ship a synthetic prompt (e.g.
    // `_dispatchPostDoneReview` injecting the self-improvement analysis prompt)
    // pass `opts.columnPromptOverride` — short-circuit before the lookup.
    let columnPrompt: { template_id: string; name: string; content: string } | null = null;
    if (opts?.columnPromptOverride) {
      columnPrompt = opts.columnPromptOverride;
    } else {
      try {
        if (col) {
          const board = await this.dataSource.getRepository(Board).findOne({ where: { id: col.board_id } });
          const raw = board?.column_prompts;
          if (raw) {
            const map = safeJsonParse(raw, {});
            const tplId: string | undefined = map?.[ticket.column_id];
            if (tplId) {
              const tpl = await this.dataSource.getRepository(PromptTemplate).findOne({ where: { id: tplId } });
              if (tpl && tpl.workspace_id === board!.workspace_id) {
                columnPrompt = { template_id: tpl.id, name: tpl.name, content: tpl.content };
              }
            }
          }
        }
      } catch (e) {
        this.logService.warn('MCP', 'column_prompt lookup failed (continuing without)', { err: String(e), ticket_id: ticket.id });
      }
    }

    // Manager-side defensive cap hint, kept on the wire for backward
    // compat with plugin / agent-manager versions that read this field
    // as a second line of defense. Server-side enforcement is now the
    // focus selector above, NOT this cap. After plugin / manager bumps
    // can drop the field, this `findOne` goes too.
    let maxConcurrent = 1;
    if (boardId) {
      try {
        const board = await this.dataSource
          .getRepository(Board)
          .findOne({ where: { id: boardId } });
        if (board && Number.isFinite(board.max_concurrent_tickets_per_agent)) {
          maxConcurrent = Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent));
        }
      } catch (e) {
        this.logService.warn('MCP', 'board cap lookup failed (defaulting to 1)', {
          err: String(e), ticket_id: ticket.id,
        });
      }
    }

    // Resolved harness config (ticket e9c7a896): workspace default merged
    // with the board override, key-level, via the shared helper — the same
    // resolve every REST/MCP reader uses, so dispatch can't disagree with
    // the admin UI about what applies. Shipped on the trigger payload so
    // agent-manager maps the keys onto CLI flags at spawn time. Null when
    // neither layer sets anything OR the lookup fails — the manager treats
    // null as "no harness" and spawns exactly as before. Deliberately a
    // separate Board findOne from the legacy maxConcurrent block above
    // (that one is slated for deletion after manager bumps).
    let harnessConfig: HarnessConfig | null = null;
    // Resolved effort preset (abstract ticket effort option). Picked from the
    // board's effort_presets catalog using the ticket's effort_preset id (or
    // the catalog default when unset) via the shared resolveEffortPreset — the
    // same resolve every REST/MCP reader uses. Shipped on the trigger payload
    // so agent-manager maps it onto per-CLI options at spawn (claude --effort +
    // the "ultracode" prompt keyword + --model; codex/antigravity model-only).
    // Null when the board has no presets OR the lookup fails — the manager
    // treats null as "no effort override" and spawns exactly as before. Reuses
    // the same Board row loaded for harness so there's no extra round-trip.
    let effortPreset: ResolvedEffortPreset | null = null;
    // Resolved environment setup (ticket 354d336b): workspace default merged
    // with the board override (key-level), then each repository's resource_id
    // expanded to a concrete url/branch via a workspace-scoped Resource lookup.
    // Shipped on the trigger payload so agent-manager provisions the working
    // environment (clone/update repos, run setup commands, inject env_vars)
    // just before spawning the subagent. Null when neither layer configures an
    // environment OR the lookup fails — the manager treats null as "no
    // provisioning" and spawns exactly as before. Reuses the same board/
    // workspace rows loaded for harness so there's no extra round-trip.
    let environmentConfig: ResolvedEnvironmentConfig | null = null;
    // Resolved board worktree placement mode (worktree 규약 ②, board option ①).
    // Null-safe read via the shared resolver — a missing/malformed column falls
    // back to DEFAULT_WORKTREE_MODE ('per_ticket'). Shipped on the trigger payload
    // so agent-manager's WorktreeManager picks the worktree slug at spawn
    // (per_ticket → `.awb/wt/<ticket8>`, shared → `.awb/wt/shared`). Reuses the
    // same Board row loaded for harness — no extra round-trip.
    let worktreeMode: WorktreeMode = resolveBoardWorktreeMode(undefined);
    // Resolved board PR usage (worktree 규약 ⑥, board option ①). Drives which
    // merge branch the column workflow prompt renders — false (default) → direct
    // ff merge only, true → the `gh pr` create/merge path. Read null-safe via the
    // shared resolver from the SAME Board row loaded for harness (no extra query);
    // applied to `columnPrompt.content` below before the trigger emits.
    let usePr = resolveBoardUsePr(undefined);
    try {
      const boardForHarness = boardId
        ? await this.dataSource.getRepository(Board).findOne({ where: { id: boardId } })
        : null;
      worktreeMode = resolveBoardWorktreeMode(boardForHarness?.worktree_mode);
      usePr = resolveBoardUsePr(boardForHarness?.use_pr);
      const workspaceForHarness = ticket.workspace_id
        ? await this.dataSource.getRepository(Workspace).findOne({ where: { id: ticket.workspace_id } })
        : null;
      harnessConfig = resolveHarnessConfig(
        workspaceForHarness?.harness_config,
        boardForHarness?.harness_config,
      );
      effortPreset = resolveEffortPreset(boardForHarness?.effort_presets, ticket.effort_preset);

      // Merge workspace default ⊕ board override, then expand repository
      // resource_ids into concrete url/default_branch. Batch-fetch the
      // referenced repository Resources once (workspace-scoped — a stale id
      // pointing at another workspace's Resource never gets its url shipped),
      // build a lookup map, and resolve. A repository whose id can't be
      // resolved AND has no direct url is dropped inside resolveEnvironmentConfig.
      const mergedEnv = mergeEnvironmentConfig(
        workspaceForHarness?.environment_config,
        boardForHarness?.environment_config,
      );
      if (mergedEnv) {
        const resourceIds = (mergedEnv.repositories || [])
          .map((r) => (r.resource_id || '').trim())
          .filter((id) => id.length > 0);
        const repoMap = new Map<string, { url: string; default_branch: string }>();
        if (resourceIds.length > 0 && ticket.workspace_id) {
          const rows = await this.dataSource.getRepository(Resource).find({
            where: resourceIds.map((rid) => ({ id: rid, workspace_id: ticket.workspace_id })),
          });
          for (const r of rows) {
            repoMap.set(r.id, { url: r.url || '', default_branch: r.default_branch || '' });
          }
        }
        environmentConfig = resolveEnvironmentConfig(
          mergedEnv,
          (rid) => repoMap.get(rid) || null,
        );
      }

      // Board output language (i18n, ticket ae28dcaf). When the board sets a
      // language, append a "Respond in <language>…" instruction onto the
      // resolved harness_config.system_prompt_append — riding the existing
      // harness plumbing (server→SSE→agent-manager→CLI --append-system-prompt)
      // so no new SSE field / agent-manager change is needed. APPEND, never
      // overwrite, so a board harness's own system_prompt_append is preserved.
      // Single emit point ⇒ applies to every role (planner/assignee/reviewer).
      // null/empty language = no override → agent default (English), unchanged.
      harnessConfig = appendBoardLanguageInstruction(harnessConfig, boardForHarness?.language);
    } catch (e) {
      this.logService.warn('MCP', 'harness_config / effort_preset / environment_config resolve failed (continuing without)', {
        err: String(e), ticket_id: ticket.id, board_id: boardId,
      });
    }

    // Board Lessons / Runbook (ticket 9d0d6ac4). Append the board's ACTIVE
    // lessons onto harness_config.system_prompt_append, riding the exact same
    // plumbing as the language instruction above (server→SSE→agent-manager→CLI
    // --append-system-prompt) so no new SSE field / agent-manager change is
    // needed. Applies to EVERY dispatch — _emitTrigger is the single chokepoint
    // (ticket/QA/security/schedule all flow through here), so QA/security run
    // prompts get the same injection for free. Deliberately its own try/catch
    // and its own Board(Lesson) query so a lessons failure never masks the
    // harness/effort/env resolution above. Zero active lessons ⇒ composeLessons
    // returns null ⇒ harnessConfig returned untouched ⇒ byte-identical prompt
    // (the DoD regression guard). Count/length/byte caps live in board-lessons.
    if (boardId) {
      try {
        const lessons = await this.dataSource.getRepository(BoardLesson).find({
          where: { board_id: boardId, active: true },
          order: { updated_at: 'DESC' },
          take: MAX_INJECTED_LESSONS,
        });
        if (lessons.length > 0) {
          harnessConfig = appendBoardLessons(harnessConfig, lessons);
          // Best-effort hit_count bump on the injected rows — one cheap UPDATE,
          // fire-and-forget so it can never block or fail the dispatch emit.
          const injectedIds = lessons.map((l) => l.id);
          this.dataSource
            .getRepository(BoardLesson)
            .increment({ id: In(injectedIds) }, 'hit_count', 1)
            .catch(() => {});
        }
      } catch (e) {
        this.logService.warn('MCP', 'board lessons injection failed (continuing without)', {
          err: String(e), ticket_id: ticket.id, board_id: boardId,
        });
      }
    }

    // Worktree 규약 ⑥: render the column workflow prompt for this board's use_pr
    // BEFORE it ships. The server owns the prompt the agent receives (same channel
    // as 규약 ④'s work-folder injection), so the pr-only / no-pr marker blocks are
    // resolved here — a use_pr=false board never sees the `gh pr` merge branch and
    // a use_pr=true board gets the PR create/merge path. No new SSE field: this
    // only transforms an existing payload field's value, so agent-manager / the
    // plugin need no change and the SSE parity guard is untouched. Marker-free
    // content (every existing seeded template + custom prompt) passes through
    // byte-identical.
    if (columnPrompt) {
      columnPrompt = { ...columnPrompt, content: renderUsePrTemplate(columnPrompt.content, usePr) };
    }

    // Chain-target flag for the audit row — one IN query scoped to this
    // single ticket id. Trivial cost; surfaces the selector's ranking
    // input on every emit so post-mortems can reconstruct "why did the
    // selector pick this?" from ActivityLog alone (AC #8).
    let chainTarget = false;
    try {
      const parents = await this.dataSource
        .getRepository(Ticket)
        .createQueryBuilder('t')
        .where('t.next_ticket_id = :id', { id: ticket.id })
        .limit(1)
        .getMany();
      chainTarget = parents.length > 0;
    } catch (e) {
      this.logService.warn('MCP', 'chain_target lookup failed (audit row will say false)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

    // Ephemeral trigger_id — plugin-side dedup key, no server persistence.
    const triggerId = randomUUID();

    const forceRespawn = opts?.forceRespawn === true;

    activityEvents.emit('agent_trigger', {
      trigger_id: triggerId,
      ticket_id: ticket.id,
      agent_id: agentId,
      role,
      trigger_source: triggerSource,
      role_prompt: rolePrompt,
      ticket_prompt: ticketPrompt,
      column_prompt: columnPrompt,
      base_repo: baseRepo,
      base_branch: baseBranch,
      // Resolved workspace+board harness — agent-manager applies it as CLI
      // flags at subagent spawn (ticket e9c7a896). Null = no harness.
      harness_config: harnessConfig,
      // Resolved abstract effort preset (board catalog × ticket effort_preset).
      // agent-manager maps it onto per-CLI options at spawn (claude --effort +
      // "ultracode" prompt keyword + --model; codex/antigravity model-only).
      // Null = no effort override.
      effort_preset: effortPreset,
      // Resolved environment setup (ticket 354d336b): merged workspace+board
      // config with repository resource_ids expanded to concrete url/branch.
      // agent-manager provisions the working environment before spawn (clone/
      // update repos, run setup commands, inject env_vars), guarded by a
      // per-(agent,board) fingerprint marker. Null = no provisioning.
      environment_config: environmentConfig,
      // Resolved board worktree placement mode (worktree 규약 ②). agent-manager
      // maps it onto the worktree slug at spawn (per_ticket → `.awb/wt/<ticket8>`,
      // shared → `.awb/wt/shared`). Always a concrete enum (resolver defaults to
      // per_ticket) so the manager never has to guess.
      worktree_mode: worktreeMode,
      // Working_dir-relative worktree folder AWB assigns this ticket (worktree 규약 ④):
      // `.awb/wt/<ticket8>` | `.awb/wt/shared`, derived from worktreeMode via the same
      // slug the manager uses. agent-manager fills the `{{AWB_WORK_FOLDER}}` placeholder
      // in the column prompt with the ACTUAL resolved worktree cwd (this path joined
      // onto the working_dir), so the trigger prompt names the exact spawn folder and
      // the agent never improvises a worktree location.
      worktree_rel_path: resolveWorktreeRelPath(ticket.id, worktreeMode),
      triggered_by: triggeredBy,
      timestamp: now.toISOString(),
      force_respawn: forceRespawn,
      // Manager-side legacy hint — read above as a defensive cap for
      // plugin / agent-manager versions that haven't been bumped past
      // the focus-selector cutover. Server-side dispatch is gated by
      // the focus selector, not this field.
      max_concurrent_tickets_per_agent: maxConcurrent,
    });

    this.logService.info('MCP', 'agent_trigger emitted (fire-and-forget)', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource, force_respawn: forceRespawn,
    });

    // Observability hook required by ticket 4a6cdfd7 acceptance #8.
    // Every successful dispatch leaves a `trigger_emitted` ActivityLog
    // row with the selector ranking inputs in `new_value` so admins
    // can correlate the chosen-focus decision against the parked tickets.
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      const createdAtIso = ticket.created_at
        ? new Date(ticket.created_at).toISOString()
        : '';
      await activityLogRepo.save(activityLogRepo.create({
        entity_type: 'ticket',
        entity_id: ticket.id,
        ticket_id: ticket.id,
        actor_id: 'system',
        actor_name: 'TriggerLoopService',
        action: 'trigger_emitted',
        new_value:
          `agent=${agentId} ` +
          `column_position=${col?.position ?? -1} ` +
          `chain_target=${chainTarget} ` +
          `priority_index=${priorityIndex(ticket.priority)} ` +
          `created_at=${createdAtIso} ` +
          `force_respawn=${forceRespawn}`,
        role,
        trigger_source: triggerSource,
      }));
    } catch (e) {
      // Never block the emit on observability writes. A missed log row
      // is preferable to a missed trigger.
      this.logService.warn('MCP', 'trigger_emitted activity log write failed (non-fatal)', {
        err: String(e), ticket_id: ticket.id, agent_id: agentId,
      });
    }

    // Claim-verification snapshot (ticket dcb9d661). When an assignee
    // is being woken on an active column AND the workspace has
    // claim-verification enabled, capture the current branch tip SHA so
    // ClaimVerificationService's sweep can later assert "the agent
    // commented 'done' but the branch tip is the same one we handed
    // them — no commit landed". Fire-and-forget: a failed GitHub fetch
    // leaves an empty SHA and the sweep falls back to ActivityLog-only
    // evidence. Never blocks the dispatch.
    if (role === 'assignee' && col && (col as any).kind === 'active' && baseRepo && baseRepo.url) {
      this._snapshotBranchTipSha(ticket, baseRepo, baseBranch).catch((e: unknown) => {
        this.logService.warn('MCP', 'claim-verification snapshot failed (non-fatal)', {
          err: String(e), ticket_id: ticket.id, agent_id: agentId,
        });
      });
    }

    return triggerId;
  }

  /**
   * Best-effort branch-tip snapshot for the claim-verification sweep
   * (ticket dcb9d661). Only runs when the workspace has the feature
   * enabled. Writes the SHA + timestamp directly onto the ticket so
   * the sweep has all the evidence it needs in one row.
   *
   * Idempotency: the snapshot is overwritten on each successful
   * assignee trigger, which matches the spec ("the SHA just before
   * the latest trigger"). A failed fetch leaves the previous snapshot
   * untouched so a transient network blip can't erase prior evidence.
   */
  private async _snapshotBranchTipSha(
    ticket: Ticket,
    baseRepo: { id: string; name: string; url: string; default_branch: string },
    baseBranch: string,
  ): Promise<void> {
    const ws = await this.dataSource.getRepository(Workspace).findOne({
      where: { id: ticket.workspace_id },
    });
    if (!ws || !ws.claim_verification_enabled) return;

    const parsed = parseGitHubUrl(baseRepo.url);
    if (!parsed) return;
    const branch = baseBranch || baseRepo.default_branch;
    if (!branch) return;

    // Resolve a credential the repo Resource may have attached. The
    // Resource entity stores `credential_id` for GitHub auth; absent →
    // fall back to GITHUB_TOKEN env via the connector's resolution.
    let credentialId: string | null = null;
    try {
      const resource = await this.dataSource.getRepository(Resource).findOne({
        where: { id: baseRepo.id },
      });
      credentialId = (resource as any)?.credential_id || null;
    } catch {
      credentialId = null;
    }

    const github = new GitHubConnectorService(this.dataSource);
    const sha = await github.fetchBranchTipSha(parsed.owner, parsed.repo, branch, credentialId);
    if (!sha) return;

    try {
      await this.dataSource.getRepository(Ticket).update(
        { id: ticket.id },
        { branch_tip_sha_at_trigger: sha, branch_tip_snapshot_at: new Date() },
      );
    } catch (e) {
      this.logService.warn('MCP', 'claim-verification snapshot write failed (non-fatal)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }
}

function safeJsonParse<T = any>(val: string | null | undefined, fallback: T): T {
  try { return JSON.parse(val || JSON.stringify(fallback)) as T; }
  catch { return fallback; }
}
