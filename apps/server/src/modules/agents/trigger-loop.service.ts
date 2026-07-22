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
import { DispatchIntentService, DISPATCH_RECONCILE_SOURCE } from './dispatch-intent.service';
import { AgentAutostartService } from './agent-autostart.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { priorityIndex } from './priority';
import { appendBoardLanguageInstruction, resolveHarnessConfig, HarnessConfig } from '../../common/harness-config';
import { resolveEffortPreset, ResolvedEffortPreset } from '../../common/effort-presets';
import { mergeEnvironmentConfig, resolveEnvironmentConfig, ResolvedEnvironmentConfig } from '../../common/environment-config';
import { resolveBoardUsePr, resolveBoardWorktreeMode, resolveWorktreeRelPath, renderUsePrTemplate, WorktreeMode } from '../../common/worktree-config';
import { appendBoardLessons, MAX_INJECTED_LESSONS } from '../../common/board-lessons';
import { pickBaseRepoResourceId, shouldBlockDispatchForMissingRepo } from '../../common/base-repo-binding';
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
// THIS ticket sits inside the agent's top-N focus window for the board.
// Out-of-window triggers are silently dropped (no DB row, no SSE emit) so a
// board with many parked tickets doesn't thrash the agent.
//
// Focus-window gate (ticket 4a6cdfd7 → generalized top-N in 701e5e36):
//   - `AgentWorkloadService.getAgentFocusTicketIds(agent, board, N)` returns
//     the agent's top-N ranked ticket ids (agent-unit, collapsed across
//     roles), where N = `Board.max_concurrent_tickets_per_agent`. Trigger
//     emits iff the candidate ticket is inside that window. At N=1 this is
//     exactly the old single-focus gate (no behavioural change).
//   - Manual triggers (`emitManualTrigger`) explicitly opt out of the
//     gate via `opts.bypassFocus = true` — they're deliberate user
//     overrides and the audit trail already records the human / agent
//     actor on the `trigger_dispatched` row.

const COMMENT_ACTION = 'created';
const COMMENT_ENTITY = 'comment';

// Transition-trigger preservation (ticket 1bcb0899). Trigger sources that
// represent a ONE-SHOT workflow-state transition: they fire exactly once on a
// move / chain hand-off / prerequisite unblock and are NOT re-fired by any
// later organic event. If the in-flight-strand gate in `_emitTrigger` drops
// one of these while a conflicting same-(agent, ticket, role) strand is still
// live, the transition is lost forever — nothing re-fires it, so the ticket
// strands until an unrelated event (the ~2.9h prereq-waiter rescue in the
// source incident) happens to re-dispatch its column. Those sources are queued
// for replay on the next `agent_idle`; every OTHER source is deliberately
// excluded because it self-corrects:
//   - 'comment' / 'ticket_update' re-fire on the next comment / field edit,
//   - 'supervisor' re-fires every 60s tick (and escalates to force_respawn),
//   - 'manual' is a deliberate user button press they can repeat,
//   - 'inflight_strand_replay' is EXCLUDED on purpose so a replay that itself
//     re-drops does not re-queue — that keeps the drain loop-free (a re-drop by
//     the in-flight gate means a fresh strand now holds the seat, i.e. the
//     ticket is being served, so there is nothing left to strand).
const TRANSITION_TRIGGER_SOURCES = new Set<string>([
  'column_move',
  'next_ticket',
  'prerequisite_resolved',
]);

// Upper bound a queued replay lingers if its owning agent never emits another
// `agent_idle` to drain it. Set well above the strand TTL (CURRENT_TASK_STALE_MS
// = 15 min) so the blocking strand's own stale-sweep idle always fires first;
// the drain prunes anything older on every pass, so the map stays bounded even
// for an agent that goes fully silent. A pruned entry is NOT dropped silently:
// the drain writes a terminal `agent_trigger_replay_failed` row with
// reason=ttl_expired (ticket 1bcb0899 reviewer BLOCKER #2) so an abandoned
// transition stays observable, exactly like the attempt-exhaustion give-up.
const TRANSITION_REPLAY_TTL_MS = 30 * 60_000;

// Max times a single queued transition is re-attempted before the drain gives
// up and writes a terminal `agent_trigger_replay_failed` audit row (ticket
// 1bcb0899 reviewer BLOCKER). A replay whose emit is GATED (`_emitTrigger`
// returns '' — board paused / ticket pending / focus window / a fresh strand
// re-grabbed the seat between the idle and the emit) or THROWS (transient
// DB/SSE fault) is NOT consumed: it is re-queued so the NEXT `agent_idle`
// attempts it again, rather than vanishing while the audit falsely claims
// recovery. (There is no separate explicit-retry entry point — the drain's only
// caller is the `agent_idle` subscription — so "next agent_idle" is the retry.)
// This counter is the loop-guard that pairs with the TTL prune: whichever bound
// trips first, the entry ends on a terminal `agent_trigger_replay_failed` row
// (reason=attempts_exhausted vs ttl_expired), never a silent delete.
const MAX_TRANSITION_REPLAY_ATTEMPTS = 5;

// Outcome of one `_replayTransitionTrigger` pass, telling the drain whether the
// dequeued entry is truly done or must be re-queued for the next lifecycle
// signal:
//   - 'emitted'  — `_emitTrigger` returned a real (non-empty) event id; the
//                  recovery landed and the success audit row is now written.
//   - 'skipped'  — nothing is owed (ticket gone / on a terminal column / the
//                  agent no longer holds a routed role); consume, do not retry.
//   - 'deferred' — the emit was gated ('') or threw; re-queue and retry on the
//                  next `agent_idle` (bounded by MAX_TRANSITION_REPLAY_ATTEMPTS).
type TransitionReplayOutcome = 'emitted' | 'skipped' | 'deferred';

