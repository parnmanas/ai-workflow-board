import { MigrationInterface, QueryRunner } from 'typeorm';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Workspace } from '../../entities/Workspace';

/**
 * v0.41 — server-owned dispatch queue + data-driven column classification.
 *
 *   1. Adds `columns.kind` (varchar) — workflow classification enum
 *      (intake / active / review / merging / terminal). Replaces every
 *      `col.name.toLowerCase() === '<literal>'` runtime compare with a
 *      single column read.
 *
 *   2. Adds `columns.role_routing` (text) — JSON array of role slugs.
 *      Replaces the `Board.routing_config` lookup keyed by lowercased
 *      column name. The legacy `routing_config` blob stays on Board for
 *      backward-compat with admin UIs; CRUD paths now write through to
 *      per-column `role_routing` so runtime never reads the lowercased
 *      name again.
 *
 *   3. Adds workspace-level cadence settings (`supervisor_stale_ms`,
 *      `supervisor_resend_ms`, `dispatch_queue_depth`) so the previously
 *      hardcoded `30 * 60_000` / `5 * 60_000` constants and the new
 *      queue depth cap are runtime-tunable per workspace.
 *
 * Schema DDL is gated to Postgres (production); SQLite (dev) gets the
 * columns via `synchronize: true` on the entities. We always run the data
 * backfill so existing dev DBs catch up the moment they boot the new code.
 *
 * D-02: data only on SQLite, conditional DDL on Postgres for safety.
 * D-04: idempotent — re-runs are no-ops because backfill checks `kind = ''`
 *       and `role_routing = '[]' OR ''` before writing.
 */
export class AddColumnKindAndRoleRouting1760000000016 implements MigrationInterface {
  name = 'AddColumnKindAndRoleRouting1760000000016';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const isPostgres = queryRunner.connection.options.type === 'postgres';

    if (isPostgres) {
      // Defensive DDL — synchronize:true should already have applied these,
      // but the IF NOT EXISTS guard makes this safe to run on already-synced
      // databases (and on databases that hit this migration before the
      // entity sync ran for some reason — see D-02 / P-03 ordering note).
      await queryRunner.query(
        "ALTER TABLE columns ADD COLUMN IF NOT EXISTS kind VARCHAR NOT NULL DEFAULT ''"
      );
      await queryRunner.query(
        "ALTER TABLE columns ADD COLUMN IF NOT EXISTS role_routing TEXT NOT NULL DEFAULT '[]'"
      );
      await queryRunner.query(
        "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS supervisor_stale_ms INTEGER NOT NULL DEFAULT 1800000"
      );
      await queryRunner.query(
        "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS supervisor_resend_ms INTEGER NOT NULL DEFAULT 300000"
      );
      await queryRunner.query(
        "ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS dispatch_queue_depth INTEGER NOT NULL DEFAULT 100"
      );
    }

    // ── Backfill columns.kind ──
    //
    // Single time, name-tolerant heuristic. After this migration runs once,
    // every runtime path keys off `col.kind` directly — names can be edited
    // freely without changing dispatch semantics. The mapping is:
    //   - is_terminal=true → 'terminal'
    //   - position == 0    → 'intake'  (the lowest column slot is the queue)
    //   - name contains "review"           → 'review'
    //   - name contains "merg" / "merge"   → 'merging'
    //   - everything else                  → 'active'
    //
    // Skips rows whose kind is already non-empty so a re-run / partial run
    // is idempotent.
    const colRepo = queryRunner.manager.getRepository(BoardColumn);
    const cols = await colRepo.find();
    const colsByBoard = new Map<string, BoardColumn[]>();
    for (const c of cols) {
      const list = colsByBoard.get(c.board_id) ?? [];
      list.push(c);
      colsByBoard.set(c.board_id, list);
    }

