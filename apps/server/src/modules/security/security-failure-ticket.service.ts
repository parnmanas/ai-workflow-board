import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Resource } from '../../entities/Resource';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { SecurityProfile, SecurityOnFailureTicketConfig, SecuritySeverity } from '../../entities/SecurityProfile';
import { SecurityRun, SecurityFinding } from '../../entities/SecurityRun';
import { LogService } from '../../services/log.service';
import { ActivityService } from '../../services/activity.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { findColumnByName, maxTicketPosition, resolveAgentIdAndName, refreshTicketWorkspaceId } from '../mcp/shared/ticket-helpers';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';

// Internal traceability label so per_open_ticket dedupe can find the profile's
// own open security ticket without a metadata column on Ticket. Homologous to
// QA's `qa-scenario:<id>` back-ref.
const PROFILE_LABEL_PREFIX = 'security-profile:';
const DEFAULT_LABELS = ['security', 'auto'];
const DEFAULT_PRIORITY = 'high';
const DEFAULT_MIN_SEVERITY: SecuritySeverity = 'high';

// Severity rank for the min_severity gate: higher = more severe.
const SEVERITY_RANK: Record<SecuritySeverity, number> = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

/**
 * SecurityFailureTicketService — files a fix ticket when a SecurityRun finishes
 * failed/error AND carries a finding at or above the profile's `min_severity`
 * gate (default 'high'). Sibling of QaFailureTicketService, plus severity
 * gating: a failed run whose worst finding is below the gate (medium/low/info)
 * leaves only the run summary — no ticket.
 *
 * Called synchronously from SecurityRunService.completeRun (the single
 * SecurityRun finalization choke point). Because that is the only place a run
 * reaches a terminal status from agent completion, a direct call is both simpler
 * and deterministic (the test can assert the ticket exists right after
 * complete_security_run returns).
 *
 * Idempotency is two-layered (same shape as QA):
 *   1. run.auto_ticket_id — set once per run; a re-finalize of the SAME run is a
 *      no-op (returns the existing id). This is the run-level guard.
 *   2. dedupe='per_open_ticket' — across DIFFERENT runs of the same profile, if
 *      an open (non-terminal, non-archived) security ticket already exists,
 *      append a recurrence comment instead of filing a new one.
 *
 * Loop safety: the filed ticket is an ordinary ticket — it never re-triggers a
 * security run (runs only start via start_security_run). The run guard + dedupe
 * cap any runaway. (A "re-inspect on fix" loop, the security analogue of the QA
 * rerun loop, is intentionally out of scope here.)
 */
