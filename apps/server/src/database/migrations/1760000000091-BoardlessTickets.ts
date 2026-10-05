import { MigrationInterface, QueryRunner } from 'typeorm';
import { createHash } from 'crypto';
import { bindParams } from '../action-cron-timezone';

/**
 * Board removal, phase 2 of 2 (docs/tickets.md) — runs after synchronize.
 * Phase 1 (database/pre-sync-board-removal.ts) snapshotted what synchronize
 * was about to drop; this migration turns it into the board-less model:
 *
 *   - repository Resources → Projects (same id, so every stored reference
 *     keeps resolving), then the repository Resource rows are removed;
 *   - ticket column → status, board name → tag (plus the old labels), base
 *     repo (or the board's environment repo) → project, the assignee role's
 *     RuntimeSpec snapshot → the single assignee;
 *   - tickets of archived boards are archived with them;
 *   - board settings that have a workspace home move there (language, cap,
 *     auto-archive); a board's `use_pr` moves onto its repository's project;
 *   - `repo_ref.resource_id` → `repo_ref.project_id`, QA/Security
 *     `on_failure_ticket` board/column → tags + project, outreach target
 *     board → tags + project;
 *   - the retired tables are dropped.
 *
 * On a fresh database none of the source tables exist and this is a no-op.
 * Rolling back needs the pre-deploy database backup — retired data is gone.
 */
export class BoardlessTickets1760000000091 implements MigrationInterface {
  name = 'BoardlessTickets1760000000091';

  async up(runner: QueryRunner): Promise<void> {
    const has = (t: string) => runner.hasTable(t);
    const boards = await has('boards') ? await runner.query('SELECT * FROM boards') : [];
    const columns = await has('columns') ? await runner.query('SELECT * FROM columns') : [];
    const boardById = new Map<string, any>(boards.map((b: any) => [String(b.id), b]));
    const columnById = new Map<string, any>(columns.map((c: any) => [String(c.id), c]));
    const firstWorkspace = (await runner.query('SELECT id FROM accounts ORDER BY created_at ASC'))[0]?.id ?? null;

    // ── projects ────────────────────────────────────────────────────────
    const projectIds = new Set<string>(
      (await runner.query('SELECT id FROM projects')).map((r: any) => String(r.id)),
    );
    if (await has('board_removal_repo_snapshot')) {
      for (const repo of await runner.query('SELECT * FROM board_removal_repo_snapshot')) {
        const id = String(repo.id);
        const accountId = repo.account_id || firstWorkspace;
        if (!accountId || projectIds.has(id)) continue;
        await bindParams(runner,
          'INSERT INTO projects (id, account_id, name, description, repo_url, default_branch, credential_id, clone_policy, use_pr, instructions) ' +
          'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [id, accountId, repo.name || 'Repository', repo.description || '', repo.url || '', repo.default_branch || '',
            repo.credential_id || null, repo.clone_policy || null, false, '']);
        projectIds.add(id);
      }
      const repoIds = (await runner.query('SELECT id FROM board_removal_repo_snapshot')).map((r: any) => String(r.id));
      for (const id of repoIds) {
        if (await has('resource_embeddings')) await bindParams(runner, 'DELETE FROM resource_embeddings WHERE resource_id = ?', [id]);
        await bindParams(runner, 'DELETE FROM resources WHERE CAST(id AS VARCHAR) = ?', [id]);
      }
    }

    const boardRepoProject = (board: any): string | null => {
      if (!board?.environment_config) return null;
      try {
        const env = JSON.parse(board.environment_config);
        for (const repo of env?.repositories || []) {
          const rid = String(repo?.resource_id || '').trim();
          if (rid && projectIds.has(rid)) return rid;
        }
      } catch { /* malformed board env — no project */ }
      return null;
    };

    // A board that landed through PRs makes its repository's project do so too.
    for (const board of boards) {
      const pid = boardRepoProject(board);
      if (pid && (board.use_pr === true || board.use_pr === 1 || board.use_pr === 'true')) {
        await bindParams(runner, 'UPDATE projects SET use_pr = ? WHERE CAST(id AS VARCHAR) = ?', [true, pid]);
      }
    }