    let kindBackfilled = 0;
    for (const [, group] of colsByBoard) {
      // Sort by position so position==0 (the lowest slot — typically Backlog
      // on the default preset) is identifiable per board.
      group.sort((a, b) => a.position - b.position);
      const minPosition = group.length > 0 ? group[0].position : 0;
      for (const col of group) {
        const current = String((col as any).kind || '');
        if (current.length > 0) continue;
        const lower = (col.name || '').toLowerCase();
        let kind: string;
        if ((col as any).is_terminal === true) {
          kind = 'terminal';
        } else if (col.position === minPosition) {
          kind = 'intake';
        } else if (lower.includes('review')) {
          kind = 'review';
        } else if (lower.includes('merging') || lower.includes('merge')) {
          kind = 'merging';
        } else {
          kind = 'active';
        }
        (col as any).kind = kind;
        kindBackfilled++;
      }
    }
    if (kindBackfilled > 0) {
      await colRepo.save(cols.filter(c => (c as any).kind && String((c as any).kind).length > 0));
    }

    // ── Backfill columns.role_routing from board.routing_config ──
    //
    // routing_config is a JSON blob keyed by lowercased column name. We
    // walk every board, parse it, and stamp the matching column row's
    // role_routing with the resolved slug list. Empty / missing entries
    // become `'[]'`. After this, runtime reads role_routing exclusively.
    const boardRepo = queryRunner.manager.getRepository(Board);
    const boards = await boardRepo.find();
    let routingBackfilled = 0;
    for (const board of boards) {
      const routing = safeJsonParse(board.routing_config, {}) as Record<string, string | string[]>;
      const group = colsByBoard.get(board.id) || [];
      for (const col of group) {
        const current = String((col as any).role_routing || '').trim();
        // Treat empty string / '[]' / null as "needs backfill" — but skip
        // anything an operator has already populated explicitly.
        if (current.length > 0 && current !== '[]') continue;
        const key = (col.name || '').toLowerCase();
        let slugs: string[] = [];
        if (Object.prototype.hasOwnProperty.call(routing, key)) {
          const raw = routing[key];
          slugs = Array.isArray(raw) ? raw.filter(s => typeof s === 'string' && s.length > 0)
            : (typeof raw === 'string' && raw.length > 0 ? [raw] : []);
        }
        (col as any).role_routing = JSON.stringify(slugs);
        routingBackfilled++;
      }
    }
    if (routingBackfilled > 0) {
      await colRepo.save(cols);
    }

    // ── Backfill workspace cadence/queue settings (no-ops on synced DBs) ──
    //
    // synchronize:true installs the default values during DataSource init,
    // so existing rows already carry 1800000 / 300000 / 100. We re-stamp
    // any nullable / zero rows just in case (defensive — a Postgres DB
    // that bypassed synchronize and hit a pre-default ADD COLUMN on a
    // legacy patch path could otherwise carry NULLs).
    const wsRepo = queryRunner.manager.getRepository(Workspace);
    const wss = await wsRepo.find();
    let wsBackfilled = 0;
    for (const ws of wss) {
      let touched = false;
      if (!Number.isFinite((ws as any).supervisor_stale_ms) || (ws as any).supervisor_stale_ms <= 0) {
        (ws as any).supervisor_stale_ms = 1800000;
        touched = true;
      }
      if (!Number.isFinite((ws as any).supervisor_resend_ms) || (ws as any).supervisor_resend_ms <= 0) {
        (ws as any).supervisor_resend_ms = 300000;
        touched = true;
      }
      if (!Number.isFinite((ws as any).dispatch_queue_depth) || (ws as any).dispatch_queue_depth <= 0) {
        (ws as any).dispatch_queue_depth = 100;
        touched = true;
      }
      if (touched) wsBackfilled++;
    }
    if (wsBackfilled > 0) {
      await wsRepo.save(wss);
    }

    console.log(
      `[v0.41 migration] columns: kind backfilled=${kindBackfilled}, role_routing backfilled=${routingBackfilled}; ` +
      `workspaces: cadence settings normalized=${wsBackfilled} of ${wss.length}`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // Data migration — no inverse. Schema columns added here remain even
    // after a logical roll-back; the runtime can ignore them safely.
  }
}

function safeJsonParse<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
}
