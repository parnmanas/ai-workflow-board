#!/usr/bin/env node
// Prompt-audit effect measurement (ticket ec498050, Planner decision Q3).
//
// Computes 4 metrics over a time window, sourced from ActivityLog + Comment
// (Planner's fixed formula — "산식은 후속 티켓이 그대로 재실행할 수 있게
// 스크립트에 고정"):
//
//   1. start_rate            — of tickets moved into an active-kind column
//                               (e.g. In Progress), what fraction ALSO moved
//                               forward again (Review/Merging/Done) AFTER
//                               that active entry (earliest one in-window),
//                               instead of stalling? Proxy for 29ea479c's
//                               "refuses to start without a fresh plan"
//                               failure mode. Order matters: a ticket bounced
//                               back for rework (e.g. Review -> In Progress
//                               on changes-requested) has an EARLIER forward
//                               move that must NOT count as "advancing" a
//                               LATER, unrelated active re-entry — see the
//                               regression test's Review(t0)->In Progress(t1)
//                               fixture.
//   2. unnecessary_questions  — count of agent-authored type='question'
//                               comments in the window. Proxy for "asks
//                               instead of investigating".
//   3. pending_misclassification_rate — of ActivityLog rows flipping
//                               pending_user_action false->true in the
//                               window, what fraction landed on a ticket
//                               whose terminal_entered_at was ALREADY set
//                               (and earlier) at pend time? This is the
//                               EXACT 0709ea7c shape (terminal ticket pended
//                               anyway) — ticket ec498050's Phase A code fix
//                               should drive this to 0 going forward.
//   4. completion_rate        — of ROOT tickets (depth=0) CREATED in the
//                               window, what fraction have terminal_entered_at
//                               set by measurement time (reached Done)?
//
// Two non-obvious ActivityLog shape gotchas this script works around (found
// by this ticket's own regression test, not by inspection alone):
//   - `field_changed='column'` rows store the COLUMN NAME in old/new_value
//     (`ticket-move.ts`), NOT the column id — matching must be by name.
//   - ActivityLog.workspace_id is frequently left at its '' default (most
//     `logActivity()` call sites for `moved`/`pending_user_action` never pass
//     it — only some Action-run paths do). Never filter ActivityLog by its
//     own `workspace_id` column; always scope through an inner join to
//     Ticket.workspace_id instead, which IS reliably populated on every
//     ticket row.
//
// This script is READ-ONLY (no writes) but still calls buildDataSourceOptions()
// + DataSource.initialize(), which runs TypeORM `synchronize` (D-01, always on)
// against whatever DB the env points to — harmless schema-only alignment, same
// as every qa-flow test already does, but be deliberate about which DB you
// point this at (see Usage). This script does NOT default to any live/shared
// DB_HOST — every Postgres field must be supplied explicitly, and the sqlite
// fallback only ever touches the LOCAL server/database/data.db your own shell
// is already configured for (same file `npm run dev` would open).
//
// `computeReport()` is exported so `test/measure-prompt-audit-effect.test.mjs`
// can call it directly against a seeded fixture DataSource — the CLI `main()`
// below is a thin wrapper (arg parsing + DataSource lifecycle + print).
//
// Usage:
//   node apps/server/scripts/measure-prompt-audit-effect.mjs \
//     [--since 2026-07-01T00:00:00Z] [--until 2026-07-31T00:00:00Z] \
//     [--workspace <workspace_id>] [--json]
//
//   DB_TYPE=postgres DB_HOST=... DB_PORT=... DB_USER=... DB_PASS=... DB_NAME=... \
//     node apps/server/scripts/measure-prompt-audit-effect.mjs --since ... --until ...
//
// Build first so dist/ exists: (cd apps/server && npm run build)

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

function parseArgs(argv) {
  const out = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') { out.json = true; continue; }
    if (!a.startsWith('--')) continue;
    out[a.slice(2)] = argv[++i];
  }
  return out;
}

/**
 * Compute the 4-metric report against an already-initialized DataSource.
 * `entities` must carry { ActivityLog, Comment, Ticket, BoardColumn } —
 * passed in (rather than imported here) so callers on both the CLI path
 * (compiled dist/) and the test path (also compiled dist/, same classes)
 * share identical entity metadata with their own DataSource instance.
 */
