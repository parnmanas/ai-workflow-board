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
// completion_rate 우측 절단(right-censoring) 경고 (ticket c936cee7): `completed`는
// "쿼리 실행 시점(now) 기준으로 terminal_entered_at이 set 되어 있는가"만 보고
// `until`로 bound되지 않는다. `until`이 실제 now에 가까운 호출(예: before/after
// 비교에서 after 윈도우의 until=측정 시각)에서는 창 끝자락에 생성된 티켓이
// 완료할 시간을 거의 못 받은 채 "미완료"로 잡혀, 실제 프로세스 품질과 무관하게
// completion_rate가 구조적으로 낮게 나올 수 있다. 완전히 과거로 지나간 창은 이
// 편향이 없다 — 두 창을 나란히 비교할 때 이 비대칭이 착시를 만든다.
// `maturationBufferHours`를 넘기면 `created_at`이 `until - buffer`보다 늦은
// (즉 창 끝까지 buffer만큼의 여유를 못 받은) 티켓을 분모·분자에서 제외해
// 완화할 수 있다 — 비교하는 두 창 모두에 동일한 버퍼를 적용해야 공정하다.
// 넘기지 않으면 기존 동작과 100% 동일(하위호환 기본값).
//
// Two non-obvious ActivityLog shape gotchas this works around:
//   - `field_changed='column'` rows store the COLUMN NAME in old/new_value
//     (`ticket-move.ts`), NOT the column id — matching must be by name. This
//     means the column-KIND lookup itself must also be scoped to the calling
//     workspace's boards — otherwise a same-named column belonging to a
//     DIFFERENT workspace can leak its `kind` classification into this
//     workspace's name-matching (e.g. workspace B has an `active`-kind column
//     named "Conflict"; workspace A's ActivityLog rows recording a move into
//     ITS OWN, differently-classified "Conflict" column would then be
//     misclassified as an active-column entry). BoardColumn has no reliable
//     own `workspace_id` (see below) so scoping goes through an inner join to
//     Board.workspace_id instead.
//   - ActivityLog.workspace_id is frequently left at its '' default — never
//     filter ActivityLog by its own `workspace_id` column; always scope
//     through an inner join to Ticket.workspace_id instead, which IS reliably
//     populated on every ticket row. BoardColumn.workspace_id has the same
//     problem (columns.controller.ts never sets it on create) — scope
//     BoardColumn queries through Board.workspace_id instead, which IS set
//     at board creation.
//
// `entities` is passed in (rather than imported here) so callers with their
// own DataSource + entity metadata (compiled dist/ classes on both the CLI
// and builtin-Function paths) share identical metadata with their own
// DataSource instance.
export async function computeReport(
  ds: DataSource,
  entities: { ActivityLog: any; Comment: any; Ticket: any; BoardColumn: any; Board: any },
  { since, until, workspaceId, maturationBufferHours }: { since?: Date; until?: Date; workspaceId?: string; maturationBufferHours?: number } = {},
): Promise<Record<string, any>> {
  const { ActivityLog, Comment, Ticket, BoardColumn, Board } = entities;
  const untilResolved = until ?? new Date();
  const sinceResolved = since ?? new Date(untilResolved.getTime() - 30 * 24 * 60 * 60 * 1000);
  const range = { since: sinceResolved, until: untilResolved };

  // Postgres type coercion: Board.id / Ticket.id are uuid PKs
  // (@PrimaryGeneratedColumn('uuid')) while the FK columns joined against them
  // below (BoardColumn.board_id, ActivityLog.ticket_id, Comment.ticket_id) are
  // declared varchar (SQLite compat) — `uuid = varchar` has no implicit cast on
  // Postgres ("operator does not exist: uuid = character varying").
  //
  // The FK side isn't reliably varchar though: BoardColumn.board_id and
  // Comment.ticket_id are EACH ALSO the @JoinColumn target of a @ManyToOne
  // relation declared later in the same class (BoardColumn.board,
  // Comment.ticket). TypeORM's synchronize resolves a column referenced by
  // both a plain @Column and a @JoinColumn to the RELATION's type — the
  // referenced uuid PK — silently overriding the earlier explicit varchar
  // declaration. So on a freshly-synchronized schema those two FK columns
  // land as `uuid`, not `varchar`, and casting only the PK side
  // (`b.id::text = board_id`) fails with "operator does not exist:
  // text = uuid" (confirmed via prompt-audit-report-pg-cast.test.mjs).
  // ActivityLog.ticket_id has no competing relation and stays varchar either
  // way. Casting BOTH sides to text sidesteps the ambiguity regardless of
  // which physical type a given FK column resolved to. SQLite is loose-typed
  // and needs no cast — txt is empty there. Same pattern as
  // agent-workload.service.ts:196-197 / room-membership.service.ts:56-58,
  // extended to both operands.
  const isPostgres = ds.options.type === 'postgres';
  const txt = isPostgres ? '::text' : '';

  const scopeByTicketWorkspace = (qb: any, ticketAlias: string) => {
    if (workspaceId) qb.andWhere(`${ticketAlias}.workspace_id = :wsId`, { wsId: workspaceId });
    return qb;
  };

  // BoardColumn.workspace_id is not reliably populated (see doc comment
  // above) — scope through an inner join to Board.workspace_id instead.
  const scopeColumnsByWorkspace = (qb: any, columnAlias: string) => {
    qb.innerJoin(Board, 'b', `b.id${txt} = ${columnAlias}.board_id${txt}`);
    if (workspaceId) qb.andWhere('b.workspace_id = :wsId', { wsId: workspaceId });
    return qb;
  };

  // ── Metric 1: start_rate ────────────────────────────────────────────────
  // `field_changed='column'` stores the COLUMN NAME (not id) in old/new_value
  // (ticket-move.ts) — match by name. Scope by workspace via an inner join to
  // Ticket, since ActivityLog.workspace_id is not reliably populated for
  // these rows.
  const activeCols = await scopeColumnsByWorkspace(
    ds.getRepository(BoardColumn).createQueryBuilder('c').where("c.kind = 'active'"),
    'c',
  ).getMany();
  const activeColNames = [...new Set(activeCols.map((c: any) => c.name).filter(Boolean))];
  const startRate: { entered_active: number; also_advanced: number; rate: number | null } = { entered_active: 0, also_advanced: 0, rate: null };
  if (activeColNames.length > 0) {
    // Reference "start" instant per ticket = EARLIEST active-column entry in
    // the window (MIN, not MAX — a ticket may bounce in and out of active
    // more than once in-window; the first entry is when it started work).
    const enteredRows = await scopeByTicketWorkspace(
      ds.getRepository(ActivityLog).createQueryBuilder('a')
        .innerJoin(Ticket, 't', `t.id${txt} = a.ticket_id${txt}`)
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
      const forwardCols = await scopeColumnsByWorkspace(
        ds.getRepository(BoardColumn).createQueryBuilder('c')
          .where('c.kind IN (:...kinds)', { kinds: ['review', 'merging', 'terminal'] }),
        'c',
      ).getMany();
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
      .innerJoin(Ticket, 't', `t.id${txt} = c.ticket_id${txt}`)
      .where("c.author_type = 'agent' AND c.type = 'question'")
      .andWhere('c.created_at >= :since AND c.created_at < :until', range),
    't',
  ).getCount();

  // ── Metric 3: pending_misclassification_rate ────────────────────────────
  // Single joined query pulls the ticket's terminal_entered_at alongside each
  // pend event (avoids the N+1 per-event findOne of an earlier draft).
  const pendRows = await scopeByTicketWorkspace(
    ds.getRepository(ActivityLog).createQueryBuilder('a')
      .innerJoin(Ticket, 't', `t.id${txt} = a.ticket_id${txt}`)
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
  const createdInWindow = await createdQb.getMany();
  // maturationBufferHours 완화(ticket c936cee7, 위 우측 절단 경고 참고) — 명시
  // 전달했을 때만 적용, 미전달 시 createdInWindow 전체를 그대로 쓴다(기존 동작).
  const maturationCutoff = maturationBufferHours !== undefined && maturationBufferHours !== null
    ? new Date(untilResolved.getTime() - Math.max(0, maturationBufferHours) * 60 * 60 * 1000)
    : null;
  const created = maturationCutoff
    ? createdInWindow.filter((t: any) => new Date(t.created_at) < maturationCutoff)
    : createdInWindow;
  const completed = created.filter((t: any) => !!t.terminal_entered_at).length;
  const completionRate: Record<string, any> = {
    created: created.length,
    completed,
    rate: created.length > 0 ? completed / created.length : null,
  };
  if (maturationCutoff) completionRate.excluded_for_maturation = createdInWindow.length - created.length;

  return {
    window: { since: sinceResolved.toISOString(), until: untilResolved.toISOString() },
    workspace_id: workspaceId || null,
    start_rate: startRate,
    unnecessary_questions: unnecessaryQuestions,
    pending_misclassification_rate: pendingMisclassificationRate,
    completion_rate: completionRate,
  };
}