@Injectable()
export class SecurityFailureTicketService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
  ) {}

  /**
   * If the profile opts in, the run failed/errored, and a finding meets the
   * severity gate, create (or, for per_open_ticket dedupe, reuse) the fix
   * ticket. Returns the ticket id, or null when nothing was created. Never
   * throws — a failure here must not block the SecurityRun finalization that
   * called it.
   */
  async maybeCreateOnFailure(run: SecurityRun, profile: SecurityProfile): Promise<string | null> {
    const cfg = profile.on_failure_ticket;
    if (!cfg?.enabled) return null;
    // Run-level idempotency: this run already filed (or reused) a ticket.
    if (run.auto_ticket_id) return run.auto_ticket_id;

    // Severity gate — only escalate when a finding is at or above min_severity.
    const minSeverity = this._resolveMinSeverity(cfg.min_severity);
    const qualifying = this._qualifyingFindings(run, minSeverity);
    if (qualifying.length === 0) {
      this.logService.info('Security', `on_failure_ticket: run ${run.id} below severity gate (min=${minSeverity}) — no ticket filed (summary only)`);
      return null;
    }

    try {
      const boardId = cfg.board_id || run.board_id || profile.board_id || '';
      if (!boardId) {
        this.logService.warn('Security', `on_failure_ticket enabled for profile ${profile.id} but no board_id resolvable (cfg/run/profile all empty) — skipping`);
        return null;
      }

      const column = await this._resolveColumn(boardId, cfg.column_id, cfg.column_name);
      if (!column) {
        this.logService.warn('Security', `on_failure_ticket: no usable column in board ${boardId} for profile ${profile.id} — skipping`);
        return null;
      }

      // per_open_ticket: reuse an existing open ticket if present.
      if ((cfg.dedupe || 'per_run') === 'per_open_ticket') {
        const existing = await this._findOpenFailureTicket(profile, run.workspace_id);
        if (existing) {
          await this._appendRecurrenceComment(existing, run, profile, qualifying, minSeverity);
          await this._stampRunTicket(run.id, existing.id);
          this.logService.info('Security', `on_failure_ticket: recurrence on open ticket ${existing.id} for profile ${profile.id} (run ${run.id})`);
          return existing.id;
        }
      }

      const ticketId = await this._createTicket(run, profile, cfg, column, qualifying, minSeverity);
      await this._stampRunTicket(run.id, ticketId);
      this.logService.info('Security', `on_failure_ticket: filed ticket ${ticketId} for failed run ${run.id} (profile ${profile.id}, ${qualifying.length} finding(s) >= ${minSeverity})`);
      return ticketId;
    } catch (e: any) {
      // Never let a side-effect failure abort run finalization.
      this.logService.error('Security', `on_failure_ticket failed for run ${run.id}: ${e?.message || e}`);
      return null;
    }
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private _resolveMinSeverity(raw: SecuritySeverity | undefined): SecuritySeverity {
    return raw && raw in SEVERITY_RANK ? raw : DEFAULT_MIN_SEVERITY;
  }

  /** Findings at or above the gate, sorted most-severe first. */
  private _qualifyingFindings(run: SecurityRun, minSeverity: SecuritySeverity): SecurityFinding[] {
    const all = Array.isArray(run.findings) ? run.findings : [];
    const floor = SEVERITY_RANK[minSeverity];
    return all
      .filter((f) => (SEVERITY_RANK[f.severity] ?? 0) >= floor)
      .sort((a, b) => (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0));
  }

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

  private async _findOpenFailureTicket(profile: SecurityProfile, workspaceId: string): Promise<Ticket | null> {
    const marker = `${PROFILE_LABEL_PREFIX}${profile.id}`;
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
    run: SecurityRun,
    profile: SecurityProfile,
    cfg: SecurityOnFailureTicketConfig,
    column: BoardColumn,
    qualifying: SecurityFinding[],
    minSeverity: SecuritySeverity,
  ): Promise<string> {
    const workspaceId = profile.workspace_id;
    const assigneeId = cfg.assignee_id || profile.target_agent_id || '';
    const resolved = await resolveAgentIdAndName(this.dataSource, assigneeId, '', this.logService);

    const labels = this._buildLabels(cfg, profile.id);
    const title = this._buildTitle(cfg, profile, qualifying);
    const description = await this._buildBody(run, profile, column.board_id, qualifying, minSeverity);
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
        created_by: 'Security',
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
    // When the profile names no assignee the trio sync is skipped, so this is
    // what lets a board-configured default pick the auto-ticket up. Only ever
    // fills vacant roles; never clobbers an explicit one.
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
      actor_name: 'Security',
    });

    return ticket.id;
  }

  private async _appendRecurrenceComment(
    ticket: Ticket,
    run: SecurityRun,
    profile: SecurityProfile,
    qualifying: SecurityFinding[],
    minSeverity: SecuritySeverity,
  ): Promise<void> {
    const body = [
      `🔁 **보안 점검 재실패** — 같은 프로파일이 다시 실패했습니다 (per_open_ticket dedupe).`,
      ``,
      `- **Run:** \`${run.id}\` (status: ${run.status})`,
      `- **스코프:** ${run.scope_used}` + this._commitSuffix(run),
      `- **게이트:** \`>= ${minSeverity}\` 충족 finding ${qualifying.length}건 (${this._severityCounts(qualifying)})`,
      run.summary ? `- **요약:** ${run.summary}` : null,
      ``,
      `**게이트 통과 finding:**`,
      this._findingBlock(qualifying),
    ].filter((l) => l !== null).join('\n');
    const commentRepo = this.dataSource.getRepository(Comment);
    await commentRepo.save(commentRepo.create({
      ticket_id: ticket.id,
      author_type: 'system',
      author_id: '',
      author: 'Security',
      content: body,
      type: 'note',
    }));
  }

  private async _stampRunTicket(runId: string, ticketId: string): Promise<void> {
    await this.dataSource.getRepository(SecurityRun).update({ id: runId }, { auto_ticket_id: ticketId });
  }

  private _buildLabels(cfg: SecurityOnFailureTicketConfig, profileId: string): string[] {
    const base = cfg.labels && cfg.labels.length ? cfg.labels.slice() : DEFAULT_LABELS.slice();
    const marker = `${PROFILE_LABEL_PREFIX}${profileId}`;
    if (!base.includes(marker)) base.push(marker);
    return base;
  }

  private _buildTitle(cfg: SecurityOnFailureTicketConfig, profile: SecurityProfile, qualifying: SecurityFinding[]): string {
    const tpl = cfg.title_template && cfg.title_template.trim() ? cfg.title_template : '보안 점검 실패: {{profile.name}}';
    const base = tpl.replace(/\{\{\s*profile\.name\s*\}\}/g, profile.name);
    const top = qualifying[0]?.severity;
    return top ? `[${top}] ${base}` : base;
  }

  /** "1 critical, 2 high" style severity rollup over a finding list. */
  private _severityCounts(findings: SecurityFinding[]): string {
    const order: SecuritySeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
    const counts = new Map<SecuritySeverity, number>();
    for (const f of findings) counts.set(f.severity, (counts.get(f.severity) || 0) + 1);
    const parts = order.filter((s) => counts.get(s)).map((s) => `${counts.get(s)} ${s}`);
    return parts.length ? parts.join(', ') : '0';
  }

  /** "(scanned <sha> / baseline <sha>)" commit-range suffix for a run. */
  private _commitSuffix(run: SecurityRun): string {
    const scanned = run.scanned_commit ? run.scanned_commit.slice(0, 12) : '(미보고)';
    const baseline = run.baseline_commit ? run.baseline_commit.slice(0, 12) : '(없음 — full)';
    return ` · scanned \`${scanned}\` / baseline \`${baseline}\``;
  }

  /** Markdown block listing each finding: severity/category/file:line/evidence/remediation. */
  private _findingBlock(findings: SecurityFinding[]): string {
    if (findings.length === 0) return '_(없음)_';
    return findings.map((f) => {
      const loc = f.file ? `${f.file}${typeof f.line === 'number' ? `:${f.line}` : ''}` : null;
      const head = `- **[${f.severity}]** ${f.title}${f.category ? ` _(${f.category})_` : ''}`;
      const lines = [head];
      if (loc) lines.push(`  - 위치: \`${loc}\``);
      if (f.evidence) lines.push(`  - 증거: ${f.evidence}`);
      if (f.remediation) lines.push(`  - 수정: ${f.remediation}`);
      if (f.checklist_item_id) lines.push(`  - 체크리스트: \`${f.checklist_item_id}\``);
      return lines.join('\n');
    }).join('\n');
  }

  private async _buildBody(
    run: SecurityRun,
    profile: SecurityProfile,
    boardId: string | null,
    qualifying: SecurityFinding[],
    minSeverity: SecuritySeverity,
  ): Promise<string> {
    const wsId = profile.workspace_id;
    const securityDetailLink = boardId ? `/ws/${wsId}/boards/${boardId}/security` : `/ws/${wsId}/security`;

    const allFindings = Array.isArray(run.findings) ? run.findings : [];
    const belowGate = allFindings.filter((f) => !qualifying.includes(f));

    const artifactBlock = await this._artifactLinks(run);

    return [
      `> 🤖 이 티켓은 보안 점검 실패로 자동 생성되었습니다 (severity-gated).`,
      ``,
      `## 보안 점검 실패 리포트`,
      ``,
      `- **프로파일:** ${profile.name} (\`${profile.id}\`)`,
      `- **Run:** \`${run.id}\` — status \`${run.status}\``,
      `- **드라이버:** ${profile.scan_driver || '(미지정)'}`,
      `- **스코프:** \`${run.scope_used}\``,
      `- **스캔 커밋:** \`${run.scanned_commit || '(미보고)'}\``,
      `- **기준 커밋(baseline):** \`${run.baseline_commit || '(없음 — full scan)'}\``,
      `- **게이트:** \`>= ${minSeverity}\` — 통과 ${qualifying.length}건 (${this._severityCounts(qualifying)})`,
      `- **보안 상세:** ${securityDetailLink}`,
      ``,
      `### 게이트 통과 finding (>= ${minSeverity})`,
      this._findingBlock(qualifying),
      ``,
      belowGate.length ? `### 게이트 미만 finding (참고)\n${this._findingBlock(belowGate)}\n` : null,
      `### Run 요약`,
      run.summary ? run.summary : '_(요약 없음)_',
      ``,
      `### 증거 아티팩트 (스크린샷 / diff 덤프 / 리포트)`,
      artifactBlock,
      ``,
      `---`,
      `_재현: 보안 프로파일 \`${profile.id}\` 를 다시 실행하거나 위 상세 링크에서 run \`${run.id}\` 를 확인하세요. 커밋 범위 \`${run.baseline_commit || 'ROOT'}..${run.scanned_commit || 'HEAD'}\`._`,
    ].filter((l) => l !== null).join('\n');
  }

  /** Markdown links to every artifact Resource on the run (raw stream URLs). */
  private async _artifactLinks(run: SecurityRun): Promise<string> {
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
