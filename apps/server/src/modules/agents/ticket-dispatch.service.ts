import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';
import { randomUUID } from 'crypto';
import { Ticket } from '../../entities/Ticket';
import { Account } from '../../entities/Account';
import { Comment } from '../../entities/Comment';
import { User } from '../../entities/User';
import { isUuidShapedId } from '../../utils/agent-name';
import { ActivityLog } from '../../entities/ActivityLog';
import { TicketDuplicateDecision } from '../../entities/TicketDuplicateDecision';
import { ActivityService, activityEvents } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { InstanceQuiesceService } from '../../services/instance-quiesce.service';
import { AgentConnectivityRegistry } from '../../services/agent-connectivity.registry';
import { InstanceRegistryService } from '../agent-manager/instance-registry.service';
import { AgentManagerCommandService } from '../agent-manager/agent-manager-command.service';
import { AgentStatusService } from './agent-status.service';
import { RunSkillSnapshotService } from '../skills/run-skill-snapshot.service';
import { TicketPrerequisitesService } from '../tickets/ticket-prerequisites.service';
import { ProjectsService } from '../projects/projects.service';
import { parseRuntimeSpec, runtimeIdentityKey, type RuntimeSpec } from '../../common/runtime-spec';
import { isTicketPending, statusColumnProjection, type TicketStatus } from '../../common/ticket-status';
import { renderTicketWorkOrder, TICKET_WORK_ORDER_NAME, TICKET_WORK_ORDER_TEMPLATE_ID } from '../../common/ticket-work-order';
import { appendBoardLanguageInstruction, parseHarnessConfig } from '../../common/harness-config';
import { parseEnvironmentConfig, resolveEnvironmentConfig } from '../../common/environment-config';
import { resolveClonePolicy } from '../../common/clone-policy';
import { resolveClaudeBackendProfileForDispatch } from '../../common/claude-backend-registry';
import { cliDescriptor } from '../../common/cli-catalog';
import type { CliRuntimeProfile } from '../../common/cli-runtime-profiles';
import { priorityIndex } from './priority';
import type { AgentTriggerPayload } from '../../common/types/stream-events';

export interface DispatchResult {
  dispatched: boolean;
  reason?: string;
  trigger_id?: string;
}

/** Why a ticket got (re)sent to its assignee — carried as `trigger_source`. */
export type DispatchSource =
  | 'start'          // todo → in_progress
  | 'comment'        // a human commented on an in_progress ticket
  | 'manual'         // "Run" button / REST trigger
  | 'unpend'         // a pending flag was cleared
  | 'prerequisite_resolved'
  | 'ci_wait_resolved'
  | 'reassigned'     // assignee changed on an in_progress ticket
  | 'supervisor'     // the agent died without finishing
  | 'nack_retry'     // the manager refused the last dispatch; retrying
  | string;

/** Supervisor re-sends without the agent making progress before the ticket is parked. */
export const MAX_SUPERVISOR_REDISPATCHES = 3;
const SWEEP_INTERVAL_MS = 30_000;
const NACK_RETRY_BASE_MS = 60_000;
const OFFLINE_NOTICE_COOLDOWN_MS = 60 * 60_000;
const NACK_RETRY_STALE_MS = 24 * 60 * 60_000;

/**
 * Ticket dispatch (docs/tickets.md) — the one place that decides when a
 * ticket's assignee agent gets an `agent_trigger`.
 *
 *   - Queue: `todo` tickets with an assignee are started (moved to
 *     `in_progress` + dispatched) as soon as that agent identity has capacity
 *     (`workspace.max_concurrent_tickets_per_agent` non-pending in_progress
 *     tickets). Ordered priority → position → created_at.
 *   - Re-wake: an `in_progress` ticket is re-sent on a human comment, unpend,
 *     prerequisites resolved, CI wait resolved, reassignment or manual Run.
 *   - Supervisor: an `in_progress` ticket whose agent shows no live strand and
 *     no activity for `workspace.supervisor_stale_ms` is re-sent (force
 *     respawn), then every `supervisor_resend_ms`, at most
 *     MAX_SUPERVISOR_REDISPATCHES times without progress; then it is parked
 *     for a human.
 *   - Done hooks: `next_ticket_id` promotion and prerequisite dependents.
 *
 * Every state change funnels through activity events, so the dispatcher only
 * listens; a periodic sweep backs the events up (a lost event delays work by
 * one sweep, it never strands a ticket).
 */
