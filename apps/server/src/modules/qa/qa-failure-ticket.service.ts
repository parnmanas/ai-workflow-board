import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { QaScenario, QaOnFailureTicketConfig } from '../../entities/QaScenario';
import { QaRun } from '../../entities/QaRun';
import { LogService } from '../../services/log.service';
import { ProjectsService } from '../projects/projects.service';
import { TicketService, normalizeTags, parseTags, type TicketActor } from '../tickets/ticket.service';
import { DONE_STATUS, isDoneStatus } from '../../common/ticket-status';
import { parseRuntimeSpec } from '../../common/runtime-spec';

// Internal traceability tag so per_open_ticket dedupe can find the scenario's
// own open qa-failure ticket without a metadata column on Ticket.
const SCENARIO_TAG_PREFIX = 'qa-scenario:';
// Generation marker for the QA→fix→QA loop (ticket 467dbc7a). A fix ticket born
// from a rerun of generation N carries `qa-rerun:N`; QaRerunOnFixService reads it
// back off the Done ticket to know how many reruns have happened (and to stop at
// max_rerun_attempts). Exported so the rerun hook parses the same prefix.
export const RERUN_TAG_PREFIX = 'qa-rerun:';
const DEFAULT_TAGS = ['qa-failure', 'auto'];
const DEFAULT_PRIORITY = 'high';

// The marker tags that identify a ticket as an AUTO QA-failure fix ticket for
// on-pass sibling auto-close (ticket 64b9cbaf). Mirrors
// QaRerunOnFixService.REQUIRED_TAGS so the SAME class of tickets the rerun hook
// fires on is the class a green run auto-closes — a human ticket that merely
// carries the scenario marker is never touched. (Same documented coupling: a
// scenario that customises cfg.tags and drops 'auto' opts out of both hooks.)
const AUTO_TICKET_MARKER_TAGS = DEFAULT_TAGS;

const QA_ACTOR: TicketActor = { id: '', name: 'QA', type: 'system' };

/**
 * Actor of the on-pass auto-close. Its distinct id is how QaRerunOnFixService
 * recognises that synthetic Done move and stays quiet — auto-closing a
 * `rerun_on_fix` ticket because the scenario already passed must not kick off a
 * fresh (pointless) run of that same scenario.
 */
export const QA_AUTO_CLOSE_ACTOR: TicketActor = { id: 'qa-pass-auto-close', name: 'QA', type: 'system' };

/**
 * QaFailureTicketService — files a fix ticket when a QaRun fails.
 *
 * Called synchronously from QaRunService.completeRun (the single QaRun
 * finalization choke point), NOT via the activity-event indirection
 * OnTicketDoneActionService uses. completeRun is the only place a run reaches a
 * terminal status, so a direct call is both simpler and deterministic (the test
 * can assert the ticket exists right after complete_qa_run returns).
 *
 * The ticket goes through TicketService.create into the run's workspace pool
 * (docs/tickets.md → "QA / Security failure tickets"): tags from the policy,
 * optional project, status `todo` (or `backlog`), and an assignee resolved as
 * `assignee_runtime` → scenario `target_runtime` → the project's
 * default_assignee (TicketService applies that last one when we omit
 * `assignee`).
 *
 * Idempotency is two-layered:
 *   1. run.auto_ticket_id — set once per run; a re-finalize of the SAME run is a
 *      no-op (returns the existing id). This is the run-level guard.
 *   2. dedupe='per_open_ticket' — across DIFFERENT runs of the same scenario,
 *      if an open (not done, not archived) qa-failure ticket already exists,
 *      append a recurrence comment instead of filing a new one.
 *
 * Loop safety: the filed ticket is an ordinary ticket — it never re-triggers
 * QA (QA only runs via start_qa_run). The run guard + dedupe cap any runaway.
 */
@Injectable()
export class QaFailureTicketService {
  // Tickets an on-pass auto-close is moving right now — two runs of the same
  // scenario passing at once must not both close (and comment on) one ticket.
  private readonly _closing = new Set<string>();

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly ticketService: TicketService,
    private readonly projects: ProjectsService,
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
      const accountId = run.account_id || scenario.account_id;
      if (!accountId) {
        this.logService.warn('QA', `on_failure_ticket enabled for scenario ${scenario.id} but run ${run.id} has no workspace — skipping`);
        return null;
      }

