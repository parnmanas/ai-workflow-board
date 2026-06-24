import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { BoardColumn } from '../../entities/BoardColumn';
import { Resource } from '../../entities/Resource';
import { QaScenario, QaOnFailureTicketConfig } from '../../entities/QaScenario';
import { QaRun } from '../../entities/QaRun';
import { LogService } from '../../services/log.service';
import { ActivityService } from '../../services/activity.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { findColumnByName, maxTicketPosition, resolveAgentIdAndName, refreshTicketWorkspaceId } from '../mcp/shared/ticket-helpers';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';

// Internal traceability label so per_open_ticket dedupe can find the scenario's
// own open qa-failure ticket without a metadata column on Ticket.
const SCENARIO_LABEL_PREFIX = 'qa-scenario:';
const DEFAULT_LABELS = ['qa-failure', 'auto'];
const DEFAULT_COLUMN = 'To Do';
const DEFAULT_PRIORITY = 'high';

/**
 * QaFailureTicketService — files a fix ticket when a QaRun fails.
 *
 * Called synchronously from QaRunService.completeRun (the single QaRun
 * finalization choke point), NOT via the activity-event indirection
 * OnTicketDoneActionService uses. completeRun is the only place a run reaches a
 * terminal status, so a direct call is both simpler and deterministic (the test
 * can assert the ticket exists right after complete_qa_run returns).
 *
 * Idempotency is two-layered:
 *   1. run.auto_ticket_id — set once per run; a re-finalize of the SAME run is a
 *      no-op (returns the existing id). This is the run-level guard.
 *   2. dedupe='per_open_ticket' — across DIFFERENT runs of the same scenario,
 *      if an open (non-terminal, non-archived) qa-failure ticket already exists,
 *      append a recurrence comment instead of filing a new one.
 *
 * Loop safety: the filed ticket is an ordinary ticket — it never re-triggers
 * QA (QA only runs via start_qa_run). The run guard + dedupe cap any runaway.
 */
