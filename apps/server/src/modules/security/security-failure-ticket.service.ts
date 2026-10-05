import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { Comment } from '../../entities/Comment';
import { Resource } from '../../entities/Resource';
import { SecurityProfile, SecurityOnFailureTicketConfig, SecuritySeverity } from '../../entities/SecurityProfile';
import { SecurityRun, SecurityFinding } from '../../entities/SecurityRun';
import { LogService } from '../../services/log.service';
import { ProjectsService } from '../projects/projects.service';
import { TicketService, normalizeTags, type TicketActor } from '../tickets/ticket.service';
import { DONE_STATUS } from '../../common/ticket-status';
import { parseRuntimeSpec } from '../../common/runtime-spec';

// Internal traceability tag so per_open_ticket dedupe can find the profile's
// own open security ticket without a metadata column on Ticket. Homologous to
// QA's `qa-scenario:<id>` back-ref.
const PROFILE_TAG_PREFIX = 'security-profile:';
const DEFAULT_TAGS = ['security', 'auto'];
const DEFAULT_PRIORITY = 'high';
const DEFAULT_MIN_SEVERITY: SecuritySeverity = 'high';

const SECURITY_ACTOR: TicketActor = { id: '', name: 'Security', type: 'system' };

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
 * The ticket goes through TicketService.create into the run's workspace pool
 * (docs/tickets.md → "QA / Security failure tickets"): tags from the policy,
 * optional project, status `todo` (or `backlog`), and an assignee resolved as
 * `assignee_runtime` → profile `target_runtime` → the project's
 * default_assignee (TicketService applies that last one when we omit
 * `assignee`).
 *
 * Idempotency is two-layered (same shape as QA):
 *   1. run.auto_ticket_id — set once per run; a re-finalize of the SAME run is a
 *      no-op (returns the existing id). This is the run-level guard.
 *   2. dedupe='per_open_ticket' — across DIFFERENT runs of the same profile, if
 *      an open (not done, non-archived) security ticket already exists,
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
    private readonly ticketService: TicketService,
    private readonly projects: ProjectsService,
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
      const accountId = run.account_id || profile.account_id;
      if (!accountId) {
        this.logService.warn('Security', `on_failure_ticket enabled for profile ${profile.id} but run ${run.id} has no workspace — skipping`);
        return null;
      }

      // per_open_ticket: reuse an existing open ticket if present.
      if ((cfg.dedupe || 'per_run') === 'per_open_ticket') {
        const existing = await this._findOpenFailureTicket(profile, accountId);
        if (existing) {
          await this._appendRecurrenceComment(existing, run, profile, qualifying, minSeverity);
          await this._stampRunTicket(run.id, existing.id);
          this.logService.info('Security', `on_failure_ticket: recurrence on open ticket ${existing.id} for profile ${profile.id} (run ${run.id})`);
          return existing.id;
        }
      }

      const ticketId = await this._createTicket(run, profile, cfg, accountId, qualifying, minSeverity);
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

  private async _findOpenFailureTicket(profile: SecurityProfile, accountId: string): Promise<Ticket | null> {
    const marker = `${PROFILE_TAG_PREFIX}${profile.id}`;
    // Match the JSON-string tag list (`tags` is a JSON string column). LIKE
    // works identically on SQLite(dev) and Postgres(prod) — no JSON operators.
    return this.dataSource.getRepository(Ticket).createQueryBuilder('t')
      .where('t.account_id = :ws', { ws: accountId })
      .andWhere('t.depth = 0')
      .andWhere('t.archived_at IS NULL')
      .andWhere('t.status <> :done', { done: DONE_STATUS })
      .andWhere('t.tags LIKE :marker', { marker: `%${marker}%` })
      .orderBy('t.created_at', 'DESC')
      .getOne();
  }

  private async _createTicket(
    run: SecurityRun,
    profile: SecurityProfile,
    cfg: SecurityOnFailureTicketConfig,
    accountId: string,
    qualifying: SecurityFinding[],
    minSeverity: SecuritySeverity,
  ): Promise<string> {
    // A project id that no longer resolves in this workspace must not swallow
    // the finding report — file it without a project and say so in the log.
    let projectId: string | null = (cfg.project_id || '').trim() || null;
    if (projectId && !(await this.projects.getInWorkspace(projectId, accountId))) {
      this.logService.warn('Security', `on_failure_ticket: project ${projectId} not found in workspace ${accountId} (profile ${profile.id}) — filing without a project`);
      projectId = null;
    }
    // assignee_runtime → profile target_runtime → (omitted) project default_assignee.
    const assignee = parseRuntimeSpec(cfg.assignee_runtime) || parseRuntimeSpec(profile.target_runtime);

    const { ticket } = await this.ticketService.create(accountId, {
      title: this._buildTitle(cfg, profile, qualifying),
      description: await this._buildBody(run, profile, accountId, qualifying, minSeverity),
      priority: cfg.priority || DEFAULT_PRIORITY,
      status: cfg.status === 'backlog' ? 'backlog' : 'todo',
      tags: this._buildTags(cfg, profile.id),
      project_id: projectId,
      ...(assignee ? { assignee } : {}),
    }, SECURITY_ACTOR);
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

  private _buildTags(cfg: SecurityOnFailureTicketConfig, profileId: string): string[] {
    // `labels` is the pre-board-removal name of `tags` — still honoured for
    // policies the migration did not rewrite (e.g. written by an older client).
    const configured = normalizeTags(cfg.tags ?? cfg.labels);
    const base = configured.length ? configured : DEFAULT_TAGS.slice();
    const marker = `${PROFILE_TAG_PREFIX}${profileId}`;
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
    accountId: string,
    qualifying: SecurityFinding[],
    minSeverity: SecuritySeverity,
  ): Promise<string> {
    const securityDetailLink = `/security`;

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