    // ── tickets ─────────────────────────────────────────────────────────
    if (await has('board_removal_ticket_snapshot')) {
      const assigneeSpecs = await this.assigneeSpecs(runner);
      for (const snap of await runner.query('SELECT * FROM board_removal_ticket_snapshot')) {
        const ticketId = String(snap.ticket_id);
        const column = snap.column_id ? columnById.get(String(snap.column_id)) : null;
        const board = column ? boardById.get(String(column.board_id)) : null;
        const tags = mergeTags(parseArray(snap.labels), board?.name ? [String(board.name)] : []);
        const repoId = String(snap.base_repo_resource_id || '').trim();
        const projectId = repoId && projectIds.has(repoId) ? repoId : boardRepoProject(board);
        const sets: string[] = ['tags = ?', 'project_id = ?'];
        const params: any[] = [JSON.stringify(tags), projectId];
        if (column) {
          sets.push('status = ?');
          params.push(statusForColumn(column));
        }
        const spec = assigneeSpecs.get(ticketId);
        if (spec) {
          sets.push('assignee = ?', 'assignee_key = ?');
          params.push(JSON.stringify(spec), runtimeKey(spec));
        }
        if (board?.archived_at) {
          sets.push('archived_at = COALESCE(archived_at, ?)');
          params.push(board.archived_at);
        }
        params.push(ticketId);
        await bindParams(runner, `UPDATE tickets SET ${sets.join(', ')} WHERE CAST(id AS VARCHAR) = ?`, params);
      }
    }

    // ── workspace settings that lived on boards ─────────────────────────
    const byWorkspace = new Map<string, any[]>();
    for (const board of boards) {
      if (!board.account_id || board.archived_at) continue;
      const list = byWorkspace.get(String(board.account_id)) || [];
      list.push(board);
      byWorkspace.set(String(board.account_id), list);
    }
    for (const [accountId, list] of byWorkspace) {
      const language = mostCommon(list.map((b) => b.language).filter((v) => v && String(v).trim()));
      const archiveDays = mostCommon(list.map((b) => b.auto_archive_days).filter((v) => v !== null && v !== undefined));
      const cap = Math.max(1, ...list.map((b) => Number(b.max_concurrent_tickets_per_agent) || 1));
      await bindParams(runner,
        'UPDATE accounts SET language = COALESCE(language, ?), auto_archive_days = COALESCE(auto_archive_days, ?), max_concurrent_tickets_per_agent = ? WHERE CAST(id AS VARCHAR) = ?',
        [language ?? null, archiveDays ?? null, cap, accountId]);
    }