@Injectable()
export class QaFailureTicketService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
  ) {}

  /**
   * If the scenario opts in and this run hasn't already filed, create (or, for
   * per_open_ticket dedupe, reuse) the fix ticket. Returns the ticket id, or
   * null when nothing was created. Never throws — a failure here must not block
   * the QaRun finalization that called it.
   */
  async maybeCreateOnFailure(run: QaRun, scenario: QaScenario): Promise<string | null> {
    const cfg = scenario.on_failure_ticket;
    if (!cfg?.enabled) return null;
    // Run-level idempotency: this run already filed (or reused) a ticket.
    if (run.auto_ticket_id) return run.auto_ticket_id;

    try {
      const boardId = cfg.board_id || run.board_id || scenario.board_id || '';
      if (!boardId) {
        this.logService.warn('QA', `on_failure_ticket enabled for scenario ${scenario.id} but no board_id resolvable (cfg/run/scenario all empty) — skipping`);
        return null;
      }

      const column = await this._resolveColumn(boardId, cfg.column_name || DEFAULT_COLUMN);
      if (!column) {
        this.logService.warn('QA', `on_failure_ticket: no usable column in board ${boardId} for scenario ${scenario.id} — skipping`);
        return null;
      }

      // per_open_ticket: reuse an existing open ticket if present.
      if ((cfg.dedupe || 'per_run') === 'per_open_ticket') {
        const existing = await this._findOpenFailureTicket(scenario, run.workspace_id);
        if (existing) {
          await this._appendRecurrenceComment(existing, run, scenario);
          await this._stampRunTicket(run.id, existing.id);
          this.logService.info('QA', `on_failure_ticket: recurrence on open ticket ${existing.id} for scenario ${scenario.id} (run ${run.id})`);
          return existing.id;
        }
      }

      const ticketId = await this._createTicket(run, scenario, cfg, column);
      await this._stampRunTicket(run.id, ticketId);
      this.logService.info('QA', `on_failure_ticket: filed ticket ${ticketId} for failed run ${run.id} (scenario ${scenario.id})`);
      return ticketId;
    } catch (e: any) {
      // Never let a side-effect failure abort run finalization.
      this.logService.error('QA', `on_failure_ticket failed for run ${run.id}: ${e?.message || e}`);
      return null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** "To Do" (or configured) column → first non-terminal → first column. */
  private async _resolveColumn(boardId: string, columnName: string): Promise<BoardColumn | null> {
    const byName = await findColumnByName(this.dataSource, boardId, columnName);
    if (byName) return byName;
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    if (cols.length === 0) return null;
    return cols.find((c) => !isTerminalColumn(c)) || cols[0];
  }

  private async _findOpenFailureTicket(scenario: QaScenario, workspaceId: string): Promise<Ticket | null> {
    const marker = `${SCENARIO_LABEL_PREFIX}${scenario.id}`;
    // Match the JSON-string label list (`labels` is a JSON string column). LIKE
    // works identically on SQLite(dev) and Postgres(prod) — no JSON operators.
    const rows = await this.dataSource.getRepository(Ticket).createQueryBuilder('t')
      .where('t.workspace_id = :ws', { ws: workspaceId })
      .andWhere('t.depth = 0')
      .andWhere('t.archived_at IS NULL')
      .andWhere('t.labels LIKE :marker', { marker: `%${marker}%` })
      .orderBy('t.created_at', 'DESC')
      .getMany();
    if (rows.length === 0) return null;
    // Only count a ticket "open" while it sits in a non-terminal column.
    const colRepo = this.dataSource.getRepository(BoardColumn);
    for (const t of rows) {
      if (!t.column_id) continue;
      const col = await colRepo.findOne({ where: { id: t.column_id } });
      if (col && !isTerminalColumn(col)) return t;
    }
    return null;
  }

  private async _createTicket(
    run: QaRun,
    scenario: QaScenario,
    cfg: QaOnFailureTicketConfig,
    column: BoardColumn,
  ): Promise<string> {
    const workspaceId = scenario.workspace_id;
    const assigneeId = cfg.assignee_id || scenario.target_agent_id || '';
    const resolved = await resolveAgentIdAndName(this.dataSource, assigneeId, '', this.logService);

    const labels = this._buildLabels(cfg, scenario.id);
    const title = this._buildTitle(cfg, scenario);
    const description = await this._buildBody(run, scenario, column.board_id);
    const priority = cfg.priority || DEFAULT_PRIORITY;

    const ticket = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, column.id);
      return tRepo.save(tRepo.create({
        column_id: column.id,
        title,
        description,
        priority,
        assignee: resolved.name,
        reporter: resolved.name,
        assignee_id: resolved.id || assigneeId,
        reporter_id: resolved.id || assigneeId,
        reviewer_id: resolved.id || assigneeId,
        labels: JSON.stringify(labels),
        channel_ids: '[]',
        position,
        // To Do is non-terminal; never stamp terminal_entered_at here.
        created_by: 'QA',
        created_by_type: 'system',
        created_by_id: '',
      }));
    });

    // Backfill workspace_id (column → board) then mirror the role trio onto
    // TicketRoleAssignment so the trigger loop / focus selector see the ticket
    // and the assignee loop actually dispatches.
    await refreshTicketWorkspaceId(this.dataSource, ticket);
    const wsId = ticket.workspace_id || workspaceId;
    if (wsId && (resolved.id || assigneeId)) {
      const holderId = resolved.id || assigneeId;
      await this.roleAssignmentService.syncBuiltinTrio(ticket.id, wsId, {
        assignee_id: holderId,
        reporter_id: holderId,
        reviewer_id: holderId,
      });
    }

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'created',
      ticket_id: ticket.id,
      actor_name: 'QA',
    });

    return ticket.id;
  }

  private async _appendRecurrenceComment(ticket: Ticket, run: QaRun, scenario: QaScenario): Promise<void> {
    const stepLines = this._failedStepLines(run);
    const body = [
      `🔁 **QA 재실패** — 같은 시나리오가 다시 실패했습니다 (per_open_ticket dedupe).`,
      ``,
      `- **Run:** \`${run.id}\` (status: ${run.status})`,
      run.summary ? `- **요약:** ${run.summary}` : null,
      stepLines.length ? `\n**실패 스텝:**\n${stepLines.join('\n')}` : null,
    ].filter(Boolean).join('\n');
    const commentRepo = this.dataSource.getRepository(Comment);
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id,
      author_type: 'system',
      author_id: '',
      author: 'QA',
      content: body,
      type: 'note',
    }));
  }

  private async _stampRunTicket(runId: string, ticketId: string): Promise<void> {
    await this.dataSource.getRepository(QaRun).update({ id: runId }, { auto_ticket_id: ticketId });
  }

  private _buildLabels(cfg: QaOnFailureTicketConfig, scenarioId: string): string[] {
    const base = cfg.labels && cfg.labels.length ? cfg.labels.slice() : DEFAULT_LABELS.slice();
    const marker = `${SCENARIO_LABEL_PREFIX}${scenarioId}`;
    if (!base.includes(marker)) base.push(marker);
    return base;
  }

  private _buildTitle(cfg: QaOnFailureTicketConfig, scenario: QaScenario): string {
    const tpl = cfg.title_template && cfg.title_template.trim() ? cfg.title_template : 'QA 실패: {{scenario.name}}';
    return tpl.replace(/\{\{\s*scenario\.name\s*\}\}/g, scenario.name);
  }

  /** Lines describing each failed/errored step (idx / action / expect / log). */
  private _failedStepLines(run: QaRun): string[] {
    const steps = Array.isArray(run.step_results) ? run.step_results : [];
    const failed = steps.filter((s) => s.status === 'failed');
    // QaStepResult carries no `action`/`expect` text (those live on the
    // scenario step); the recorded `log` is the per-step evidence.
    return failed.map((s) => {
      const parts = [`- **[#${s.idx}]** failed`];
      if (s.log) parts.push(`  - 로그: ${s.log}`);
      return parts.join('\n');
    });
  }

  private async _buildBody(run: QaRun, scenario: QaScenario, boardId: string): Promise<string> {
    const wsId = scenario.workspace_id;
    const qaDetailLink = `/ws/${wsId}/boards/${boardId}/qa`;

    // Pair each failed step result with its scenario step definition so the
    // body shows the action/expect a debugger needs (step_results store only
    // idx/status/log).
    const scenarioSteps = Array.isArray(scenario.steps) ? scenario.steps : [];
    const stepDef = (idx: number) => scenarioSteps.find((s) => s.idx === idx);
    const results = Array.isArray(run.step_results) ? run.step_results : [];
    const failed = results.filter((s) => s.status === 'failed');

    const stepBlock = failed.length
      ? failed.map((s) => {
          const def = stepDef(s.idx);
          const lines = [`- **[#${s.idx}] ${def?.action ?? '(스텝 정의 없음)'}**`];
          if (def?.expect) lines.push(`  - 기대: ${def.expect}`);
          if (s.log) lines.push(`  - 로그: ${s.log}`);
          return lines.join('\n');
        }).join('\n')
      : '_failed 상태로 기록된 개별 스텝 없음 (run-level 실패/error). step_results 전체를 확인하세요._';

    const artifactBlock = await this._artifactLinks(run);

    return [
      `> 🤖 이 티켓은 QA 실패로 자동 생성되었습니다.`,
      ``,
      `## QA 실패 리포트`,
      ``,
      `- **시나리오:** ${scenario.name} (\`${scenario.id}\`)`,
      `- **Run:** \`${run.id}\` — status \`${run.status}\``,
      `- **드라이버:** ${scenario.qa_driver || '(미지정)'}`,
      `- **QA 상세:** ${qaDetailLink}`,
      ``,
      `### 실패한 스텝`,
      stepBlock,
      ``,
      `### Run 요약`,
      run.summary ? run.summary : '_(요약 없음)_',
      ``,
      `### 증거 (스크린샷 / 영상 / 덤프)`,
      artifactBlock,
      ``,
      `---`,
      `_재현: QA 시나리오 \`${scenario.id}\` 를 다시 실행하거나 위 상세 링크에서 run \`${run.id}\` 의 per-step 갤러리를 확인하세요._`,
    ].join('\n');
  }

  /** Markdown links to every artifact Resource on the run (raw stream URLs). */
  private async _artifactLinks(run: QaRun): Promise<string> {
    const ids = Array.isArray(run.artifact_resource_ids) ? run.artifact_resource_ids.filter(Boolean) : [];
    if (ids.length === 0) return '_(첨부 증거 없음)_';
    const resRepo = this.dataSource.getRepository(Resource);
    const lines: string[] = [];
    for (const id of ids) {
      const r = await resRepo.findOne({ where: { id } }).catch(() => null);
      const label = r ? `${r.name || r.file_name || id}${r.file_mimetype ? ` (${r.file_mimetype})` : ''}` : id;
      lines.push(`- [${label}](/api/resources/${id}/raw)`);
    }
    return lines.join('\n');
  }
}