export async function computeReport(ds, entities, { since, until, workspaceId } = {}) {
  const { ActivityLog, Comment, Ticket, BoardColumn } = entities;
  const untilResolved = until ?? new Date();
  const sinceResolved = since ?? new Date(untilResolved.getTime() - 30 * 24 * 60 * 60 * 1000);
  const range = { since: sinceResolved, until: untilResolved };

  const scopeByTicketWorkspace = (qb, ticketAlias) => {
    if (workspaceId) qb.andWhere(`${ticketAlias}.workspace_id = :wsId`, { wsId: workspaceId });
    return qb;
  };

  // ── Metric 1: start_rate ────────────────────────────────────────────────
  // `field_changed='column'` stores the COLUMN NAME (not id) in old/new_value
  // (ticket-move.ts) — match by name. Scope by workspace via an inner join to
  // Ticket, since ActivityLog.workspace_id is not reliably populated for
  // these rows.
  const activeCols = await ds.getRepository(BoardColumn).find({ where: { kind: 'active' } });
  const activeColNames = [...new Set(activeCols.map((c) => c.name).filter(Boolean))];
  const startRate = { entered_active: 0, also_advanced: 0, rate: null };
  if (activeColNames.length > 0) {
    // Reference "start" instant per ticket = EARLIEST active-column entry in
    // the window (MIN, not MAX — a ticket may bounce in and out of active
    // more than once in-window; the first entry is when it started work).
    const enteredRows = await scopeByTicketWorkspace(
      ds.getRepository(ActivityLog).createQueryBuilder('a')
        .innerJoin(Ticket, 't', 't.id = a.ticket_id')
        .select('a.ticket_id', 'ticket_id')
        .addSelect('MIN(a.created_at)', 'entered_at')
        .where("a.action = 'moved' AND a.field_changed = 'column'")
        .andWhere('a.new_value IN (:...activeColNames)', { activeColNames })
        .andWhere('a.created_at >= :since AND a.created_at < :until', range)
        .groupBy('a.ticket_id'),
      't',
    ).getRawMany();
    const enteredAtByTicket = new Map(
      enteredRows.filter((r) => r.ticket_id).map((r) => [r.ticket_id, new Date(r.entered_at)]),
    );
    startRate.entered_active = enteredAtByTicket.size;
    if (enteredAtByTicket.size > 0) {
      const forwardCols = await ds.getRepository(BoardColumn).find({
        where: [{ kind: 'review' }, { kind: 'merging' }, { kind: 'terminal' }],
      });
      const forwardColNames = [...new Set(forwardCols.map((c) => c.name).filter(Boolean))];
      if (forwardColNames.length > 0) {
        const advancedRows = await ds.getRepository(ActivityLog).createQueryBuilder('a')
          .select('a.ticket_id', 'ticket_id')
          .addSelect('a.created_at', 'advanced_at')
          .where("a.action = 'moved' AND a.field_changed = 'column'")
          .andWhere('a.ticket_id IN (:...enteredIds)', { enteredIds: [...enteredAtByTicket.keys()] })
          .andWhere('a.new_value IN (:...forwardColNames)', { forwardColNames })
          .andWhere('a.created_at >= :since AND a.created_at < :until', range)
          .getRawMany();
        // >= (not >): a forward move at or after the ticket's earliest active
        // entry counts. A forward move BEFORE that entry (the Review->In
        // Progress bounce-back case) must not.
        const advancedTicketIds = new Set(
          advancedRows
            .filter((r) => r.ticket_id && new Date(r.advanced_at) >= enteredAtByTicket.get(r.ticket_id))
            .map((r) => r.ticket_id),
        );
        startRate.also_advanced = advancedTicketIds.size;
      }
      startRate.rate = startRate.also_advanced / startRate.entered_active;
    }
  }

  // ── Metric 2: unnecessary_questions ─────────────────────────────────────
  // Comment.workspace_id has the same reliability question as ActivityLog's —
  // scope through the ticket join rather than trusting the column directly.
  const unnecessaryQuestions = await scopeByTicketWorkspace(
    ds.getRepository(Comment).createQueryBuilder('c')
      .innerJoin(Ticket, 't', 't.id = c.ticket_id')
      .where("c.author_type = 'agent' AND c.type = 'question'")
      .andWhere('c.created_at >= :since AND c.created_at < :until', range),
    't',
  ).getCount();

  // ── Metric 3: pending_misclassification_rate ────────────────────────────
  // Single joined query pulls the ticket's terminal_entered_at alongside each
  // pend event (avoids the N+1 per-event findOne of an earlier draft).
  const pendRows = await scopeByTicketWorkspace(
    ds.getRepository(ActivityLog).createQueryBuilder('a')
      .innerJoin(Ticket, 't', 't.id = a.ticket_id')
      .select('a.ticket_id', 'ticket_id')
      .addSelect('a.created_at', 'pend_at')
      .addSelect('t.terminal_entered_at', 'terminal_entered_at')
      .where("a.field_changed = 'pending_user_action' AND a.new_value = 'true'")
      .andWhere('a.created_at >= :since AND a.created_at < :until', range),
    't',
  ).getRawMany();
  const misclassified = pendRows.filter((r) => r.terminal_entered_at && new Date(r.terminal_entered_at) < new Date(r.pend_at)).length;
  const pendingMisclassificationRate = {
    pend_events: pendRows.length,
    misclassified,
    rate: pendRows.length > 0 ? misclassified / pendRows.length : null,
  };

  // ── Metric 4: completion_rate ────────────────────────────────────────────
  // Queries Ticket directly — Ticket.workspace_id IS reliably populated (set
  // at creation on every ticket), unlike the ActivityLog/Comment columns above.
  const createdQb = ds.getRepository(Ticket).createQueryBuilder('t')
    .where('t.depth = 0 AND t.parent_id IS NULL')
    .andWhere('t.created_at >= :since AND t.created_at < :until', range);
  if (workspaceId) createdQb.andWhere('t.workspace_id = :wsId', { wsId: workspaceId });
  const created = await createdQb.getMany();
  const completed = created.filter((t) => !!t.terminal_entered_at).length;
  const completionRate = {
    created: created.length,
    completed,
    rate: created.length > 0 ? completed / created.length : null,
  };

  return {
    window: { since: sinceResolved.toISOString(), until: untilResolved.toISOString() },
    workspace_id: workspaceId || null,
    start_rate: startRate,
    unnecessary_questions: unnecessaryQuestions,
    pending_misclassification_rate: pendingMisclassificationRate,
    completion_rate: completionRate,
  };
}