      // Scenario-level dedupe is the DEFAULT (ticket 64b9cbaf): a flaky scenario
      // converges to ONE open fix ticket instead of spawning a fresh critical
      // ticket per failed run. Only an explicit `dedupe: 'per_run'` opts back into
      // one-ticket-per-run. run.auto_ticket_id above still no-ops a re-finalize of
      // the SAME run in both modes.
      if ((cfg.dedupe || 'per_open_ticket') === 'per_open_ticket') {
        const existing = await this._findOpenFailureTicket(scenario, accountId);
        if (existing) {
          await this._appendRecurrenceComment(existing, run, scenario);
          await this._stampRunTicket(run.id, existing.id);
          this.logService.info('QA', `on_failure_ticket: recurrence on open ticket ${existing.id} for scenario ${scenario.id} (run ${run.id})`);
          return existing.id;
        }
      }

      const ticketId = await this._createTicket(run, scenario, cfg, accountId);
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
   * QA-failure fix tickets — so a single green run closes EVERY open (not done,
   * non-archived) auto fix ticket for that scenario at once, instead of leaving
   * each duplicate/flaky ticket to individual manual closure. Each is moved to
   * `done` (TicketService.move, so terminal stamp + activity + on-done hooks
   * behave like any other close) with a resolved comment. Returns the ids
   * actually closed (for logging / tests). Never throws — a side-effect failure
   * here must not abort the completeRun finalization that called it.
   *
   * Scope: only tickets carrying ALL of `qa-failure` + `auto` + `qa-scenario:<id>`
   * (AUTO_TICKET_MARKER_TAGS, mirroring QaRerunOnFixService.REQUIRED_TAGS) —
   * a human ticket that merely references the scenario is never auto-closed.
   *
   * Idempotency: an already-done sibling is filtered out up front (re-read right
   * before the move), making a re-finalize of a passed run a no-op; `_closing`
   * keeps two concurrent passes from both closing one ticket.
   *
   * Rerun suppression: the move is made as QA_AUTO_CLOSE_ACTOR, which
   * QaRerunOnFixService ignores — auto-closing a `rerun_on_fix` ticket here does
   * NOT kick off a fresh run off the synthetic Done move.
   */
  async maybeCloseSiblingsOnPass(run: QaRun, scenario: QaScenario): Promise<string[]> {
    const cfg = scenario.on_failure_ticket;
    // Gate on the same opt-in as creation: no policy → the scenario never filed
    // auto tickets, so there is nothing to close.
    if (!cfg?.enabled) return [];

    try {
      const accountId = run.account_id || scenario.account_id;
      if (!accountId) return [];
      const open = await this._findOpenAutoFailureTickets(scenario, accountId);
      if (open.length === 0) return [];

      const closedIds: string[] = [];
      for (const ticket of open) {
        try {
          const closed = await this._closeTicketAsResolved(ticket, run, scenario);
          if (closed) closedIds.push(ticket.id);
        } catch (e: any) {
          // One ticket that cannot move (archived mid-sweep, …) must not keep
          // its siblings open.
          this.logService.warn('QA', `on-pass auto-close: ticket ${ticket.id} not closed (scenario ${scenario.id}): ${e?.message || e}`);
        }
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

  /** Root, non-archived, not-done tickets carrying the scenario marker tag, by creation time. */
  private async _openScenarioTickets(scenario: QaScenario, accountId: string, order: 'ASC' | 'DESC'): Promise<Ticket[]> {
    const marker = `${SCENARIO_TAG_PREFIX}${scenario.id}`;
    // Match the JSON-string tag list (`tags` is a JSON string column). LIKE
    // works identically on SQLite(dev) and Postgres(prod) — no JSON operators.
    return this.dataSource.getRepository(Ticket).createQueryBuilder('t')
      .where('t.account_id = :ws', { ws: accountId })
      .andWhere('t.depth = 0')
      .andWhere('t.archived_at IS NULL')
      .andWhere('t.status <> :done', { done: DONE_STATUS })
      .andWhere('t.tags LIKE :marker', { marker: `%${marker}%` })
      .orderBy('t.created_at', order)
      .getMany();
  }

  private async _findOpenFailureTicket(scenario: QaScenario, accountId: string): Promise<Ticket | null> {
    const rows = await this._openScenarioTickets(scenario, accountId, 'DESC');
    return rows[0] ?? null;
  }

  /**
   * Every OPEN AUTO fix ticket for the scenario. Same `tags LIKE` the dedupe
   * finder uses, PLUS the marker-tag scope guard (AUTO_TICKET_MARKER_TAGS) so
   * only genuine QA-filed fix tickets are eligible for auto-close — a human
   * ticket that merely carries `qa-scenario:<id>` is skipped.
   */
  private async _findOpenAutoFailureTickets(scenario: QaScenario, accountId: string): Promise<Ticket[]> {
    const rows = await this._openScenarioTickets(scenario, accountId, 'ASC');
    return rows.filter((t) => {
      const tags = parseTags(t.tags);
      return AUTO_TICKET_MARKER_TAGS.every((tag) => tags.includes(tag));
    });
  }

  /**
   * Close one open auto fix ticket: move it to `done` as QA_AUTO_CLOSE_ACTOR and
   * post the resolved comment. Re-reads the ticket first so a concurrent close /
   * manual move / archive is not clobbered and only the winner comments. Returns
   * true iff this call closed it.
   */
  private async _closeTicketAsResolved(ticket: Ticket, run: QaRun, scenario: QaScenario): Promise<boolean> {
    if (this._closing.has(ticket.id)) return false;
    this._closing.add(ticket.id);
    try {
      const fresh = await this.dataSource.getRepository(Ticket).findOne({ where: { id: ticket.id } });
      if (!fresh || fresh.archived_at || isDoneStatus(fresh.status)) return false;
      await this.ticketService.move(ticket.id, DONE_STATUS, QA_AUTO_CLOSE_ACTOR);
    } finally {
      this._closing.delete(ticket.id);
    }

    const body = [
      `✅ **QA 시나리오 재통과 — 자동 종결**`,
      ``,
      `시나리오 \`${scenario.name}\` (\`${scenario.id}\`) 의 최신 run \`${run.id}\` 이 통과했습니다.`,
      `이 자동 QA 실패 티켓은 더 이상 유효하지 않아 **Done** 으로 자동 종결되었습니다.`,
      ``,
      `_시나리오 상태를 SSOT 로 삼아, green run 하나가 같은 \`${SCENARIO_TAG_PREFIX}${scenario.id}\` 의 열린 형제 auto 티켓을 함께 닫습니다. 재작업이 필요하면 이 티켓을 다시 열어 진행하세요._`,
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
    return true;
  }

  private async _createTicket(
    run: QaRun,
    scenario: QaScenario,
    cfg: QaOnFailureTicketConfig,
    accountId: string,
  ): Promise<string> {
    // A project id that no longer resolves in this workspace must not swallow
    // the failure report — file it without a project and say so in the log.
    let projectId: string | null = (cfg.project_id || '').trim() || null;
    if (projectId && !(await this.projects.getInWorkspace(projectId, accountId))) {
      this.logService.warn('QA', `on_failure_ticket: project ${projectId} not found in workspace ${accountId} (scenario ${scenario.id}) — filing without a project`);
      projectId = null;
    }
    // assignee_runtime → scenario target_runtime → (omitted) project default_assignee.
    const assignee = parseRuntimeSpec(cfg.assignee_runtime) || parseRuntimeSpec(scenario.target_runtime);

    const { ticket } = await this.ticketService.create(accountId, {
      title: this._buildTitle(cfg, scenario),
      description: await this._buildBody(run, scenario, accountId),
      priority: cfg.priority || DEFAULT_PRIORITY,
      status: cfg.status === 'backlog' ? 'backlog' : 'todo',
      tags: this._buildTags(cfg, scenario.id, run.rerun_generation),
      project_id: projectId,
      ...(assignee ? { assignee } : {}),
    }, QA_ACTOR);
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

  private _buildTags(cfg: QaOnFailureTicketConfig, scenarioId: string, rerunGeneration?: number): string[] {
    // `labels` is the pre-board-removal name of `tags` — still honoured for
    // policies the migration did not rewrite (e.g. written by an older client).
    const configured = normalizeTags(cfg.tags ?? cfg.labels);
    const base = configured.length ? configured : DEFAULT_TAGS.slice();
    const marker = `${SCENARIO_TAG_PREFIX}${scenarioId}`;
    if (!base.includes(marker)) base.push(marker);
    // Carry the generation so QaRerunOnFixService can read it back off this
    // ticket when it reaches Done and decide whether the loop has hit its cap.
    // Generation 0 (the original failure) carries no marker — its absence reads
    // as gen 0, and the first rerun stamps `qa-rerun:1` on its child ticket.
    const gen = rerunGeneration && rerunGeneration > 0 ? Math.floor(rerunGeneration) : 0;
    if (gen > 0) {
      const rerunMarker = `${RERUN_TAG_PREFIX}${gen}`;
      // Replace any stray rerun marker (e.g. from a custom cfg.tags) so exactly
      // one generation marker is present.
      const cleaned = base.filter((t) => !t.startsWith(RERUN_TAG_PREFIX));
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

  private async _buildBody(run: QaRun, scenario: QaScenario, accountId: string): Promise<string> {
    const qaDetailLink = `/qa`;

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