@Injectable()
export class TicketDispatchService implements OnModuleInit, OnModuleDestroy {
  private readonly listener = (activity: ActivityLog) => {
    void this.onActivity(activity).catch((err) =>
      this.logService.warn('Dispatch', 'activity handling failed', { err: String(err), ticket_id: activity?.ticket_id }),
    );
  };
  private sweepTimer: NodeJS.Timeout | null = null;
  // Serializes queue pumps so two events can't start the same slot twice.
  private pumpChain: Promise<unknown> = Promise.resolve();
  private readonly nackRetryAt = new Map<string, { at: number; attempts: number }>();
  private readonly offlineNoticeAt = new Map<string, number>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    private readonly instanceQuiesce: InstanceQuiesceService,
    private readonly connectivity: AgentConnectivityRegistry,
    private readonly instanceRegistry: InstanceRegistryService,
    private readonly agentStatus: AgentStatusService,
    private readonly runSkillSnapshots: RunSkillSnapshotService,
    private readonly prerequisites: TicketPrerequisitesService,
    private readonly projects: ProjectsService,
    // 미션/팀과 같은 credential materialization 함정: assignee spec의 credential
    // 파일은 spawn_agent 경로에서만 쓰이므로, 프로비저닝된 적 없는 identity는
    // 여기서 best-effort로 확보한다. 스텁 생성자는 비워 두면 훅이 건너뛴다.
    // (AgentsModule ↔ AgentManagerModule 순환은 모듈 레벨 forwardRef로 해소돼
    //  있으므로, 같은 모듈의 autostart 서비스와 같이 plain 주입한다.)
    private readonly commands?: AgentManagerCommandService,
  ) {}

  onModuleInit(): void {
    activityEvents.on('activity', this.listener);
    if (process.env.AWB_TICKET_DISPATCH_SWEEP !== '0') {
      this.sweepTimer = setInterval(() => {
        void this.sweep().catch((err) => this.logService.warn('Dispatch', 'sweep failed', { err: String(err) }));
      }, SWEEP_INTERVAL_MS);
      this.sweepTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    activityEvents.off('activity', this.listener);
    if (this.sweepTimer) clearInterval(this.sweepTimer);
  }

  // ── public API ────────────────────────────────────────────────────────

  /** Start queued `todo` tickets that have capacity. Scoped when filters are given. */
  startQueued(filter: { accountId?: string; assigneeKey?: string } = {}): Promise<number> {
    const run = this.pumpChain.then(() => this.pump(filter));
    this.pumpChain = run.catch(() => undefined);
    return run;
  }

  /**
   * "Something that blocked this ticket went away" — the replacement for the
   * old per-column re-dispatch. todo → queue it; in_progress → re-send.
   */
  async resumeTicket(ticketId: string, source: DispatchSource): Promise<DispatchResult> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) return { dispatched: false, reason: 'not_found' };
    if (ticket.status === 'todo') {
      await this.startQueued({ assigneeKey: ticket.assignee_key || undefined });
      const fresh = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
      return fresh?.status === 'in_progress' ? { dispatched: true } : { dispatched: false, reason: 'queued' };
    }
    if (ticket.status !== 'in_progress') return { dispatched: false, reason: `status_${ticket.status}` };
    return this.dispatch(ticket, source);
  }

  /** Manual Run: a todo ticket starts now (still capacity-bound); in_progress re-sends. */
  async manualTrigger(ticketId: string): Promise<DispatchResult> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket) return { dispatched: false, reason: 'not_found' };
    if (!ticket.assignee_key) return { dispatched: false, reason: 'unassigned' };
    if (ticket.status === 'todo') {
      const started = await this.startQueued({ assigneeKey: ticket.assignee_key });
      const fresh = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
      if (fresh?.status === 'in_progress') return { dispatched: true };
      return { dispatched: false, reason: started === 0 ? await this.blockReason(ticket) : 'queued' };
    }
    if (ticket.status !== 'in_progress') return { dispatched: false, reason: `status_${ticket.status}` };
    return this.dispatch(ticket, 'manual');
  }

  /**
   * Manager → server dispatch result (`POST /api/agent-manager/dispatch/ack`).
   * A nack schedules a backoff retry through the sweep; processed clears it.
   */
  async applyManagerAck(args: {
    ticketId: string; triggerId: string; outcome: 'processed' | 'nack' | 'suppressed'; reason?: string; managerAgentId?: string;
  }): Promise<{ applied: boolean }> {
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: args.ticketId } });
    if (!ticket) return { applied: false };
    await this.dataSource.getRepository(ActivityLog).save({
      entity_type: 'ticket',
      entity_id: args.ticketId,
      ticket_id: args.ticketId,
      account_id: ticket.account_id || '',
      action: `dispatch_ack_${args.outcome}`,
      field_changed: args.triggerId || '',
      new_value: (args.reason || '').slice(0, 500),
      role: 'assignee',
      actor_id: args.managerAgentId || '',
      actor_name: 'AgentManager',
    });
    if (args.outcome === 'nack') {
      const prev = this.nackRetryAt.get(args.ticketId);
      const attempts = (prev?.attempts ?? 0) + 1;
      this.nackRetryAt.set(args.ticketId, { at: Date.now() + NACK_RETRY_BASE_MS * Math.min(2 ** (attempts - 1), 30), attempts });
    } else {
      this.nackRetryAt.delete(args.ticketId);
    }
    return { applied: true };
  }

  // ── event handling ────────────────────────────────────────────────────

  private async onActivity(activity: ActivityLog): Promise<void> {
    // Resuming a paused workspace (or raising its per-agent cap) can start
    // queued tickets right away instead of waiting for the sweep.
    if (activity?.entity_type === 'account' && activity.action === 'config_changed'
      && ['dispatch_paused_at', 'max_concurrent_tickets_per_agent'].includes(activity.field_changed || '')) {
      await this.startQueued({ accountId: String(activity.entity_id) });
      return;
    }
    if (!activity?.ticket_id) return;
    if (activity.entity_type === 'comment' && activity.action === 'created') {
      await this.onComment(String(activity.entity_id), activity.ticket_id);
      return;
    }
    if (activity.entity_type !== 'ticket') return;
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: activity.ticket_id } });
    if (!ticket) {
      if (activity.action === 'deleted') await this.startQueued({ accountId: activity.account_id || undefined });
      return;
    }
    if (ticket.parent_id) return; // children are a checklist, never dispatched

    const byAgent = activity.actor_id ? !(await this.isUser(activity.actor_id)) : false;
    if (byAgent && activity.action !== 'created' && ticket.supervisor_redispatches > 0) {
      await this.dataSource.getRepository(Ticket).update({ id: ticket.id }, { supervisor_redispatches: 0 });
    }

    // Re-sends of an in_progress ticket (unpend, reassignment, …) are explicit
    // resumeTicket()/dispatch() calls from the path that made the change —
    // inferring them from activity rows too would wake the agent twice.
    if (activity.action === 'moved' && ticket.status === 'done') await this.onDone(ticket);
    // Any ticket change can open or fill a slot — re-pump the workspace.
    await this.startQueued({ accountId: ticket.account_id || undefined });
  }

  private async onComment(commentId: string, ticketId: string): Promise<void> {
    const comment = await this.dataSource.getRepository(Comment).findOne({ where: { id: commentId } });
    if (!comment) return;
    const ticket = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticketId } });
    if (!ticket || ticket.parent_id) return;
    if (comment.author_type !== 'user') {
      // The agent writing on its own ticket is progress — the supervisor's
      // dead-agent counter starts over.
      if (ticket.supervisor_redispatches > 0) {
        await this.dataSource.getRepository(Ticket).update({ id: ticket.id }, { supervisor_redispatches: 0 });
      }
      return;
    }
    if (ticket.status !== 'in_progress' || !ticket.assignee_key || isTicketPending(ticket)) return;
    // An explicit @mention of the assignee already wakes it through
    // comment_mention — sending a trigger too would wake it twice.
    if ((comment.content || '').includes(ticket.assignee_key)) return;
    await this.dispatch(ticket, 'comment');
  }

  private async onDone(ticket: Ticket): Promise<void> {
    // A duplicate closed by its canonical is an audit record, not finished
    // work — its next ticket, dependents and the rest stay untouched.
    if (ticket.canonical_ticket_id) return;
    await this.resolveDuplicates(ticket);
    // Chain: a backlog next ticket becomes todo, which queues it.
    if (ticket.next_ticket_id) {
      const repo = this.dataSource.getRepository(Ticket);
      const next = await repo.findOne({ where: { id: ticket.next_ticket_id } });
      if (next && next.account_id === ticket.account_id && next.status === 'backlog' && !next.archived_at) {
        const res = await repo.update({ id: next.id, status: 'backlog' }, { status: 'todo' });
        if (res.affected) {
          await this.activityService.logActivity({
            entity_type: 'ticket', entity_id: next.id, ticket_id: next.id, account_id: next.account_id,
            action: 'moved', field_changed: 'status', old_value: 'backlog', new_value: 'todo',
            actor_name: 'AWB', trigger_source: 'next_ticket',
          });
        }
      }
    }
    const flipped = await this.prerequisites.onPrerequisiteReached(ticket.id);
    for (const dependentId of flipped) {
      await this.resumeTicket(dependentId, 'prerequisite_resolved');
    }
  }

  /** Close every open duplicate confirmed against a canonical ticket that just finished. */
  private async resolveDuplicates(canonical: Ticket): Promise<void> {
    const repo = this.dataSource.getRepository(Ticket);
    const duplicates = await repo.find({ where: { canonical_ticket_id: canonical.id, status: Not('done') } });
    for (const duplicate of duplicates) {
      const prev = duplicate.status;
      const claimed = await repo.update({ id: duplicate.id, status: prev }, {
        status: 'done',
        terminal_entered_at: canonical.terminal_entered_at || new Date(),
        pending_user_action: false,
        pending_on_tickets: false,
        pending_ci_wait: false,
        ci_wait_context: '',
        operational_dedupe_key: null,
        supervisor_redispatches: 0,
      });
      if (!claimed.affected) continue;
      const decisions = this.dataSource.getRepository(TicketDuplicateDecision);
      await decisions.save(decisions.create({
        account_id: duplicate.account_id,
        report_ticket_id: duplicate.id,
        candidate_ticket_id: canonical.id,
        outcome: 'resolved_from_canonical',
        confidence: 100,
        matched_signals: JSON.stringify(['canonical_done']),
        actor_id: '',
        actor_name: 'Canonical resolution',
      }));
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: duplicate.id, ticket_id: duplicate.id, account_id: duplicate.account_id,
        action: 'moved', field_changed: 'resolved_from_canonical', old_value: prev, new_value: 'done',
        actor_id: 'system', actor_name: 'Canonical resolution',
      });
    }
  }

  // ── queue ─────────────────────────────────────────────────────────────

  private async pump(filter: { accountId?: string; assigneeKey?: string }): Promise<number> {
    if (await this.instanceQuiesce.isQuiesced()) return 0;
    const repo = this.dataSource.getRepository(Ticket);
    const where: any = {
      status: 'todo', archived_at: IsNull(), parent_id: IsNull(), canonical_ticket_id: IsNull(),
      pending_user_action: false, pending_on_tickets: false, pending_ci_wait: false,
      assignee_key: filter.assigneeKey ? filter.assigneeKey : Not(''),
    };
    if (filter.accountId) where.account_id = filter.accountId;
    const queued = await repo.find({ where, take: 500 });
    if (queued.length === 0) return 0;
    queued.sort((a, b) =>
      priorityIndex(a.priority) - priorityIndex(b.priority)
      || a.position - b.position
      || new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    const accounts = await this.accountsById([...new Set(queued.map((t) => t.account_id).filter(Boolean))]);
    const running = await this.runningCounts([...new Set(queued.map((t) => t.assignee_key))]);
    let started = 0;
    for (const ticket of queued) {
      const ws = accounts.get(ticket.account_id);
      if (!ws || ws.dispatch_paused_at) continue;
      const cap = Math.max(1, ws.max_concurrent_tickets_per_agent || 1);
      const inFlight = running.get(ticket.assignee_key) ?? 0;
      if (inFlight >= cap) continue;
      const spec = parseRuntimeSpec(ticket.assignee);
      if (!spec) continue;
      if (!this.isHostReachable(spec)) {
        await this.noteOffline(ticket, spec);
        continue;
      }
      // Atomic claim — only one pump wins a ticket even across processes.
      const claim = await repo.update({ id: ticket.id, status: 'todo' }, { status: 'in_progress' });
      if (!claim.affected) continue;
      running.set(ticket.assignee_key, inFlight + 1);
      ticket.status = 'in_progress';
      await this.activityService.logActivity({
        entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id,
        action: 'moved', field_changed: 'status', old_value: 'todo', new_value: 'in_progress',
        actor_name: 'AWB', trigger_source: 'start',
      });
      const result = await this.dispatch(ticket, 'start');
      if (result.dispatched) started += 1;
    }
    return started;
  }

  /** Non-pending, non-archived in_progress tickets per assignee identity (all accounts). */
  private async runningCounts(keys: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (keys.length === 0) return out;
    const rows = await this.dataSource.getRepository(Ticket).find({
      select: ['id', 'assignee_key'],
      where: {
        status: 'in_progress', archived_at: IsNull(), parent_id: IsNull(), assignee_key: In(keys),
        pending_user_action: false, pending_on_tickets: false, pending_ci_wait: false,
      },
    });
    for (const row of rows) out.set(row.assignee_key, (out.get(row.assignee_key) ?? 0) + 1);
    return out;
  }

  private async accountsById(ids: string[]): Promise<Map<string, Account>> {
    if (ids.length === 0) return new Map();
    const rows = await this.dataSource.getRepository(Account).find({ where: { id: In(ids) } });
    return new Map(rows.map((w) => [w.id, w]));
  }

  /** Human-readable reason a todo ticket did not start — surfaced by the Run button. */
  private async blockReason(ticket: Ticket): Promise<string> {
    if (isTicketPending(ticket)) return 'pending';
    if (ticket.archived_at) return 'archived';
    if (ticket.canonical_ticket_id) return 'duplicate';
    const ws = await this.dataSource.getRepository(Account).findOne({ where: { id: ticket.account_id } });
    if (ws?.dispatch_paused_at) return 'workspace_paused';
    const spec = parseRuntimeSpec(ticket.assignee);
    if (!spec) return 'unassigned';
    if (!this.isHostReachable(spec)) return 'host_offline';
    const cap = Math.max(1, ws?.max_concurrent_tickets_per_agent || 1);
    const inFlight = (await this.runningCounts([ticket.assignee_key])).get(ticket.assignee_key) ?? 0;
    if (inFlight >= cap) return 'agent_busy';
    return 'queued';
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  async dispatch(ticket: Ticket, source: DispatchSource, opts: { forceRespawn?: boolean } = {}): Promise<DispatchResult> {
    if (ticket.archived_at) return { dispatched: false, reason: 'archived' };
    if (isTicketPending(ticket)) return { dispatched: false, reason: 'pending' };
    // A confirmed duplicate is worked through its canonical ticket.
    if (ticket.canonical_ticket_id) return { dispatched: false, reason: 'duplicate' };
    if (ticket.status !== 'in_progress' && ticket.status !== 'todo') return { dispatched: false, reason: `status_${ticket.status}` };
    const spec = parseRuntimeSpec(ticket.assignee);
    if (!spec) return { dispatched: false, reason: 'unassigned' };
    const ws = await this.dataSource.getRepository(Account).findOne({ where: { id: ticket.account_id } });
    if (!ws) return { dispatched: false, reason: 'workspace_missing' };
    if (ws.dispatch_paused_at) return { dispatched: false, reason: 'workspace_paused' };
    if (await this.instanceQuiesce.isQuiesced()) return { dispatched: false, reason: 'instance_quiesced' };
    if (!this.isHostReachable(spec)) {
      await this.noteOffline(ticket, spec);
      return { dispatched: false, reason: 'host_offline' };
    }

    // Assignee identity의 credential materialization — 팀/미션과 같은 함정:
    // 디스패치만으로는 슬롯 credential 파일이 절대 써지지 않으므로,
    // 프로비저닝된 적 없는 identity는 여기서 best-effort로 확보한다.
    // fire-and-forget: 실패해도 디스패치는 예전대로 진행한다.
    if (this.commands) {
      void this.commands
        .provisionSlotIdentity(spec, {
          accountId: ticket.account_id,
          label: `ticket:${ticket.id.slice(0, 8)}/${(spec as any)?.cli || 'agent'}`,
          issuedBy: 'system:ticket-dispatch',
        })
        .catch(() => undefined);
    }

    let payload: AgentTriggerPayload & Record<string, unknown>;
    try {
      payload = await this.buildPayload(ticket, spec, ws, source, opts.forceRespawn === true);
    } catch (err: any) {
      this.logService.error('Dispatch', 'trigger build failed; not emitted', { err: String(err?.message || err), ticket_id: ticket.id });
      await this.dataSource.getRepository(ActivityLog).save({
        entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id || '',
        action: 'dispatch_failed', field_changed: source, new_value: String(err?.message || err).slice(0, 500),
        role: 'assignee', actor_name: 'AWB', trigger_source: source,
      });
      return { dispatched: false, reason: 'build_failed' };
    }

    // Correlation row first, then the emit: a fast ack must find it.
    await this.dataSource.getRepository(ActivityLog).save({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id || '',
      action: 'trigger_emitted', field_changed: payload.trigger_id, new_value: payload.agent_id,
      role: 'assignee', actor_name: 'AWB', trigger_source: source,
    });
    activityEvents.emit('agent_trigger', { ...payload, timestamp: new Date().toISOString() });
    await this.dataSource.getRepository(Ticket).update({ id: ticket.id }, { last_dispatched_at: new Date() });
    this.logService.info('Dispatch', `agent_trigger ticket=${ticket.id.slice(0, 8)} source=${source} agent=${payload.agent_id}`, {
      ticket_id: ticket.id, trigger_id: payload.trigger_id, source,
    });
    return { dispatched: true, trigger_id: payload.trigger_id };
  }

  private async buildPayload(
    ticket: Ticket,
    spec: RuntimeSpec,
    ws: Account,
    source: DispatchSource,
    forceRespawn: boolean,
  ): Promise<AgentTriggerPayload & Record<string, unknown>> {
    const agentId = runtimeIdentityKey(spec);
    const status = (ticket.status === 'todo' ? 'in_progress' : ticket.status) as TicketStatus;
    const project = ticket.project_id ? await this.projects.getInWorkspace(ticket.project_id, ticket.account_id) : null;
    const mainCloneDir = project ? await this.projects.hostFolder(project.id, spec.manager_agent_id) : null;
    const baseBranch = ticket.base_branch || '';

    const workOrder = renderTicketWorkOrder({
      base_branch: baseBranch,
      project: project
        ? {
            name: project.name,
            repo_url: project.repo_url,
            default_branch: project.default_branch,
            use_pr: !!project.use_pr,
            instructions: project.instructions || '',
            main_clone_dir: mainCloneDir,
          }
        : null,
    });

    const harness = appendBoardLanguageInstruction(parseHarnessConfig(ws.harness_config), ws.language);
    const wsEnv = parseEnvironmentConfig(ws.environment_config);
    // Repositories come from the ticket's project only — the workspace layer
    // contributes env vars / setup, never an implicit repo.
    const environmentConfig = wsEnv ? resolveEnvironmentConfig({ ...wsEnv, repositories: [] }, () => null) : null;

    let runtimeProfile: CliRuntimeProfile | null = null;
    if (cliDescriptor(spec.cli)?.sessions.backend_profile) {
      runtimeProfile = await resolveClaudeBackendProfileForDispatch(this.dataSource, [
        { source: 'agent', value: spec.cli_runtime_profile ?? null },
      ]);
      if (runtimeProfile?.credential_required && runtimeProfile.credential_ref !== (spec.credential_id ?? null)) {
        throw new Error(
          `Claude backend profile "${runtimeProfile.id}" requires credential ${runtimeProfile.credential_ref}; ` +
          'the assignee must select that credential',
        );
      }
    }

    // Skill selection is part of the execution contract — fail closed.
    const snapshot = await this.runSkillSnapshots.resolve({
      accountId: ticket.account_id,
      runId: `ticket:${ticket.id}:assignee`,
      agentId,
    });

    return {
      trigger_id: randomUUID(),
      ticket_id: ticket.id,
      agent_id: agentId,
      runtime: spec,
      account_id: ticket.account_id,
      role: 'assignee',
      role_prompt: spec.role_prompt || '',
      ticket_prompt: ticket.prompt_text || '',
      trigger_source: source,
      status,
      ...statusColumnProjection(status),
      project: this.projects.summary(project),
      column_prompt: { template_id: TICKET_WORK_ORDER_TEMPLATE_ID, name: TICKET_WORK_ORDER_NAME, content: workOrder },
      base_repo: project && project.repo_url
        ? { id: project.id, name: project.name, url: project.repo_url, default_branch: project.default_branch || '', main_clone_dir: mainCloneDir }
        : null,
      base_branch: baseBranch,
      clone_policy: project ? resolveClonePolicy(project.clone_policy, ws.clone_policy) : null,
      force_respawn: forceRespawn,
      max_concurrent_tickets_per_agent: Math.max(1, ws.max_concurrent_tickets_per_agent || 1),
      skill_snapshot: { run_id: snapshot.run_id, digest: snapshot.digest, manifest: snapshot.manifest as any },
      harness_config: harness,
      cli_runtime_profile: runtimeProfile,
      effort_preset: null,
      environment_config: environmentConfig,
      worktree_mode: 'per_ticket',
    };
  }

  // ── host presence ─────────────────────────────────────────────────────

  private isHostReachable(spec: RuntimeSpec): boolean {
    const hostId = spec.manager_agent_id;
    if (!hostId) return false;
    if (this.connectivity.isReachable(hostId)) return true;
    return this.instanceRegistry.list().some((i) => i.agent_id === hostId || i.host_id === hostId);
  }

  private async noteOffline(ticket: Ticket, spec: RuntimeSpec): Promise<void> {
    const last = this.offlineNoticeAt.get(ticket.id) ?? 0;
    if (Date.now() - last < OFFLINE_NOTICE_COOLDOWN_MS) return;
    this.offlineNoticeAt.set(ticket.id, Date.now());
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id,
      action: 'dispatch_deferred', field_changed: 'host_offline',
      new_value: `Runtime Host ${spec.manager_agent_id} is offline — the ticket waits until it reconnects.`,
      actor_name: 'AWB',
    });
  }

  // ── sweep (queue backstop + supervisor) ───────────────────────────────

  async sweep(): Promise<void> {
    this.pruneNotes(Date.now());
    await this.startQueued();
    await this.supervise();
  }

  /** Per-ticket notes only matter while they can still change a decision. */
  private pruneNotes(now: number): void {
    for (const [id, at] of this.offlineNoticeAt) {
      if (now - at >= OFFLINE_NOTICE_COOLDOWN_MS) this.offlineNoticeAt.delete(id);
    }
    // A nack retry is consumed by supervise() while the ticket is in_progress;
    // one still here a day later belongs to a ticket that left that state.
    for (const [id, nack] of this.nackRetryAt) {
      if (now - nack.at >= NACK_RETRY_STALE_MS) this.nackRetryAt.delete(id);
    }
  }

  async supervise(now = Date.now()): Promise<void> {
    if (await this.instanceQuiesce.isQuiesced()) return;
    const repo = this.dataSource.getRepository(Ticket);
    const working = await repo.find({
      where: {
        status: 'in_progress', archived_at: IsNull(), parent_id: IsNull(), canonical_ticket_id: IsNull(),
        assignee_key: Not(''), pending_user_action: false, pending_on_tickets: false, pending_ci_wait: false,
      },
      take: 500,
    });
    if (working.length === 0) return;
    const accounts = await this.accountsById([...new Set(working.map((t) => t.account_id).filter(Boolean))]);
    const latestComment = await this.latestCommentAt(working.map((t) => t.id));
    for (const ticket of working) {
      const ws = accounts.get(ticket.account_id);
      if (!ws || ws.dispatch_paused_at) continue;

      const nack = this.nackRetryAt.get(ticket.id);
      if (nack && nack.at <= now) {
        this.nackRetryAt.delete(ticket.id);
        await this.dispatch(ticket, 'nack_retry');
        continue;
      }
      if (nack) continue;

      if (this.agentStatus.hasLiveRoleStrand(ticket.assignee_key, ticket.id, 'assignee')) continue;
      const lastSignal = Math.max(
        ticket.last_dispatched_at ? new Date(ticket.last_dispatched_at).getTime() : 0,
        latestComment.get(ticket.id) ?? 0,
        this.agentStatus.getLatestOutputLivenessForTicket(ticket.id) ?? 0,
      );
      // First re-send after supervisor_stale_ms of silence; each further one
      // after supervisor_resend_ms (the agent already had its long chance).
      const waitMs = ticket.supervisor_redispatches > 0
        ? Math.max(60_000, ws.supervisor_resend_ms || 300_000)
        : Math.max(60_000, ws.supervisor_stale_ms || 1_800_000);
      if (now - lastSignal < waitMs) continue;

      if (ticket.supervisor_redispatches >= MAX_SUPERVISOR_REDISPATCHES) {
        await this.parkStalled(ticket);
        continue;
      }
      await repo.update({ id: ticket.id }, { supervisor_redispatches: ticket.supervisor_redispatches + 1 });
      await this.dispatch(ticket, 'supervisor', { forceRespawn: true });
    }
  }

  private async latestCommentAt(ticketIds: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (ticketIds.length === 0) return out;
    const rows = await this.dataSource.getRepository(Comment)
      .createQueryBuilder('c')
      .select('c.ticket_id', 'ticket_id')
      .addSelect('MAX(c.created_at)', 'last')
      .where('c.ticket_id IN (:...ids)', { ids: ticketIds })
      .groupBy('c.ticket_id')
      .getRawMany();
    for (const row of rows) out.set(row.ticket_id, new Date(row.last).getTime());
    return out;
  }

  /** The agent keeps stopping without finishing — hand the ticket to a human. */
  private async parkStalled(ticket: Ticket): Promise<void> {
    const reason = `The assignee stopped ${MAX_SUPERVISOR_REDISPATCHES} times without finishing or reporting progress. ` +
      'Check the Runtime Host and the agent log, then unpend to retry.';
    await this.dataSource.getRepository(Ticket).update({ id: ticket.id }, {
      pending_user_action: true,
      pending_reason: reason,
      pending_set_at: new Date(),
      pending_set_by: 'AWB',
      supervisor_redispatches: 0,
    });
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, ticket_id: ticket.id, account_id: ticket.account_id,
      action: 'updated', field_changed: 'pending_user_action', old_value: 'false', new_value: 'true',
      actor_name: 'AWB', trigger_source: 'supervisor',
    });
  }

  private async isUser(actorId: string): Promise<boolean> {
    // Agents act under rt- runtime keys; users.id is a uuid column on Postgres.
    if (!isUuidShapedId(actorId)) return false;
    return !!(await this.dataSource.getRepository(User).findOne({ where: { id: actorId }, select: ['id'] }));
  }
}