// One queued transition trigger awaiting the freeing of its (agent, ticket,
// role) seat. Held in memory only — same fire-and-forget philosophy as the rest
// of the dispatch path (no AgentTrigger table since v0.25.0); a process restart
// drops the queue, and the TicketSupervisor 60s re-push remains the crash-safe
// backstop.
interface PendingTransitionReplay {
  agentId: string;
  ticketId: string;
  role: string;
  triggerSource: string;
  triggeredBy: string;
  queuedAt: number;
  // How many times the drain has already tried (and had gated/threw) to replay
  // this seat. 0 at first enqueue; incremented each deferral. Bounded by
  // MAX_TRANSITION_REPLAY_ATTEMPTS so a permanently-ungateable entry can't loop.
  attempts: number;
}

@Injectable()
export class TriggerLoopService implements OnModuleInit, OnModuleDestroy {
  // Stored reference so OnModuleDestroy can detach the listener. In
  // production this is harmless (single init, process lives until restart),
  // but integration test rigs build/tear down the Nest module per spec —
  // without removal the listener count grows by one per spec until the
  // EventEmitter's MaxListenersExceededWarning fires. Finding-004 in
  // docs/audit/2026-05-system-cascade-audit.md.
  private _activityListener?: (log: ActivityLog) => void;

  // Transition-trigger preservation (ticket 1bcb0899). Detached in
  // onModuleDestroy for the same per-spec listener-leak reason as
  // _activityListener above.
  private _agentIdleListener?: (payload: { agent_id?: string; cleared_ticket_id?: string }) => void;