    // ── repo_ref / on_failure_ticket / outreach rewrites ────────────────
    for (const table of ['qa_scenarios', 'security_profiles', 'actions', 'orchestration_missions']) {
      if (!await has(table) || !await runner.hasColumn(table, 'repo_ref')) continue;
      for (const row of await runner.query(`SELECT id, repo_ref FROM "${table}" WHERE repo_ref IS NOT NULL`)) {
        const ref = parseObject(row.repo_ref);
        if (!ref || !ref.resource_id) continue;
        const next: any = { ...ref };
        if (projectIds.has(String(ref.resource_id))) next.project_id = String(ref.resource_id);
        delete next.resource_id;
        await bindParams(runner, `UPDATE "${table}" SET repo_ref = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
      }
    }
    for (const table of ['qa_scenarios', 'security_profiles']) {
      if (!await has(table) || !await runner.hasColumn(table, 'on_failure_ticket')) continue;
      for (const row of await runner.query(`SELECT id, on_failure_ticket FROM "${table}" WHERE on_failure_ticket IS NOT NULL`)) {
        const cfg = parseObject(row.on_failure_ticket);
        if (!cfg) continue;
        const board = cfg.board_id ? boardById.get(String(cfg.board_id)) : null;
        const next: any = { ...cfg };
        next.tags = mergeTags(Array.isArray(cfg.labels) ? cfg.labels : [], board?.name ? [String(board.name)] : []);
        if (!next.project_id) {
          const pid = boardRepoProject(board);
          if (pid) next.project_id = pid;
        }
        const column = cfg.column_id ? columnById.get(String(cfg.column_id)) : null;
        if (column && statusForColumn(column) === 'backlog') next.status = 'backlog';
        for (const k of ['board_id', 'column_id', 'column_name', 'labels', 'assignee_id']) delete next[k];
        await bindParams(runner, `UPDATE "${table}" SET on_failure_ticket = ? WHERE id = ?`, [JSON.stringify(next), row.id]);
      }
    }
    if (await has('outreach_channels') && await runner.hasColumn('outreach_channels', 'target_tags')) {
      const hasOld = await has('board_removal_outreach_targets');
      if (hasOld) {
        for (const row of await runner.query('SELECT * FROM board_removal_outreach_targets')) {
          const board = row.target_board_id ? boardById.get(String(row.target_board_id)) : null;
          if (!board) continue;
          await bindParams(runner, 'UPDATE outreach_channels SET target_tags = ?, target_project_id = COALESCE(target_project_id, ?) WHERE CAST(id AS VARCHAR) = ?',
            [JSON.stringify([String(board.name)]), boardRepoProject(board), String(row.id)]);
        }
      }
    }

    // ── drop what no longer has an entity ───────────────────────────────
    for (const table of [
      'board_removal_ticket_snapshot', 'board_removal_repo_snapshot', 'board_removal_outreach_targets',
      'board_lessons', 'column_role_policies', 'ticket_role_assignments', 'workspace_roles', 'prompt_templates',
      'dispatch_intents', 'merge_leases', 'review_drift_states', 'features', 'benchmark_scores', 'stuck_alerts',
      'ticket_completion_verification_attempts', 'ticket_completion_verifications', 'comment_summary_runs',
      'columns', 'boards',
    ]) {
      if (!await has(table)) continue;
      if (runner.connection.options.type === 'postgres') await runner.query(`DROP TABLE "${table}" CASCADE`);
      else await runner.query(`DROP TABLE "${table}"`);
    }
  }

  /** ticket id → the assignee role's RuntimeSpec snapshot (first holder that has one). */
  private async assigneeSpecs(runner: QueryRunner): Promise<Map<string, Record<string, any>>> {
    const out = new Map<string, Record<string, any>>();
    if (!await runner.hasTable('ticket_role_assignments') || !await runner.hasTable('workspace_roles')) return out;
    if (!await runner.hasColumn('ticket_role_assignments', 'runtime_spec')) return out;
    const roles = await runner.query("SELECT id FROM workspace_roles WHERE slug = 'assignee'");
    const roleIds = new Set(roles.map((r: any) => String(r.id)));
    const rows = await runner.query('SELECT ticket_id, role_id, runtime_spec, created_at FROM ticket_role_assignments WHERE runtime_spec IS NOT NULL ORDER BY created_at ASC');
    for (const row of rows) {
      if (!roleIds.has(String(row.role_id))) continue;
      const ticketId = String(row.ticket_id);
      if (out.has(ticketId)) continue;
      const spec = parseObject(row.runtime_spec);
      if (spec && spec.manager_agent_id && spec.cli && spec.working_dir) out.set(ticketId, spec);
    }
    return out;
  }

  async down(): Promise<void> {
    throw new Error('Boards cannot be reconstructed; restore the pre-deploy database backup to roll back');
  }
}

/** Old column → fixed status. Kind decides; "In Progress" is the one active column that is not "to do". */
function statusForColumn(column: any): string {
  const kind = String(column.kind || '');
  const name = String(column.name || '').trim().toLowerCase();
  if (kind === 'terminal' || column.is_terminal === true || column.is_terminal === 1) return 'done';
  if (kind === 'intake') return 'backlog';
  if (kind === 'review') return 'review';
  if (kind === 'merging') return 'in_progress';
  if (name === 'in progress' || name === 'doing') return 'in_progress';
  return 'todo';
}

/** Same bytes as common/runtime-spec.ts runtimeIdentityKey — a migration must not import app code that may change. */
function runtimeKey(spec: Record<string, any>): string {
  const norm = (v: unknown) => (v == null ? '' : String(v)).trim();
  const digest = createHash('sha256')
    .update(`${norm(spec.cli).toLowerCase()}\0${norm(spec.working_dir)}\0${norm(spec.credential_id)}`, 'utf8')
    .digest('hex')
    .slice(0, 16);
  return `rt-${digest}`;
}

function parseArray(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string' || !raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseObject(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function mergeTags(...lists: string[][]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of lists.flat()) {
    const t = String(tag).trim();
    if (!t || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
  }
  return out;
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<string, { value: T; n: number }>();
  for (const value of values) {
    const k = String(value);
    const entry = counts.get(k) || { value, n: 0 };
    entry.n += 1;
    counts.set(k, entry);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.value;
}