function printReport(report) {
  console.log(`\n프롬프트 정비 효과 측정 — ${report.window.since} ~ ${report.window.until}${report.workspace_id ? ` (workspace=${report.workspace_id})` : ' (전체 워크스페이스)'}\n`);
  const pct = (r) => (r == null ? 'N/A' : (r * 100).toFixed(1) + '%');
  console.log(`1. 착수율(start_rate): ${report.start_rate.also_advanced}/${report.start_rate.entered_active} = ${pct(report.start_rate.rate)}`);
  console.log(`2. 불필요 질문 수(unnecessary_questions): ${report.unnecessary_questions}건`);
  console.log(`3. pending 오분류율(pending_misclassification_rate): ${report.pending_misclassification_rate.misclassified}/${report.pending_misclassification_rate.pend_events} = ${pct(report.pending_misclassification_rate.rate)}`);
  console.log(`4. 완료율(completion_rate): ${report.completion_rate.completed}/${report.completion_rate.created} = ${pct(report.completion_rate.rate)}\n`);
  console.log('JSON 전체 출력: --json 플래그 사용');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const until = args.until ? new Date(args.until) : undefined;
  const since = args.since ? new Date(args.since) : undefined;
  if ((args.since && Number.isNaN(new Date(args.since).getTime())) || (args.until && Number.isNaN(new Date(args.until).getTime()))) {
    console.error('Invalid --since/--until — expected an ISO 8601 timestamp.');
    process.exit(1);
  }

  const { buildDataSourceOptions } = await import('file://' + path.join(DIST, 'db.js'));
  const { DataSource } = await import('typeorm');
  const { ActivityLog } = await import('file://' + path.join(DIST, 'entities', 'ActivityLog.js'));
  const { Comment } = await import('file://' + path.join(DIST, 'entities', 'Comment.js'));
  const { Ticket } = await import('file://' + path.join(DIST, 'entities', 'Ticket.js'));
  const { BoardColumn } = await import('file://' + path.join(DIST, 'entities', 'BoardColumn.js'));

  const ds = new DataSource(buildDataSourceOptions());
  await ds.initialize();
  try {
    const report = await computeReport(ds, { ActivityLog, Comment, Ticket, BoardColumn }, {
      since, until, workspaceId: args.workspace,
    });
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printReport(report);
    }
  } finally {
    await ds.destroy();
  }
}

// Only auto-run as a CLI — importing computeReport for tests must not trigger main().
if (import.meta.url === 'file://' + process.argv[1]) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