  // Queued one-shot transition triggers dropped by the in-flight-strand gate,
  // keyed by `${agentId}::${ticketId}::${role}` (the exact busy seat). Drained
  // and replayed when that seat's strand frees (agent_idle). At most one entry
  // per seat — a re-drop refreshes it rather than stacking.
  private readonly _pendingTransitionReplays = new Map<string, PendingTransitionReplay>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    private readonly agentWorkload: AgentWorkloadService,
    private readonly agentStatus: AgentStatusService,
    private readonly activityService: ActivityService,
    private readonly ticketPrerequisites: TicketPrerequisitesService,
    // Durable dispatch outbox (ticket e7c87517). `_emitTrigger` records a
    // durable intent on every landed dispatch and on the capacity/serialization
    // gate drops, so a lost/gated trigger is re-derived by DispatchReconciler
    // instead of evaporating. DispatchIntentService depends only on the
    // DataSource (never on TriggerLoopService), so this injection is cycle-free.
    private readonly dispatchIntents: DispatchIntentService,
    // Never-started / offline agent handling (ticket bfdd80b7). Classifies
    // reachability, attempts auto-start, and writes the user-facing "dispatch
    // 보류" feedback. Same module; it never injects TriggerLoopService, so
    // cycle-free.
    private readonly autostart: AgentAutostartService,
  ) {}

  onModuleInit() {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error in _handleActivity', { err: e });
      });
    };
    activityEvents.on('activity', this._activityListener);

    // Transition-trigger preservation (ticket 1bcb0899). A strand freeing its
    // seat is exactly when a transition trigger dropped by the in-flight gate
    // becomes replayable, so we listen for the same `agent_idle` signal
    // BacklogPromotionService uses. Fired by clearCurrentTask (normal exit,
    // carries cleared_ticket_id) AND the AgentStatusService stale-sweep (crash /
    // TTL, cleared_ticket_id undefined) — so both graceful and crashed strands
    // trigger a drain.
    this._agentIdleListener = (payload) => {
      this._drainTransitionReplays(payload?.agent_id, payload?.cleared_ticket_id).catch((e: unknown) => {
        this.logService.error('MCP', 'TriggerLoop error draining transition replays', { err: e });
      });
    };
    activityEvents.on('agent_idle', this._agentIdleListener);
  }

  onModuleDestroy() {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
    if (this._agentIdleListener) {
      activityEvents.removeListener('agent_idle', this._agentIdleListener);
      this._agentIdleListener = undefined;
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
      const shouldSkip = col.unassigned_policy === 'skip'
        || (col.unassigned_policy === 'skip_if_ticket_staffed' && await this._ticketHasAnyHolder(ticket.id));
      if (shouldSkip) {
        await this._autoAdvanceUnassigned(ticket, col);
      } else {
        await this._flagPolicyHalt(ticket, col, col);
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

  /** True when the ticket has any assigned agent or user in any role. */
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
   * Halt and leave an audit flag when the current or next column explicitly
   * declares `unassigned_policy=halt`.
   */
  private async _flagPolicyHalt(
    ticket: Ticket,
    col: BoardColumn,
    gateCol: BoardColumn,
  ): Promise<void> {
    this.logService.warn(
      'MCP',
      'auto_advance halted by column unassigned policy',
      {
        ticket_id: ticket.id,
        column_id: col.id,
        column_name: col.name,
        gate_column_id: gateCol.id,
        gate_column_name: gateCol.name,
        unassigned_policy: gateCol.unassigned_policy,
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
          action: 'auto_advance_halted_policy',
          new_value: `column=${col.id} blocked_column=${gateCol.id} reason=column_unassigned_policy_halt`,
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

  async emitCommentSummaryTrigger(ticketId: string, targetAgentId: string, runId: string): Promise<string> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) throw Object.assign(new Error('Ticket not found'), { status: 404 });
    const content = `Summarize all existing comments on ticket ${ticketId}. Preserve decisions, open questions, outcomes, and important context; omit repetitive operational noise. Do not edit or delete comments yourself. When ready, call mcp__awb__complete_comment_summary exactly once with run_id="${runId}", ticket_id="${ticketId}", status="succeeded", and summary="<your summary>". If you cannot summarize, call it with status="failed" and error="<reason>".`;
    // Summary work is independent of the ticket's workflow assignee strand.
    // A dedicated role prevents an active assignee turn from rejecting the
    // summary as a duplicate same-role strand.
    const triggerId = await this._emitTrigger(ticket, targetAgentId, 'comment_summary', 'comment_summary', '', {
      bypassFocus: true,
      // Summary work does not advance workflow, so parked tickets remain safe.
      bypassTicketPending: true,
      columnPromptOverride: { template_id: 'comment-summary-inline', name: 'Comment Summary', content },
    });
    if (!triggerId) throw Object.assign(new Error('The selected summary agent could not accept the dispatch'), {
      status: 503,
      code: 'SUMMARY_DISPATCH_REJECTED',
    });
    return triggerId;
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

  /** Map key for a queued transition replay — the exact busy (agent, ticket, role) seat. */
  private _transitionReplayKey(agentId: string, ticketId: string, role: string): string {
    return `${agentId}::${ticketId}::${role || ''}`;
  }

  /**
   * Transition-trigger preservation drain (ticket 1bcb0899). Invoked on every
   * `agent_idle` — a strand for `agentId` just freed its seat (normal
   * clearCurrentTask names `clearedTicketId`; the stale-sweep leaves it
   * undefined). Replay each queued transition trigger for this agent whose seat
   * is now actually free.
   *
   * Safety / loop-freedom:
   *   - Prunes entries older than TRANSITION_REPLAY_TTL_MS on every pass so the
   *     map is bounded even if an agent stops idling. A prune is a TERMINAL
   *     give-up, not a silent drop: it writes an `agent_trigger_replay_failed`
   *     row (reason=ttl_expired) so an abandoned transition stays observable
   *     (ticket 1bcb0899 reviewer BLOCKER #2). Pruning spans ALL agents, not
   *     just the one that idled, so a silent agent's stale entry is still reaped.
   *   - Re-checks `hasLiveRoleStrand` per entry: if a FRESH strand grabbed the
   *     same seat between the idle signal and now (or this idle was for another
   *     of the agent's tickets), the entry is LEFT queued — that strand's own
   *     later idle retries it. A still-live seat means the ticket is being
   *     served, so replaying now would just re-drop.
   *   - Dequeues BEFORE awaiting the replay, so a concurrent drain can't
   *     double-replay the same entry.
   *   - A replay whose emit is GATED ('') or THROWS returns 'deferred' and is
   *     RE-QUEUED (attempt-bounded) so the transition is not lost when the emit
   *     transiently drops — the fix for the reviewer BLOCKER on ticket 1bcb0899
   *     (a success audit must never precede a real emit; a gated emit must stay
   *     recoverable). Only 'emitted' / 'skipped' consume the entry for good.
   */
  private async _drainTransitionReplays(agentId?: string, clearedTicketId?: string): Promise<void> {
    if (!agentId || this._pendingTransitionReplays.size === 0) return;
    const now = Date.now();
    const candidates: Array<{ key: string; entry: PendingTransitionReplay }> = [];
    const expired: Array<{ entry: PendingTransitionReplay; ageMs: number }> = [];
    for (const [key, entry] of this._pendingTransitionReplays) {
      if (now - entry.queuedAt > TRANSITION_REPLAY_TTL_MS) {
        // TTL give-up. Dequeue now (bounds the map), but DO NOT drop silently —
        // a lapsed transition is exactly the stranded-ticket bug this ticket
        // exists to eliminate (1bcb0899 reviewer BLOCKER #2). Record it for a
        // terminal failed audit below, written outside this iteration since the
        // audit is async.
        this._pendingTransitionReplays.delete(key);
        expired.push({ entry, ageMs: now - entry.queuedAt });
        continue;
      }
      if (entry.agentId !== agentId) continue;
      candidates.push({ key, entry });
    }
    for (const { entry, ageMs } of expired) {
      this.logService.warn('MCP', 'transition-replay TTL-expired (giving up — transition NOT recovered)', {
        ticket_id: entry.ticketId, agent_id: entry.agentId, role: entry.role,
        dropped_source: entry.triggerSource, attempts: entry.attempts, age_ms: ageMs,
      });
      await this._writeReplayLifecycleAudit(
        entry,
        'agent_trigger_replay_failed',
        entry.attempts,
        clearedTicketId,
        'ttl_expired',
        ageMs,
      );
    }
    for (const { key, entry } of candidates) {
      // A concurrent drain (rapid successive agent_idle for this same agent)
      // may have already claimed this snapshotted entry — the has-check +
      // delete below are synchronous-adjacent, so they act atomically across
      // the await boundary and guarantee exactly-once replay.
      if (!this._pendingTransitionReplays.has(key)) continue;
      // Seat re-taken by a fresh strand (or this idle was for a sibling ticket)
      // → leave queued; that strand's exit fires another agent_idle to retry.
      if (this.agentStatus.hasLiveRoleStrand(entry.agentId, entry.ticketId, entry.role)) {
        continue;
      }
      this._pendingTransitionReplays.delete(key);
      let outcome: TransitionReplayOutcome;
      try {
        outcome = await this._replayTransitionTrigger(entry, clearedTicketId);
      } catch (e) {
        // A THROW (transient DB/SSE fault) is NOT a successful recovery — treat
        // it exactly like a gated emit and re-queue so the next idle retries,
        // rather than dropping the one-shot transition on the floor.
        this.logService.warn('MCP', 'transition-replay dispatch threw (will retry on next idle)', {
          err: String(e), ticket_id: entry.ticketId, agent_id: entry.agentId, role: entry.role,
        });
        outcome = 'deferred';
      }
      if (outcome === 'deferred') {
        await this._requeueDeferredReplay(key, entry, clearedTicketId);
      }
    }
  }

  /**
   * Re-queue a transition replay whose emit was GATED (`_emitTrigger` → '') or
   * THREW (ticket 1bcb0899 reviewer BLOCKER). The entry was already dequeued by
   * the drain; putting it back — with an incremented attempt count — is what
   * makes the recovery survive a transient drop instead of vanishing while the
   * audit falsely reads success. Loop-freedom is double-bounded:
   *   - MAX_TRANSITION_REPLAY_ATTEMPTS caps re-tries; on exhaustion we STOP and
   *     write a terminal `agent_trigger_replay_failed` row so the stranded
   *     transition stays greppable (the original bug hid it entirely).
   *   - the original `queuedAt` is preserved, so the TTL prune in the drain
   *     still bounds total lifetime regardless of idle cadence — and that prune
   *     is itself a terminal `agent_trigger_replay_failed` (reason=ttl_expired),
   *     so neither give-up path ends in a silent delete.
   * A fresh drop that re-queued this exact seat while we awaited is NOT
   * clobbered — it already carries the newer intent for the same recovery.
   */
  private async _requeueDeferredReplay(
    key: string,
    entry: PendingTransitionReplay,
    clearedTicketId?: string,
  ): Promise<void> {
    const attempts = entry.attempts + 1;
    if (attempts >= MAX_TRANSITION_REPLAY_ATTEMPTS) {
      this.logService.warn('MCP', 'transition-replay exhausted retries (giving up — transition NOT recovered)', {
        ticket_id: entry.ticketId, agent_id: entry.agentId, role: entry.role,
        dropped_source: entry.triggerSource, attempts,
      });
      await this._writeReplayLifecycleAudit(
        entry,
        'agent_trigger_replay_failed',
        attempts,
        clearedTicketId,
        'attempts_exhausted',
        Date.now() - entry.queuedAt,
      );
      return;
    }
    if (this._pendingTransitionReplays.has(key)) return;
    this._pendingTransitionReplays.set(key, { ...entry, attempts });
    this.logService.info('MCP', 'transition-replay deferred (emit gated/threw — re-queued for next idle)', {
      ticket_id: entry.ticketId, agent_id: entry.agentId, role: entry.role,
      dropped_source: entry.triggerSource, attempts,
    });
    await this._writeReplayLifecycleAudit(
      entry,
      'agent_trigger_replay_deferred',
      attempts,
      clearedTicketId,
    );
  }

  /**
   * Best-effort audit row for a deferred / failed replay lifecycle transition
   * (ticket 1bcb0899). Kept distinct from `agent_trigger_replayed_inflight_strand`
   * (which is written ONLY after a real emit) so a post-mortem can tell an
   * actual recovery from a retry-in-progress or a give-up. For a terminal
   * `agent_trigger_replay_failed` row the `reason` distinguishes the two
   * give-up paths — `attempts_exhausted` (emit kept gating/throwing) vs
   * `ttl_expired` (the entry aged out before its seat ever freed) — and `ageMs`
   * records how long it was owed, so the abandoned transition is diagnosable,
   * not just visible. actor_id='system' keeps it out of `_handleActivity`'s
   * self-echo guard, like every other TriggerLoopService audit row. A write
   * failure never gates the retry.
   */
  private async _writeReplayLifecycleAudit(
    entry: PendingTransitionReplay,
    action: 'agent_trigger_replay_deferred' | 'agent_trigger_replay_failed',
    attempts: number,
    clearedTicketId?: string,
    reason?: 'attempts_exhausted' | 'ttl_expired',
    ageMs?: number,
  ): Promise<void> {
    try {
      const activityLogRepo = this.dataSource.getRepository(ActivityLog);
      const newValue =
        `agent=${entry.agentId} role=${entry.role} dropped_source=${entry.triggerSource} attempts=${attempts}` +
        (reason !== undefined ? ` reason=${reason}` : '') +
        (ageMs !== undefined ? ` age_ms=${ageMs}` : '') +
        ` cleared_ticket=${clearedTicketId || ''}`;
      await activityLogRepo.save(activityLogRepo.create({
        entity_type: 'ticket',
        entity_id: entry.ticketId,
        ticket_id: entry.ticketId,
        actor_id: 'system',
        actor_name: 'TriggerLoopService',
        action,
        new_value: newValue,
        role: entry.role,
        trigger_source: 'inflight_strand_replay',
      }));
    } catch (e) {
      this.logService.warn('MCP', 'transition-replay lifecycle audit write failed (retry state still applied)', {
        err: String(e), ticket_id: entry.ticketId, agent_id: entry.agentId, action,
      });
    }
  }

  /**
   * Replay one queued transition trigger now that its seat is free. Re-resolves
   * the ticket's CURRENT column so an intervening move can't replay a stale
   * role, and only re-emits to the specific agent whose seat freed — and only
   * for a role that agent still holds on the current column. Silent skips (one
   * info log each) when there is nothing left owed:
   *   - ticket vanished / detached from a column
   *   - ticket already landed on a terminal column
   *   - the agent no longer holds any routed role on the current column
   *
   * Emits with trigger_source 'inflight_strand_replay' (deliberately NOT a
   * TRANSITION_TRIGGER_SOURCE, so a re-drop does not re-queue) and writes a
   * system-actor audit row so the automatic recovery is observable / greppable.
   * The emit funnels back through `_emitTrigger`, which re-applies the
   * pause / archived / pending / focus / in-flight gates against fresh state.
   */
  private async _replayTransitionTrigger(
    entry: PendingTransitionReplay,
    clearedTicketId?: string,
  ): Promise<TransitionReplayOutcome> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: entry.ticketId } });
    if (!ticket || !ticket.column_id) {
      this.logService.info('MCP', 'transition-replay skipped (ticket missing / no column)', {
        ticket_id: entry.ticketId, agent_id: entry.agentId,
      });
      return 'skipped';
    }
    const col = await this.dataSource
      .getRepository(BoardColumn)
      .findOne({ where: { id: ticket.column_id } });
    if (!col) return 'skipped';
    const isTerminal = (col as any).is_terminal === true || (col as any).kind === 'terminal';
    if (isTerminal) {
      this.logService.info('MCP', 'transition-replay skipped (ticket already on terminal column)', {
        ticket_id: entry.ticketId, agent_id: entry.agentId, column_id: col.id,
      });
      return 'skipped';
    }

    const slugs = safeJsonParse<string[]>((col as any).role_routing, []);
    if (!Array.isArray(slugs) || slugs.length === 0) return 'skipped';
    for (const slug of slugs) {
      const holders = await this._resolveRoleHolders(ticket, slug);
      if (!holders || !holders.agentIds.includes(entry.agentId)) continue;

      // Emit FIRST — only a real (non-empty) event id proves the recovery
      // actually landed (ticket 1bcb0899 reviewer BLOCKER). The emit funnels
      // back through `_emitTrigger`, which re-applies the pause / archived /
      // pending / focus / in-flight gates against fresh state and returns ''
      // when any of them drops it — OR a fresh strand may have re-grabbed the
      // seat between the drain's hasLiveRoleStrand check and this emit. Writing
      // the replay-success audit BEFORE the emit (as the pre-fix code did)
      // would falsely mark recovery in exactly those drop paths, re-losing the
      // one-shot transition while the audit claims success.
      this.logService.info('MCP', 'agent_trigger replay attempt (strand freed)', {
        ticket_id: ticket.id, agent_id: entry.agentId, role: slug,
        dropped_source: entry.triggerSource, attempts: entry.attempts,
      });
      const emittedId = await this._emitTrigger(
        ticket, entry.agentId, slug, 'inflight_strand_replay', entry.triggeredBy,
      );
      if (!emittedId) {
        // Gated by a fresh-state check (pause/pending/focus) or lost the seat
        // to a racing strand. Do NOT write a success audit; report 'deferred'
        // so the drain re-queues for the next agent_idle to retry.
        this.logService.info('MCP', 'transition-replay emit gated (deferring — no success audit written)', {
          ticket_id: ticket.id, agent_id: entry.agentId, role: slug,
          dropped_source: entry.triggerSource, attempts: entry.attempts,
        });
        return 'deferred';
      }

      // Real emit — the recovery is now genuinely observable. Tie the audit
      // back to the earlier queued drop; carry the emitted trigger id so the
      // row can be correlated to the actual dispatch. actor_id='system' keeps
      // it out of _handleActivity (self-echo guard), like the drop rows.
      try {
        const activityLogRepo = this.dataSource.getRepository(ActivityLog);
        await activityLogRepo.save(activityLogRepo.create({
          entity_type: 'ticket',
          entity_id: ticket.id,
          ticket_id: ticket.id,
          actor_id: 'system',
          actor_name: 'TriggerLoopService',
          action: 'agent_trigger_replayed_inflight_strand',
          new_value: `agent=${entry.agentId} role=${slug} dropped_source=${entry.triggerSource} attempts=${entry.attempts} trigger_id=${emittedId} cleared_ticket=${clearedTicketId || ''}`,
          role: slug,
          trigger_source: 'inflight_strand_replay',
        }));
      } catch (e) {
        this.logService.warn('MCP', 'transition-replay success audit write failed (emit already landed)', {
          err: String(e), ticket_id: ticket.id, agent_id: entry.agentId,
        });
      }

      this.logService.info('MCP', 'agent_trigger replayed (strand freed, transition recovered)', {
        ticket_id: ticket.id, agent_id: entry.agentId, role: slug,
        dropped_source: entry.triggerSource,
      });
      return 'emitted'; // one wake per agent (dedup mirrors the fan-out loop)
    }

    this.logService.info('MCP', 'transition-replay skipped (agent holds no routed role on current column)', {
      ticket_id: entry.ticketId, agent_id: entry.agentId, column_id: col.id,
    });
    return 'skipped';
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
   * Focus-window gate (ticket 4a6cdfd7 → generalized top-N in 701e5e36):
   *   Unless `opts.bypassFocus` is true, the emit only lands if THIS
   *   ticket sits inside the agent's top-N focus window for the board,
   *   where N = `Board.max_concurrent_tickets_per_agent`. Otherwise the
   *   call returns '' and writes no DB rows — non-window triggers are
   *   silent (AC #8).
   *
   * Fire-and-forget after the gate: no DB row, no ack, no retry.
   * TicketSupervisorService re-pushes stale allocations
   * (my_last_update_at older than 30 min) and escalates to
   * force_respawn after the cooldown if silence persists.
   */
  /**
   * Resolve the board's Agent-concurrency cap
   * (`Board.max_concurrent_tickets_per_agent`), clamped to a positive
   * integer with a default of 1. Single source of truth shared by the
   * focus-window admission gate and the manager-side defensive cap hint on
   * the trigger payload, so server-side rank admission and the manager
   * ceiling can never disagree about N. A lookup failure logs a warning
   * and falls back to 1 (serial) — the safe direction.
   */
  private async _resolveConcurrencyCap(boardId: string): Promise<number> {
    try {
      const board = await this.dataSource
        .getRepository(Board)
        .findOne({ where: { id: boardId } });
      if (board && Number.isFinite(board.max_concurrent_tickets_per_agent)) {
        return Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent));
      }
    } catch (e) {
      this.logService.warn('MCP', 'board concurrency cap lookup failed (defaulting to 1)', {
        err: String(e), board_id: boardId,
      });
    }
    return 1;
  }

  /**
   * Pending-user-action 게이트 판정 (ticket be934f61). `_emitTrigger` 안에서
   * 완전히 동일한 재조회+드롭+감사로그 로직을 두 지점에서 재사용하기 위해
   * 추출했다: (1) 기존 위치(아카이브 게이트 직후) — 이미 pending이면 이후의
   * harness/effort/environment/board-lessons 해석을 아예 건너뛰는 얼리 드롭,
   * (2) 실제 SSE emit 바로 직전 — (1)과 emit 사이의 십여 개 await가 열어 둔
   * TOCTOU 창을 닫기 위한 마지막 순간 재확인. 신선한 조회 결과 ticket이
   * pending이라 트리거를 드롭해야 하면 true를 반환한다.
   */
  private async _checkPendingUserGate(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    bypassTicketPending: boolean | undefined,
  ): Promise<boolean> {
    if (bypassTicketPending) return false;
    const freshForGate = await this.dataSource
      .getRepository(Ticket)
      .findOne({ where: { id: ticket.id } });
    // Two distinct pending flavors funnel through this one gate (ticket
    // 48d14fff): `pending_user_action` (waiting on a human) and
    // `pending_on_tickets` (blocked behind prerequisite tickets). Either
    // drops the trigger. The audit action is suffixed so a grep can tell the
    // two apart — `_pending_user` vs `_pending_tickets`.
    if (!freshForGate?.pending_user_action && !freshForGate?.pending_on_tickets) return false;

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
    return true;
  }

  private async _emitTrigger(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
    triggeredBy: string,
    opts?: {
      forceRespawn?: boolean;
      bypassFocus?: boolean;
      bypassTicketPending?: boolean;
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
        if (triggerSource === 'comment_summary') {
          throw Object.assign(new Error('Manager agents cannot run comment summaries'), {
            status: 503, code: 'SUMMARY_DISPATCH_MANAGER_AGENT',
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
        if (triggerSource === 'comment_summary') {
          throw Object.assign(new Error('The board is paused'), {
            status: 503, code: 'SUMMARY_DISPATCH_BOARD_PAUSED',
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
        if (triggerSource === 'comment_summary') {
          throw Object.assign(new Error('The ticket is archived'), {
            status: 503, code: 'SUMMARY_DISPATCH_TICKET_ARCHIVED',
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
    //
    // 얼리 드롭 지점 (ticket be934f61): 판정/로깅/감사 로직은
    // `_checkPendingUserGate`로 추출했다 — 여기서 이미 pending이면 아래의
    // harness/effort/environment/board-lessons 해석을 아예 건너뛴다. 그 해석
    // 구간이 열어 두는 잔여 TOCTOU 창은 실제 SSE emit 직전의 두 번째 호출이
    // 닫는다(해당 지점 주석 참조).
    if (await this._checkPendingUserGate(ticket, agentId, role, triggerSource, opts?.bypassTicketPending)) {
      return '';
    }

    // Focus-window gate (ticket 701e5e36 — generalizes the old top-1
    // focus gate to top-N). The window is the agent's top-N ranked
    // tickets for this board, where N = `Board.max_concurrent_tickets_per_agent`
    // ("Agent concurrency", default 1). A trigger is admitted only when
    // its ticket sits inside that window; anything ranked below N is
    // silently inert. Ranking (column.position DESC → chain-head →
    // priority → created_at ASC) is shared with the board FOCUS badge
    // and the backlog-promotion gate via `getAgentFocusTicketIds`, so all
    // three agree on the same cap meaning. Manual triggers bypass via
    // opts.bypassFocus.
    //
    // Why this doesn't reopen the GameClient storm (43 To Do tickets all
    // re-triggering every 5 min): the window is workflow-state ranked, and
    // In-Progress / Merging columns outrank To Do (higher column.position).
    // So an agent already holding N tickets on active columns fills its
    // whole window with those, and every excess To Do trigger drops. The
    // cap is enforced by *rank position*, not by counting live subagent
    // processes — that keeps the static workflow-state-cap guard invariant
    // (never gate on AgentStatusService.getActiveTicketIds, which re-opens
    // on WAIT-only turns). A To Do ticket is admitted only once an active
    // slot frees (a held ticket lands on terminal and leaves the window).
    //
    // Agent-unit, not per-role: the window collapses across every role the
    // agent holds (SELECT DISTINCT by ticket), matching the manager's
    // per-agent ceiling (ticket-session-manager counts distinct tickets per
    // agentId) and the FOCUS badge. A 겸직 agent (e.g. assignee + reviewer)
    // therefore gets N total dispatch slots, not N-per-role — the old
    // per-role gate over-promised for 겸직 while the manager capped at N.
    //
    // Drops are SILENT: no SSE emit, no DB row, no audit. Per AC #8 of
    // ticket 4a6cdfd7 we keep zero queue churn on drops. The window is
    // logged at info level so an operator tailing the server log can still
    // see why a particular emit dropped.
    if (!opts?.bypassFocus && boardId) {
      const cap = await this._resolveConcurrencyCap(boardId);
      const focusWindow = await this.agentWorkload.getAgentFocusTicketIds(agentId, boardId, cap);
      if (!focusWindow.includes(ticket.id)) {
        this.logService.info('MCP', 'agent_trigger dropped (outside focus window)', {
          ticket_id: ticket.id, agent_id: agentId, role,
          source: triggerSource, cap, focus_window: focusWindow,
        });
        // Durable recovery pointer (ticket e7c87517). A focus/capacity drop is
        // the exact "starvation" shape that left 30603ce6 idle — the trigger is
        // OWED but capacity-gated. Record a durable `pending` intent so the
        // reconciler re-dispatches the instant an active slot frees, instead of
        // relying on a later organic event to happen to re-fire this column.
        // Skip the reconciler's OWN re-dispatch (it manages the intent via
        // claimForDispatch) so we don't double-touch the row it just claimed.
        if (triggerSource !== DISPATCH_RECONCILE_SOURCE) {
          await this.dispatchIntents.recordOwed({
            workspaceId: ticket.workspace_id || '', boardId, ticketId: ticket.id,
            role, agentId, triggerSource, reason: `focus_window_capacity cap=${cap}`,
          });
        }
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
      // Transition-trigger preservation (ticket 1bcb0899). Queue a one-shot
      // transition (column_move / next_ticket / prerequisite_resolved) so the
      // agent_idle drain replays it the instant the blocking strand frees,
      // instead of leaving the ticket stranded until an unrelated event happens
      // to re-dispatch its column. Enqueue SYNCHRONOUSLY (before any await) so a
      // same-tick clearCurrentTask can't emit agent_idle between this gate check
      // and the enqueue and miss it — single-threaded, so the check + set are
      // atomic. Non-transition sources self-correct (see TRANSITION_TRIGGER_SOURCES)
      // and are left unqueued.
      const queuedForReplay = TRANSITION_TRIGGER_SOURCES.has(triggerSource);
      if (queuedForReplay) {
        this._pendingTransitionReplays.set(
          this._transitionReplayKey(agentId, ticket.id, role),
          { agentId, ticketId: ticket.id, role, triggerSource, triggeredBy, queuedAt: Date.now(), attempts: 0 },
        );
      }
      this.logService.info('MCP', 'agent_trigger dropped (live same-role strand in flight)', {
        ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
        queued_for_replay: queuedForReplay,
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
          new_value: `agent=${agentId} role=${role} source=${triggerSource} queued_for_replay=${queuedForReplay}`,
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
      // Durable recovery pointer (ticket e7c87517). The transition-replay queue
      // above is IN-MEMORY, so a crash between this gate and the agent_idle
      // drain loses the queued replay. Record a durable `pending` intent as the
      // crash-safe backstop: even if the in-memory replay is lost, the
      // reconciler re-dispatches once the live strand frees (resolved the moment
      // that strand actually makes forward progress). Non-transition sources get
      // the same durability instead of the old "self-correct" assumption. Skip
      // the reconciler's own re-dispatch (it owns the intent lifecycle).
      if (triggerSource !== DISPATCH_RECONCILE_SOURCE) {
        await this.dispatchIntents.recordOwed({
          workspaceId: ticket.workspace_id || '', boardId, ticketId: ticket.id,
          role, agentId, triggerSource,
          reason: `inflight_strand_serialization queued_for_replay=${queuedForReplay}`,
        });
      }
      if (triggerSource === 'comment_summary') {
        throw Object.assign(new Error('A comment summary strand is already running for this ticket'), {
          status: 503, code: 'SUMMARY_DISPATCH_LIVE_STRAND',
        });
      }
      return '';
    }

    // Agent reachability feedback (ticket bfdd80b7). ADDITIVE — deliberately
    // NOT a gate. If the agent is not reachable (never-started / offline) the
    // SSE emit below evaporates at zero subscribers with NO user signal (the
    // silent-drop bug). We surface an explicit "dispatch 보류: agent 미시작"
    // ticket comment + activity and attempt auto-start (spawn_agent) here, then
    // let the emit proceed exactly as before so the durable outbox still records
    // the in_flight intent the reconciler retries (its design tolerates an
    // evaporated emit — spawn success is NOT resolution). When auto-start lands,
    // the next reconciler re-dispatch reaches the now-online agent. Debounced
    // internally so the supervisor/reconciler re-push doesn't spam. Best-effort:
    // a feedback failure must never gate the dispatch.
    try {
      await this.autostart.maybeHandleUnreachableTicket({
        ticket,
        agentId,
        role,
        triggerSource,
        triggeredBy,
      });
    } catch (e) {
      this.logService.warn('MCP', 'unreachable-agent feedback/auto-start failed (dispatch continues)', {
        err: String(e), ticket_id: ticket.id, agent_id: agentId,
      });
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
    // `let` (not `const`): when the ticket carries no base repo, the board
    // environment repo is backfilled in below (goal 1, ticket 8c3befa8) after
    // the merged environment_config is resolved.
    let baseRepoId = freshTicket?.base_repo_resource_id || ticket.base_repo_resource_id || '';
    let baseBranch = freshTicket?.base_branch || ticket.base_branch || '';
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

    // Manager-side defensive cap, shipped on the wire so the agent-manager
    // can back-stop the server admission during the set_current_task lag
    // window (ticket-session-manager counts distinct tickets per agent).
    // Same cap the server-side focus-window gate above enforces by rank —
    // both read `Board.max_concurrent_tickets_per_agent` through the shared
    // `_resolveConcurrencyCap` helper so server and manager never disagree
    // about N.
    const maxConcurrent = boardId ? await this._resolveConcurrencyCap(boardId) : 1;

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
    // Merged board+workspace environment repositories, captured for the base_repo
    // backfill below (goal 1, ticket 8c3befa8). Populated inside the resolve
    // try so a base-repo-less ticket can inherit the board's default repo.
    let boardEnvRepositories: { resource_id?: string }[] = [];
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
        boardEnvRepositories = mergedEnv.repositories || [];
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

    // ── base repo binding (ticket 8c3befa8) ──────────────────────────────────
    // Goal 1 — auto-bind the board environment repo as the DEFAULT base repo.
    // When the ticket carries no base repo of its own, fall back to the merged
    // environment's first repository (its resource_id → the Resource's url +
    // default_branch). This gives the SERVER the same repo agent-manager would
    // otherwise resolve via its own env fallback, so the base_repo shipped on
    // the wire is authoritative AND the guard below can pend accurately when
    // nothing resolves. Only runs when the ticket has no base repo — a
    // ticket-set repo always wins.
    if (!baseRepoId && baseRepoWorkspaceId) {
      const picked = pickBaseRepoResourceId('', boardEnvRepositories);
      if (picked.resourceId) {
        try {
          const r = await this.dataSource.getRepository(Resource).findOne({
            where: { id: picked.resourceId, workspace_id: baseRepoWorkspaceId },
          });
          if (r) {
            baseRepoId = r.id;
            baseRepo = { id: r.id, name: r.name, url: r.url || '', default_branch: r.default_branch || '' };
            if (!baseBranch) baseBranch = baseRepo.default_branch;
            this.logService.info('MCP', 'base_repo backfilled from board environment (ticket 8c3befa8)', {
              ticket_id: ticket.id, base_repo_id: baseRepoId, base_branch: baseBranch, source: picked.source,
            });
          }
        } catch (e) {
          this.logService.warn('MCP', 'base_repo backfill lookup failed (continuing without)', {
            err: String(e), ticket_id: ticket.id, base_repo_id: picked.resourceId,
          });
        }
      }
    }

    // Goal 2 — force a base repo (guard). An assignee dispatched onto an active
    // (branch-work) column with NO resolvable repo (neither the ticket's own id
    // nor the board-env backfill above) would land in a worktree it can't push
    // from: credential install early-returns on a null repo → `git push` dies
    // with `could not read Username`, and agent-manager's fail-closed
    // provisioning aborts every cycle with "worktree 프로비저닝 실패" (the comment
    // spam this ticket targets). Rather than emit into that guaranteed downstream
    // abort, pend the ticket for human attention and skip the emit — no repo
    // guessing, fail closed. Subsequent dispatches short-circuit at the pending
    // gate above.
    //
    // Deliberately UNCONDITIONAL on whether a repo was pre-declared: the ticket's
    // acceptance blocks even when the ticket AND the board env are both empty
    // ("보드에 environment repo 가 없는 상태로 base_repo 미지정 → 추정 없이
    // pend/차단"). This also mirrors the manager, which already fails such a
    // dispatch closed with `missing_repository_resource` — there is no branch-work
    // dispatch that legitimately runs without a repo, so blocking here just moves
    // that inevitable failure earlier as a clean pend. `requiresBaseRepo` (inside
    // the predicate) scopes the block to assignee+active, so planner / reviewer /
    // QA / chat dispatches never trip it.
    if (
      shouldBlockDispatchForMissingRepo({
        role,
        columnKind: (col as any)?.kind,
        hasResolvedBaseRepo: !!baseRepo,
      })
    ) {
      await this._pendForMissingBaseRepo(ticket, agentId, role, triggerSource);
      if (triggerSource === 'comment_summary') {
        throw Object.assign(new Error('No repository is configured for this dispatch'), {
          status: 503, code: 'SUMMARY_DISPATCH_REPOSITORY_MISSING',
        });
      }
      return '';
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

    // 마지막 순간 재확인 (ticket be934f61 — TOCTOU race). 위쪽 얼리 드롭
    // (_checkPendingUserGate 최초 호출) 이후 여기까지 오는 동안 agent/role
    // 조회, base-repo/column-prompt/harness/effort/environment 해석,
    // board-lessons 주입, chain-target 조회 등 십여 개의 await가 더 지나갔다
    // — 그 창 안에서 걸린 pend_ticket은 얼리 드롭에는 보이지 않는다. 동일
    // 헬퍼로(판정 로직 중복 없이) 실제 emit 바로 앞에서 한 번 더 신선 조회한다.
    // 이 호출과 아래 emit 사이에는 다른 await가 없다 — 그것이 이 재확인의
    // 존재 이유다.
    if (await this._checkPendingUserGate(ticket, agentId, role, triggerSource, opts?.bypassTicketPending)) {
      return '';
    }

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

    // Durable dispatch record (ticket e7c87517). This trigger LANDED — mark the
    // (ticket, role) intent `in_flight` with the fresh trigger_id and a
    // processing-grace deadline. CRITICAL: a landed dispatch is NOT resolution.
    // If the spawned strand dies silently (no comment / move / claim / output),
    // the reconciler re-dispatches once the grace elapses; only real forward
    // progress or a terminal/parked/unstaffed ticket resolves the intent. The
    // manager's `processed` ack (if it arrives) just extends the grace — spawn
    // success never closes the loop. Best-effort: recording never blocks/faults
    // the emit (the method swallows its own errors; the reconciler seeder is the
    // backstop if it somehow doesn't run). Skip the reconciler's own re-dispatch
    // — it already claimed + bumped the intent generation via claimForDispatch,
    // so re-recording here would double-count attempts and drop its lease.
    if (triggerSource !== DISPATCH_RECONCILE_SOURCE) {
      await this.dispatchIntents.recordDispatched({
        workspaceId: ticket.workspace_id || '', boardId, ticketId: ticket.id,
        role, agentId, triggerSource, triggerId,
      });
    }

    return triggerId;
  }

  /**
   * Goal 2 guard (ticket 8c3befa8): pend a ticket whose assignee dispatch has
   * no resolvable base repo (neither on the ticket nor on the board
   * environment). Pending drops all future triggers at the gate above, so the
   * assignee stops looping into a worktree it can't push from. Idempotent — a
   * ticket already pending is left untouched (no duplicate comment/audit), and
   * the pending gate means this fires at most once per stuck cycle.
   */
  private async _pendForMissingBaseRepo(
    ticket: Ticket,
    agentId: string,
    role: string,
    triggerSource: string,
  ): Promise<void> {
    const reason =
      'base repo 미해결 — assignee 가 push 할 저장소를 확정할 수 없습니다. 티켓 base repo 또는 보드 ' +
      'environment_config repository 가 설정돼 있으나 해결되지 않았습니다(Resource 삭제/타 workspace, ' +
      '또는 credential 없는 url-only 항목). 유효한 repository Resource 를 지정한 뒤 pending 을 해제하세요.';

    // Re-read fresh before flipping — an operator/parallel pend could race us,
    // and we must not clobber or re-comment an already-pending ticket.
    const fresh = await this.dataSource.getRepository(Ticket).findOne({
      where: { id: ticket.id },
    });
    if (!fresh || fresh.pending_user_action || fresh.pending_on_tickets || fresh.archived_at) {
      this.logService.info('MCP', 'base_repo guard: dispatch skipped, ticket already parked (ticket 8c3befa8)', {
        ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
      });
      return;
    }

    fresh.pending_user_action = true;
    fresh.pending_reason = reason;
    fresh.pending_set_at = new Date();
    fresh.pending_set_by = 'TriggerLoopService';
    await this.dataSource.getRepository(Ticket).save(fresh);

    this.logService.warn('MCP', 'base_repo guard: dispatch blocked, ticket pended (ticket 8c3befa8)', {
      ticket_id: ticket.id, agent_id: agentId, role, source: triggerSource,
    });

    // Audit row — same shape pend_ticket emits (drives the ticket_pended SSE).
    try {
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
        field_changed: 'pending_user_action',
        old_value: 'false', new_value: 'true',
        ticket_id: ticket.id,
        actor_id: 'system',
        actor_name: 'TriggerLoopService',
      });
    } catch (e) {
      this.logService.warn('MCP', 'base_repo guard: pend audit write failed (pend still applied)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

    // Visible comment so the block is discoverable from the thread, not just
    // the User tab. Deliberately no role mention — pending drops triggers, and
    // the pend_reason on the User tab is the human-facing surface.
    try {
      const commentRepo = this.dataSource.getRepository(Comment);
      const content = [
        '🚫 **Dispatch 차단 — base repo 미해결 (ticket 8c3befa8 guard)**',
        '',
        reason,
        '',
        `_role=${role} · agent=${agentId} · source=${triggerSource}_`,
      ].join('\n');
      await commentRepo.save(commentRepo.create({
        ticket_id: ticket.id,
        workspace_id: fresh.workspace_id || ticket.workspace_id || '',
        author_type: 'system',
        author_id: '',
        author: 'TriggerLoopService',
        content,
        type: 'note',
      }));
    } catch (e) {
      this.logService.warn('MCP', 'base_repo guard: pend comment write failed (pend still applied)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
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
