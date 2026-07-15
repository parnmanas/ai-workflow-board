import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Resource } from '../../entities/Resource';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
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
// Generation marker for the QA→fix→QA loop (ticket 467dbc7a). A fix ticket born
// from a rerun of generation N carries `qa-rerun:N`; QaRerunOnFixService reads it
// back off the Done ticket to know how many reruns have happened (and to stop at
// max_rerun_attempts). Exported so the rerun hook parses the same prefix.
export const RERUN_LABEL_PREFIX = 'qa-rerun:';
const DEFAULT_LABELS = ['qa-failure', 'auto'];
const DEFAULT_PRIORITY = 'high';

// The marker labels that identify a ticket as an AUTO QA-failure fix ticket for
// on-pass sibling auto-close (ticket 64b9cbaf). Mirrors
// QaRerunOnFixService.REQUIRED_LABELS so the SAME class of tickets the rerun hook
// fires on is the class a green run auto-closes — a human ticket that merely
// carries the scenario marker is never touched. (Same documented coupling: a
// scenario that customises cfg.labels and drops 'auto' opts out of both hooks.)
const AUTO_TICKET_MARKER_LABELS = DEFAULT_LABELS;

/** Parse a Ticket.labels JSON string into a string[]; [] on any malformed value. */
function parseLabels(raw: string | null | undefined): string[] {
  try {
    const v = JSON.parse(raw || '[]');
    return Array.isArray(v) ? v.filter((l): l is string => typeof l === 'string') : [];
  } catch {
    return [];
  }
}

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

      const column = await this._resolveColumn(boardId, cfg.column_id, cfg.column_name);
      if (!column) {
        this.logService.warn('QA', `on_failure_ticket: no usable column in board ${boardId} for scenario ${scenario.id} — skipping`);
        return null;
      }

      // Scenario-level dedupe is the DEFAULT (ticket 64b9cbaf): a flaky scenario
      // converges to ONE open fix ticket instead of spawning a fresh critical
      // ticket per failed run. Only an explicit `dedupe: 'per_run'` opts back into
      // one-ticket-per-run. run.auto_ticket_id above still no-ops a re-finalize of
      // the SAME run in both modes.
      if ((cfg.dedupe || 'per_open_ticket') === 'per_open_ticket') {
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

  /**
   * On-pass sibling auto-close (ticket 64b9cbaf). When a scenario's run finalizes
   * as `passed`, the scenario state is the SSOT that resolves the scenario's open
   * QA-failure fix tickets — so a single green run closes EVERY open (non-terminal,
   * non-archived) auto fix ticket for that scenario at once, instead of leaving
   * each duplicate/flaky ticket to individual manual closure. Each is moved to its
   * board's terminal column with a resolved comment. Returns the ids actually
   * closed (for logging / tests). Never throws — a side-effect failure here must
   * not abort the completeRun finalization that called it.
   *
   * Scope: only tickets carrying ALL of `qa-failure` + `auto` + `qa-scenario:<id>`
   * (AUTO_TICKET_MARKER_LABELS, mirroring QaRerunOnFixService.REQUIRED_LABELS) —
   * a human ticket that merely references the scenario is never auto-closed.
   *
   * Idempotency / concurrency: each close is an atomic conditional UPDATE guarded
   * on the ticket STILL sitting in the (non-terminal) column we read it from, so a
   * re-finalize of the same run, a duplicate pass, or two scenario runs passing at
   * once can neither double-close nor double-comment; an already-terminal sibling
   * is filtered out up front, making a re-finalize of a passed run a no-op.
   *
   * Rerun suppression: the close stamps qa_rerun_dispatched_at == terminal_entered_at,
   * so QaRerunOnFixService's edge-claim (qa_rerun_dispatched_at < terminal_entered_at)
   * can't fire — auto-closing a `rerun_on_fix` ticket here does NOT kick off a
   * fresh (pointless) run off the synthetic Done move.
   */
  async maybeCloseSiblingsOnPass(run: QaRun, scenario: QaScenario): Promise<string[]> {
    const cfg = scenario.on_failure_ticket;
    // Gate on the same opt-in as creation: no policy → the scenario never filed
    // auto tickets, so there is nothing to close (and we don't touch a board that
    // opted out of QA automation).
    if (!cfg?.enabled) return [];

    try {
      const open = await this._findOpenAutoFailureTickets(scenario, run.workspace_id);
      if (open.length === 0) return [];

      const closedIds: string[] = [];
      for (const { ticket, column } of open) {
        const done = await this._resolveDoneColumn(column.board_id);
        if (!done) {
          this.logService.warn(
            'QA',
            `on-pass auto-close: board ${column.board_id} has no terminal column — cannot close ticket ${ticket.id} (scenario ${scenario.id})`,
          );
          continue;
        }
        const closed = await this._closeTicketAsResolved(ticket, column, done, run, scenario);
        if (closed) closedIds.push(ticket.id);
      }

      if (closedIds.length) {
        this.logService.info(
          'QA',
          `on-pass auto-close: scenario ${scenario.id} passed (run ${run.id}) → closed ${closedIds.length} sibling fix ticket(s): ${closedIds.join(', ')}`,
        );
      }
      return closedIds;
    } catch (e: any) {
      // Never let a side-effect failure abort run finalization.
      this.logService.error('QA', `on-pass auto-close failed for run ${run.id} (scenario ${scenario.id}): ${e?.message || e}`);
      return [];
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  /** Explicit column id/name → first active non-terminal → first non-terminal. */
  private async _resolveColumn(boardId: string, columnId?: string, columnName?: string): Promise<BoardColumn | null> {
    if (columnId) {
      const byId = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: columnId, board_id: boardId } });
      if (byId) return byId;
    }
    if (columnName) {
      const byName = await findColumnByName(this.dataSource, boardId, columnName);
      if (byName) return byName;
    }
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    if (cols.length === 0) return null;
    return cols.find((c) => c.kind === 'active' && !isTerminalColumn(c))
      || cols.find((c) => !isTerminalColumn(c))
      || cols[0];
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

  /**
   * Every OPEN (non-terminal, non-archived) AUTO fix ticket for the scenario,
   * paired with its current column. Same JSON-string `labels LIKE` the dedupe
   * finder uses, PLUS the marker-label scope guard (AUTO_TICKET_MARKER_LABELS) so
   * only genuine QA-filed fix tickets are eligible for auto-close — a human ticket
   * that merely carries `qa-scenario:<id>` is skipped.
   */
  private async _findOpenAutoFailureTickets(
    scenario: QaScenario,
    workspaceId: string,
  ): Promise<Array<{ ticket: Ticket; column: BoardColumn }>> {
    const marker = `${SCENARIO_LABEL_PREFIX}${scenario.id}`;
    const rows = await this.dataSource.getRepository(Ticket).createQueryBuilder('t')
      .where('t.workspace_id = :ws', { ws: workspaceId })
      .andWhere('t.depth = 0')
      .andWhere('t.archived_at IS NULL')
      .andWhere('t.labels LIKE :marker', { marker: `%${marker}%` })
      .orderBy('t.created_at', 'ASC')
      .getMany();
    if (rows.length === 0) return [];
    const colRepo = this.dataSource.getRepository(BoardColumn);
    const out: Array<{ ticket: Ticket; column: BoardColumn }> = [];
    for (const t of rows) {
      if (!t.column_id) continue;
      // Scope guard: only auto QA-failure fix tickets (belt-and-suspenders vs the
      // scenario marker already matched by the LIKE above).
      const labels = parseLabels(t.labels);
      if (!AUTO_TICKET_MARKER_LABELS.every((l) => labels.includes(l))) continue;
      const col = await colRepo.findOne({ where: { id: t.column_id } });
      if (col && !isTerminalColumn(col)) out.push({ ticket: t, column: col });
    }
    return out;
  }

  /** First terminal column of the board (lowest position), or null if none. */
  private async _resolveDoneColumn(boardId: string): Promise<BoardColumn | null> {
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    return cols.find((c) => isTerminalColumn(c)) || null;
  }

  /**
   * Atomically close one open auto fix ticket: move it to `doneCol`, stamp the
   * terminal entry, and — critically — stamp qa_rerun_dispatched_at to the SAME
   * instant so the QaRerunOnFixService edge-claim can't fire off this synthetic
   * Done move. The UPDATE is guarded on the ticket still sitting in `fromCol` so a
   * concurrent close / manual move can't be clobbered and only the winner posts
   * the resolved comment + `moved` activity. Returns true iff this call claimed
   * the close.
   */
  private async _closeTicketAsResolved(
    ticket: Ticket,
    fromCol: BoardColumn,
    doneCol: BoardColumn,
    run: QaRun,
    scenario: QaScenario,
  ): Promise<boolean> {
    const closeAt = new Date();
    const claim = await this.dataSource.getRepository(Ticket)
      .createQueryBuilder()
      .update(Ticket)
      .set({ column_id: doneCol.id, terminal_entered_at: closeAt, qa_rerun_dispatched_at: closeAt })
      .where('id = :id', { id: ticket.id })
      .andWhere('column_id = :from', { from: fromCol.id })
      .andWhere('archived_at IS NULL')
      .execute();
    const claimed = claim.affected === undefined || claim.affected === null || claim.affected > 0;
    if (!claimed) return false;

    const body = [
      `✅ **QA 시나리오 재통과 — 자동 종결**`,
      ``,
      `시나리오 \`${scenario.name}\` (\`${scenario.id}\`) 의 최신 run \`${run.id}\` 이 통과했습니다.`,
      `이 자동 QA 실패 티켓은 더 이상 유효하지 않아 **${doneCol.name}** 로 자동 종결되었습니다.`,
      ``,
      `_시나리오 상태를 SSOT 로 삼아, green run 하나가 같은 \`${SCENARIO_LABEL_PREFIX}${scenario.id}\` 의 열린 형제 auto 티켓을 함께 닫습니다. 재작업이 필요하면 이 티켓을 다시 열어 진행하세요._`,
    ].join('\n');
    const commentRepo = this.dataSource.getRepository(Comment);
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id,
      author_type: 'system',
      author_id: '',
      author: 'QA',
      content: body,
      type: 'note',
    }));

    // Emit the same `moved` activity the production move path emits so the board
    // live-updates. The rerun re-trigger this would normally invite is already
    // defused by the qa_rerun_dispatched_at stamp set above.
    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'moved',
      field_changed: 'column',
      old_value: fromCol.name,
      new_value: doneCol.name,
      ticket_id: ticket.id,
      actor_name: 'QA',
    });
    return true;
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

    const labels = this._buildLabels(cfg, scenario.id, run.rerun_generation);
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

    // Board default role holders (ticket d94a1b87): fill any role still VACANT
    // after the explicit trio above from the board's default_role_assignments.
    // When the scenario names no assignee the trio sync is skipped, so this is
    // what lets a board-configured default pick the auto-ticket up (and fills a
    // default reviewer even when an assignee IS set — the "no default reviewer
    // → pend" gap). Only ever fills vacant roles; never clobbers an explicit one.
    if (wsId) {
      try {
        const defBoard = await this.dataSource.getRepository(Board).findOne({ where: { id: column.board_id } });
        const defaults = parseDefaultRoleAssignments(defBoard?.default_role_assignments);
        if (Object.keys(defaults).length > 0) {
          await this.roleAssignmentService.applyBoardDefaults(ticket.id, wsId, defaults);
        }
      } catch { /* non-fatal — degrade to "no defaults" */ }
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
    // Running fail count = every failed run that funnelled into this ticket. Each
    // such run stamps QaRun.auto_ticket_id to it (the creating run included), and
    // THIS run isn't stamped yet at comment time, so prior count + 1 is the total.
    const priorFailures = await this.dataSource.getRepository(QaRun).count({ where: { auto_ticket_id: ticket.id } });
    const failNumber = priorFailures + 1;
    const stepLines = this._failedStepLines(run);
    const body = [
      `🔁 **QA 재실패 (누적 ${failNumber}회)** — 같은 시나리오(\`${scenario.id}\`)가 다시 실패했습니다 (scenario-dedupe: 이 티켓 하나로 수렴).`,
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

  private _buildLabels(cfg: QaOnFailureTicketConfig, scenarioId: string, rerunGeneration?: number): string[] {
    const base = cfg.labels && cfg.labels.length ? cfg.labels.slice() : DEFAULT_LABELS.slice();
    const marker = `${SCENARIO_LABEL_PREFIX}${scenarioId}`;
    if (!base.includes(marker)) base.push(marker);
    // Carry the generation so QaRerunOnFixService can read it back off this
    // ticket when it reaches Done and decide whether the loop has hit its cap.
    // Generation 0 (the original failure) carries no marker — its absence reads
    // as gen 0, and the first rerun stamps `qa-rerun:1` on its child ticket.
    const gen = rerunGeneration && rerunGeneration > 0 ? Math.floor(rerunGeneration) : 0;
    if (gen > 0) {
      const rerunMarker = `${RERUN_LABEL_PREFIX}${gen}`;
      // Replace any stray rerun marker (e.g. from a custom cfg.labels) so exactly
      // one generation marker is present.
      const cleaned = base.filter((l) => !l.startsWith(RERUN_LABEL_PREFIX));
      cleaned.push(rerunMarker);
      return cleaned;
    }
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
