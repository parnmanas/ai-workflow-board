import { DataSource } from 'typeorm';

// 프롬프트 정비 효과 측정 산식(ticket ec498050, Planner 결정 Q3 — "산식은
// 후속 티켓이 그대로 재실행할 수 있게 스크립트에 고정"). f3fc298a가 이 파일로
// 옮겼다 — CLI 스크립트(scripts/measure-prompt-audit-effect.mjs, 이 모듈을
// re-export)와 `prompt_audit.measure_effect` builtin Function
// (workflow-functions.service.ts)이 서로 다른 두 사본 대신 하나의 구현을
// 공유하게 하기 위함이다. 산식은 test/measure-prompt-audit-effect.test.mjs가
// 고정한다.
//
// Computes 4 metrics over a time window, sourced from ActivityLog + Comment:
//   1. start_rate            — of tickets moved into an active-kind column,
//                               what fraction ALSO moved forward again
//                               (Review/Merging/Done) AFTER that active entry
//                               (earliest one in-window), instead of
//                               stalling? Order matters: a ticket bounced back
//                               for rework has an EARLIER forward move that
//                               must NOT count as "advancing" a LATER,
//                               unrelated active re-entry.
//   2. unnecessary_questions  — count of agent-authored type='question'
//                               comments in the window.
//   3. pending_misclassification_rate — of ActivityLog rows flipping
//                               pending_user_action false->true in the
//                               window, what fraction landed on a ticket
//                               whose terminal_entered_at was ALREADY set
//                               (and earlier) at pend time.
//   4. completion_rate        — of ROOT tickets (depth=0) CREATED in the
//                               window, what fraction have terminal_entered_at
//                               set by measurement time (reached Done)?
//
// Two non-obvious ActivityLog shape gotchas this works around:
//   - `field_changed='column'` rows store the COLUMN NAME in old/new_value
//     (`ticket-move.ts`), NOT the column id — matching must be by name.
//   - ActivityLog.workspace_id is frequently left at its '' default — never
//     filter ActivityLog by its own `workspace_id` column; always scope
//     through an inner join to Ticket.workspace_id instead, which IS reliably
//     populated on every ticket row.
//
// `entities` is passed in (rather than imported here) so callers with their
// own DataSource + entity metadata (compiled dist/ classes on both the CLI
// and builtin-Function paths) share identical metadata with their own
// DataSource instance.
export async function computeReport(
  ds: DataSource,
  entities: { ActivityLog: any; Comment: any; Ticket: any; BoardColumn: any },
  { since, until, workspaceId }: { since?: Date; until?: Date; workspaceId?: string } = {},
): Promise<Record<string, any>> {
  const { ActivityLog, Comment, Ticket, BoardColumn } = entities;
  const untilResolved = until ?? new Date();
  const sinceResolved = since ?? new Date(untilResolved.getTime() - 30 * 24 * 60 * 60 * 1000);
  const range = { since: sinceResolved, until: untilResolved };

  const scopeByTicketWorkspace = (qb: any, ticketAlias: string) => {
    if (workspaceId) qb.andWhere(`${ticketAlias}.workspace_id = :wsId`, { wsId: workspaceId });
    return qb;
  };

  // ── Metric 1: start_rate ────────────────────────────────────────────────
  // `field_changed='column'` stores the COLUMN NAME (not id) in old/new_value
  // (ticket-move.ts) — match by name. Scope by workspace via an inner join to
  // Ticket, since ActivityLog.workspace_id is not reliably populated for
  // these rows.
  const activeCols = await ds.getRepository(BoardColumn).find({ where: { kind: 'active' } });
  const activeColNames = [...new Set(activeCols.map((c: any) => c.name).filter(Boolean))];
  const startRate: { entered_active: number; also_advanced: number; rate: number | null } = { entered_active: 0, also_advanced: 0, rate: null };
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
      enteredRows.filter((r: any) => r.ticket_id).map((r: any) => [r.ticket_id, new Date(r.entered_at)]),
    );
    startRate.entered_active = enteredAtByTicket.size;
    if (enteredAtByTicket.size > 0) {
      const forwardCols = await ds.getRepository(BoardColumn).find({
        where: [{ kind: 'review' }, { kind: 'merging' }, { kind: 'terminal' }],
      });
      const forwardColNames = [...new Set(forwardCols.map((c: any) => c.name).filter(Boolean))];
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
            .filter((r: any) => r.ticket_id && new Date(r.advanced_at) >= enteredAtByTicket.get(r.ticket_id)!)
            .map((r: any) => r.ticket_id),
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
  const misclassified = pendRows.filter((r: any) => r.terminal_entered_at && new Date(r.terminal_entered_at) < new Date(r.pend_at)).length;
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
  const completed = created.filter((t: any) => !!t.terminal_entered_at).length;
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
