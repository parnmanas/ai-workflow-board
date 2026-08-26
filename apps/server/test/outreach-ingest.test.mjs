// Behavioral tests for OutreachIngestService.pollChannel (ticket 2500fea3) —
// covers the ticket's completion criteria directly against a real in-memory
// sqljs DataSource (Board/BoardColumn/Ticket/OutreachChannel/OutreachInboundItem)
// with a stub connector + stub classifier injected (no tick loop, no HTTP).
//
//   • bug/feature item → ticket created with the fixed description header +
//     source labels (e2e criterion).
//   • the SAME external item polled twice creates exactly one ticket — proven
//     against the (channel_id, external_item_id) unique index directly, not
//     incidentally via cursor advancement (dedupe criterion).
//   • noise / question classifications never create a ticket (noise criterion).
//   • confidence below the channel's threshold holds the item instead of
//     ticketing or discarding it.
//   • a brand-new service instance reading the SAME persisted channel/item
//     rows ("restart") continues from the durable cursor — no re-collection,
//     no gap (restart criterion).
//   • a per-item processing error does not crash the poll and freezes the
//     cursor before the failure point, so the item is retried, not lost.
//   • two overlapping polls racing on the SAME external item (Promise.all,
//     real sqljs unique index) still produce exactly one ticket and one
//     ledger row (review fix).
//   • 리뷰 2차 지적, 5차 지적으로 재설계: 티켓 생성 성공 후 ledger 연결
//     (UPDATE)이 실패해도 커밋된 티켓은 삭제하지 않고 그대로 둔다(보상삭제
//     자체가 실패할 수 있다는 5차 지적 — fail-open). 대신 operational_dedupe_key
//     유니크 인덱스가 "이 외부 항목엔 티켓 1개"를 DB 레벨로 보장하므로,
//     재폴링이 같은 키로 그 티켓을 찾아 연결한다 — 정확히 티켓 1개·ledger
//     1개로 수렴하고, role assignment/activity도 최초 성공한 시도에서만
//     한 번 실행된다(재시도가 중복 실행하지 않음).
//   • 리뷰 2차 지적: claim 직후 중단되었거나 링크에 실패한 ticket_id=null
//     정체 claim은 다음 poll에서 skip되지 않고 정상적으로 재claim·티켓화된다.
//   • 리뷰 3차 지적: lease가 아직 유효한(방금 claim된) ticket_id=null 행은
//     "정체"가 아니라 "처리 중"으로 취급되어 삭제되지 않는다 — 결정론적
//     barrier로 A가 _createTicket 실행 중일 때 B를 진입시켜, 최종 티켓
//     1개·ledger 1개만 남는 것을 증명한다(레이스 재현에 우연한 스케줄링에
//     기대지 않음).
//   • 리뷰 5차 지적: 두 claim이 동시에 _createTicket()에 도달해도(lease
//     takeover 등) Ticket 테이블의 operational_dedupe_key 유니크 인덱스가
//     둘째 INSERT 자체를 막는다 — 이미 존재하는 open 티켓과 dedupe key가
//     충돌하면 새로 만들지 않고 그 티켓을 찾아 연결한다.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { Workspace } from '../dist/entities/Workspace.js';
import { Board } from '../dist/entities/Board.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { TicketDuplicateDecision } from '../dist/entities/TicketDuplicateDecision.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachInboundItem } from '../dist/entities/OutreachInboundItem.js';
import { OutreachIngestService, STALE_CLAIM_LEASE_MS } from '../dist/modules/outreach/outreach-ingest.service.js';
import { TicketDuplicateService } from '../dist/modules/tickets/ticket-duplicate.service.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
// logActivityTx/emitLogged (not logActivity) — _createTicket now writes the
// creation Activity row via the SAME transaction as the Ticket/duplicate-audit
// insert (ticket 7cf4f936 review fix), the same manager-scoped pattern
// ActivityService already uses elsewhere; emitLogged fires the SSE event only
// after that transaction commits. The stub DataSource here has no ActivityLog
// entity registered, so these stay pure call-recorders, never touching `manager`.
const noopActivity = { async logActivityTx() { return {}; }, emitLogged() {} };
const noopRoleAssignment = { async applyBoardDefaults() { return []; } };

// Call-counting variants (리뷰 5차 지적 — "고아 role/activity가 남지 않음")
// used where a test needs to prove _createTicket's post-commit side effects
// fire exactly once even across a failed-then-retried creation.
function countingActivity() {
  const calls = [];
  return {
    stub: {
      async logActivityTx(manager, payload) { calls.push(payload); return {}; },
      emitLogged() {},
    },
    calls,
  };
}
function countingRoleAssignment() {
  const calls = [];
  return {
    stub: { async applyBoardDefaults(ticketId, workspaceId, defaults) { calls.push({ ticketId, workspaceId, defaults }); return []; } },
    calls,
  };
}

function makeClassifier(map, fallback = { category: 'noise', confidence: 60 }) {
  return {
    async classify(item) {
      return map[item.external_item_id] || fallback;
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

function makeConnector(items) {
  return {
    async fetchInbound() { return items; },
    async publish() { throw new Error('not implemented in this test'); },
    async reply() { throw new Error('not implemented in this test'); },
  };
}

function item(over = {}) {
  return {
    external_item_id: 'item-1',
    title: 'default title',
    body: 'default body',
    author: 'alice',
    permalink: 'https://example.com/item-1',
    created_at: new Date('2026-06-25T10:00:00Z'),
    ...over,
  };
}

async function setupDb() {
  const dataSource = new DataSource({
    type: 'sqljs',
    entities: [Workspace, Board, BoardColumn, Ticket, Comment, TicketDuplicateDecision, OutreachChannel, OutreachInboundItem],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedBoard(dataSource, workspaceId, boardOver = {}) {
  const wsRepo = dataSource.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ id: workspaceId, name: workspaceId }));
  const boardRepo = dataSource.getRepository(Board);
  const board = await boardRepo.save(boardRepo.create({ workspace_id: workspaceId, name: 'board', ...boardOver }));
  const colRepo = dataSource.getRepository(BoardColumn);
  const col = await colRepo.save(colRepo.create({
    board_id: board.id, workspace_id: workspaceId, name: 'To Do', position: 0, kind: 'active', is_terminal: false,
  }));
  return { board, col };
}

async function seedChannel(dataSource, over = {}) {
  const repo = dataSource.getRepository(OutreachChannel);
  return repo.save(repo.create({
    workspace_id: 'ws-1',
    kind: 'github',
    name: 'test channel',
    targets: [],
    credential_id: null,
    enabled: true,
    publish_policy: 'approval',
    rate_limit_per_hour: 0,
    target_board_id: null,
    poll_interval_ms: 3600000,
    poll_cron: null,
    next_poll_at: null,
    last_poll_at: null,
    since_cursor: '',
    classify_threshold: 70,
    ...over,
  }));
}

function makeService(dataSource, classifier, { roleAssignment = noopRoleAssignment, activity = noopActivity } = {}) {
  const itemRepo = dataSource.getRepository(OutreachInboundItem);
  const channelRepo = dataSource.getRepository(OutreachChannel);
  return new OutreachIngestService(itemRepo, channelRepo, dataSource, roleAssignment, activity, noopLog, classifier);
}

test('a bug item creates a ticket with the fixed description header and source labels', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-1': { category: 'bug', confidence: 90 } });
    const connector = makeConnector([item({
      external_item_id: 'gh-1',
      title: 'App crashes on save',
      permalink: 'https://github.com/x/y/issues/1',
      author: 'reporter1',
      created_at: new Date('2026-06-25T10:00:00Z'),
    })]);
    const svc = makeService(dataSource, classifier);

    const result = await svc.pollChannel(channel, connector, new Date('2026-06-25T12:00:00Z'));
    assert.equal(result.fetched, 1);
    assert.equal(result.ticketed, 1);

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1);
    assert.match(tickets[0].title, /App crashes on save/);
    assert.ok(tickets[0].description.includes('Source: github'), 'description carries the Source header');
    assert.ok(tickets[0].description.includes('Source URL: https://github.com/x/y/issues/1'));
    assert.ok(tickets[0].description.includes('Author: reporter1'));
    assert.deepEqual(JSON.parse(tickets[0].labels), ['outreach', 'source:github']);
    assert.equal(tickets[0].column_id, col.id);
    assert.equal(tickets[0].source_kind, 'github');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'ticketed');
    assert.equal(items[0].ticket_id, tickets[0].id);
  } finally {
    await dataSource.destroy();
  }
});

test('polling the same external item twice creates only one ticket (dedupe index, not just cursor)', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    let channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-1': { category: 'bug', confidence: 90 } });
    const fixedItem = item({ external_item_id: 'gh-1', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    const first = await svc.pollChannel(channel, makeConnector([fixedItem]), new Date('2026-06-25T12:00:00Z'));
    assert.equal(first.ticketed, 1);

    // A connector stub that ignores `since` and returns the SAME item again
    // regardless of cursor state — proves the (channel_id, external_item_id)
    // unique index is what blocks the duplicate, not incidental cursor math.
    channel = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    const second = await svc.pollChannel(channel, makeConnector([fixedItem]), new Date('2026-06-25T13:00:00Z'));
    assert.equal(second.ticketed, 0, 'no second ticket created');
    assert.equal(second.skipped, 1, 'the repeat item is recognized as a dedupe skip');

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1, 'exactly one ticket total across both polls');
  } finally {
    await dataSource.destroy();
  }
});

test('a noise classification never creates a ticket', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-noise': { category: 'noise', confidence: 95 } });
    const connector = makeConnector([item({ external_item_id: 'gh-noise', created_at: new Date('2026-06-25T10:00:00Z') })]);
    const svc = makeService(dataSource, classifier);

    const result = await svc.pollChannel(channel, connector, new Date('2026-06-25T12:00:00Z'));
    assert.equal(result.noise, 1);
    assert.equal(result.ticketed, 0);

    assert.equal((await dataSource.getRepository(Ticket).find()).length, 0);
    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'noise');
    assert.equal(items[0].ticket_id, null);
  } finally {
    await dataSource.destroy();
  }
});

test('a question classification never creates a ticket either', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-q': { category: 'question', confidence: 90 } });
    const connector = makeConnector([item({ external_item_id: 'gh-q', created_at: new Date('2026-06-25T10:00:00Z') })]);
    const svc = makeService(dataSource, classifier);

    const result = await svc.pollChannel(channel, connector, new Date('2026-06-25T12:00:00Z'));
    assert.equal(result.question, 1);
    assert.equal(result.ticketed, 0);
    assert.equal((await dataSource.getRepository(Ticket).find()).length, 0);
  } finally {
    await dataSource.destroy();
  }
});

test('confidence below the channel threshold holds the item instead of ticketing or discarding', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id, classify_threshold: 80 });
    const classifier = makeClassifier({ 'gh-low': { category: 'bug', confidence: 50 } });
    const connector = makeConnector([item({ external_item_id: 'gh-low', created_at: new Date('2026-06-25T10:00:00Z') })]);
    const svc = makeService(dataSource, classifier);

    const result = await svc.pollChannel(channel, connector, new Date('2026-06-25T12:00:00Z'));
    assert.equal(result.held, 1);
    assert.equal(result.ticketed, 0);
    assert.equal(result.noise, 0);

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'held');
    assert.equal(items[0].classification, 'bug', 'the guessed category is preserved for the held queue');
    assert.equal(items[0].ticket_id, null);
  } finally {
    await dataSource.destroy();
  }
});

test('the cursor persists across a simulated restart — no re-collection, no gap', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const seededChannel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({
      'gh-1': { category: 'bug', confidence: 90 },
      'gh-2': { category: 'feature_request', confidence: 90 },
    });
    const older = item({ external_item_id: 'gh-1', created_at: new Date('2026-06-25T10:00:00Z') });
    const newer = item({ external_item_id: 'gh-2', created_at: new Date('2026-06-25T11:00:00Z') });

    // "Process 1" services the first item and durably advances the cursor.
    const svc1 = makeService(dataSource, classifier);
    const result1 = await svc1.pollChannel(seededChannel, makeConnector([older]), new Date('2026-06-25T10:30:00Z'));
    assert.equal(result1.ticketed, 1);

    const persisted = await dataSource.getRepository(OutreachChannel).findOneBy({ id: seededChannel.id });
    assert.equal(persisted.since_cursor, older.created_at.toISOString(), 'cursor durably advanced past the first item');

    // "Process 2" — a BRAND NEW service instance (simulates a process
    // restart) reading the SAME persisted channel row. The upstream source
    // still has both items available (as a real API would after a restart),
    // but fetchInbound is called with the reloaded since_cursor, so only the
    // genuinely-new item comes back.
    const svc2 = makeService(dataSource, classifier);
    const connector2 = {
      async fetchInbound(since) {
        const threshold = since ? new Date(since).getTime() : 0;
        return [older, newer].filter((i) => i.created_at.getTime() > threshold);
      },
      async publish() { throw new Error('not implemented in this test'); },
      async reply() { throw new Error('not implemented in this test'); },
    };
    const result2 = await svc2.pollChannel(persisted, connector2, new Date('2026-06-25T11:30:00Z'));
    assert.equal(result2.fetched, 1, 'only the item after the persisted cursor is refetched');
    assert.equal(result2.ticketed, 1, 'the new item is ticketed');
    assert.equal(result2.skipped, 0, 'the old item was never re-fetched, so there is nothing to dedupe here');

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 2, 'both items ticketed exactly once total across the restart');
  } finally {
    await dataSource.destroy();
  }
});

test('a per-item processing error does not crash the poll and freezes the cursor before the failure point', async () => {
  const dataSource = await setupDb();
  try {
    // No board seeded — ticket creation will throw "no board available",
    // simulating a transient failure during item processing.
    const channel = await seedChannel(dataSource, { target_board_id: null });
    const classifier = makeClassifier({ 'gh-bad': { category: 'bug', confidence: 90 } });
    const connector = makeConnector([item({ external_item_id: 'gh-bad', created_at: new Date('2026-06-25T10:00:00Z') })]);
    const svc = makeService(dataSource, classifier);

    const result = await svc.pollChannel(channel, connector, new Date('2026-06-25T12:00:00Z'));
    assert.equal(result.errors, 1);
    assert.equal(result.ticketed, 0);

    const persisted = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    assert.equal(persisted.since_cursor, '', 'cursor does not advance past a failed item');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 0, 'a failed item leaves no partial row — it is safe to retry from scratch');
  } finally {
    await dataSource.destroy();
  }
});

test('two pollChannel sweeps racing on the same external item create exactly one ticket and one ledger row', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-race': { category: 'bug', confidence: 90 } });
    const raceItem = item({ external_item_id: 'gh-race', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    // Two independent connectors both surface the SAME item, polled through
    // the SAME service/DataSource via Promise.all — simulates two
    // overlapping worker sweeps (or two overlapping poll intervals) both
    // observing the item as unprocessed before either commits a dedupe row.
    // Against the real sqljs unique index, this is the scenario the review
    // fix closes: the dedupe row is now claimed BEFORE _createTicket() runs,
    // so only one sweep can ever reach ticket creation for this item.
    const [resultA, resultB] = await Promise.all([
      svc.pollChannel(channel, makeConnector([raceItem]), new Date('2026-06-25T12:00:00Z')),
      svc.pollChannel(channel, makeConnector([raceItem]), new Date('2026-06-25T12:00:00Z')),
    ]);

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1, 'exactly one ticket created across both concurrent sweeps');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1, 'exactly one ledger row across both concurrent sweeps');
    assert.equal(items[0].status, 'ticketed');
    assert.equal(items[0].ticket_id, tickets[0].id);

    assert.equal(resultA.ticketed + resultB.ticketed, 1, 'exactly one sweep reports a ticket created');
    assert.equal(resultA.skipped + resultB.skipped, 1, 'the losing sweep reports a skip, not a silent drop or an error');
    assert.equal(resultA.errors, 0);
    assert.equal(resultB.errors, 0);
  } finally {
    await dataSource.destroy();
  }
});

test('a ledger-link failure after ticket creation leaves the ticket intact — retry finds it via the dedupe key, lands exactly one ticket, and never re-runs role/activity side effects', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1', {
      default_role_assignments: JSON.stringify({ assignee: [{ agent_id: 'agent-x' }] }),
    });
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-1': { category: 'bug', confidence: 90 } });
    const fixedItem = item({ external_item_id: 'gh-1', created_at: new Date('2026-06-25T10:00:00Z') });
    const { stub: roleAssignment, calls: roleCalls } = countingRoleAssignment();
    const { stub: activity, calls: activityCalls } = countingActivity();
    const svc = makeService(dataSource, classifier, { roleAssignment, activity });

    // Force the claim → ticket_id UPDATE step to fail on the first attempt,
    // AFTER _createTicket() has genuinely built and committed a real Ticket.
    // This is the review's scenario 1: ticket creation succeeds but linking
    // it to the claim row fails.
    //
    // 리뷰 5차 지적: 이 실패를 "고아 티켓 보상삭제"로 처리하던 기존 로직은
    // 그 삭제 자체가 실패하면(fail-open) 중복 방지가 깨졌다. 수정 후에는
    // 아예 삭제하지 않는다 — 티켓은 operational_dedupe_key를 쥔 채 그대로
    // 살아남고, 재시도가 같은 키로 그 티켓을 찾아 연결한다.
    const originalUpdate = svc.itemRepo.update.bind(svc.itemRepo);
    let updateAttempts = 0;
    svc.itemRepo.update = async (...args) => {
      updateAttempts++;
      if (updateAttempts === 1) throw new Error('simulated ledger link failure');
      return originalUpdate(...args);
    };

    const first = await svc.pollChannel(channel, makeConnector([fixedItem]), new Date('2026-06-25T12:00:00Z'));
    assert.equal(first.errors, 1, 'the injected failure surfaces as a per-item error, not a silent drop');
    assert.equal(first.ticketed, 0);

    const ticketsAfterFailure = await dataSource.getRepository(Ticket).find();
    assert.equal(ticketsAfterFailure.length, 1, 'the ticket that already committed is left intact, not compensated away');
    assert.ok(ticketsAfterFailure[0].operational_dedupe_key, 'it still carries its dedupe key so a retry can find it');

    const staleItems = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(staleItems.length, 1, 'the claim row is left in place as a stale marker');
    assert.equal(staleItems[0].status, 'ticketed');
    assert.equal(staleItems[0].ticket_id, null);

    const channelAfterFailure = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    assert.equal(channelAfterFailure.since_cursor, '', 'cursor did not advance past the failed item');

    // Retry: same item, same cursor — the stale-claim recovery path reclaims
    // the leftover row, _createTicket() collides on the dedupe key against
    // the ticket the first attempt already committed, and the retry links to
    // THAT ticket instead of building a second one.
    const second = await svc.pollChannel(channelAfterFailure, makeConnector([fixedItem]), new Date('2026-06-25T12:05:00Z'));
    assert.equal(second.ticketed, 1);

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1, 'exactly one ticket total after the retry succeeds — no duplicate');
    assert.equal(tickets[0].id, ticketsAfterFailure[0].id, 'the retry reused the SAME ticket row the first attempt created');
    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].ticket_id, tickets[0].id);

    assert.equal(activityCalls.length, 1, 'created-activity logging ran exactly once — the retry never re-entered the post-commit side effects');
    assert.equal(roleCalls.length, 1, 'board default role assignment was applied exactly once, not duplicated by the retry');
  } finally {
    await dataSource.destroy();
  }
});

test('ticket creation colliding with an existing open ticket for the same dedupe key links to it instead of creating a duplicate', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-collide': { category: 'bug', confidence: 90 } });
    const collideItem = item({ external_item_id: 'gh-collide', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    // A ticket already holds the exact dedupe key this item would compute —
    // as if a concurrent claim's poll (lease takeover) already created it.
    // Nothing in the ledger (OutreachInboundItem) references it yet, so this
    // isolates the dedupe-key collision path from any particular trigger
    // (lease takeover, a prior failed link, ...) that could produce it.
    const ticketRepo = dataSource.getRepository(Ticket);
    const preExisting = await ticketRepo.save(ticketRepo.create({
      column_id: col.id,
      workspace_id: 'ws-1',
      title: 'pre-existing ticket for this external item',
      operational_dedupe_key: `outreach:${channel.id}:gh-collide`,
    }));

    const result = await svc.pollChannel(channel, makeConnector([collideItem]), new Date('2026-06-25T12:00:00Z'));

    assert.equal(result.ticketed, 1, 'the item is recognized as ticketed via the pre-existing ticket');
    assert.equal(result.errors, 0, 'a dedupe-key collision is handled gracefully, not surfaced as an error');

    const tickets = await ticketRepo.find();
    assert.equal(tickets.length, 1, 'no duplicate ticket was created — the unique index rejected the second insert');
    assert.equal(tickets[0].id, preExisting.id);

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].ticket_id, preExisting.id, 'the ledger claim links to the pre-existing winner, not a fresh ticket');
  } finally {
    await dataSource.destroy();
  }
});

// 티켓 a565b657 — 비터미널 수동 아카이브 시 operational_dedupe_key가 남아있으면
// (레거시 데이터 또는 좁은 commit-ordering 레이스), dedupe key 충돌의 winner 조회가
// 그 비가시 티켓을 승자로 골라서는 안 된다. 링크되면 새 피드백이 조용히 사라진
// 것처럼 보인다 — 대신 이번 poll은 에러로 남고(다음 poll이 처음부터 재시도),
// 기존 archived 티켓은 그대로 둔다.
// 리뷰 지적(티켓 a565b657) — 이전 버전은 archived 홀더를 winner 조회에서
// 제외만 하고 키는 그대로 두어, 같은 외부 항목이 매 poll마다 동일 UNIQUE
// 충돌 → winner 없음 → claim 삭제를 반복하는 영구 루프였다(원래 버그보다
// 나쁨 — 피드백이 영원히 티켓화되지 않는다). 지금은 archived 홀더를
// 발견하면 키를 해제하고 정확히 1회 재시도하므로, 이 시나리오는 같은
// poll 안에서 즉시 해소된다.
test('ticket creation colliding with an ARCHIVED ticket holding the dedupe key releases the key and lands a fresh, visible ticket in the SAME poll — no permanent retry loop', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-archived-collide': { category: 'bug', confidence: 90 } });
    const collideItem = item({ external_item_id: 'gh-archived-collide', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    // Simulates a row from before archive_ticket started clearing the key on
    // manual archive (or the narrow commit-ordering race archive_ticket's fix
    // can't fully close): archived, but operational_dedupe_key still set.
    const ticketRepo = dataSource.getRepository(Ticket);
    const archivedHolder = await ticketRepo.save(ticketRepo.create({
      column_id: col.id,
      workspace_id: 'ws-1',
      title: 'archived ticket still holding the dedupe key',
      operational_dedupe_key: `outreach:${channel.id}:gh-archived-collide`,
      archived_at: new Date('2026-06-25T11:00:00Z'),
    }));

    const result = await svc.pollChannel(channel, makeConnector([collideItem]), new Date('2026-06-25T12:00:00Z'));

    assert.equal(result.errors, 0, 'the collision resolves inline via _resolveDedupeCollision — no error surfaces to the poll result');
    assert.equal(result.ticketed, 1, 'the item lands a fresh ticket in this same poll, not a later one');

    const tickets = await ticketRepo.find();
    assert.equal(tickets.length, 2, 'the archived ticket is left in place and a second, fresh ticket now exists');
    const freshTicket = tickets.find((t) => t.id !== archivedHolder.id);
    assert.ok(freshTicket, 'a new ticket distinct from the archived one was created');
    assert.equal(freshTicket.archived_at, null, 'the fresh ticket is visible on the board');
    assert.equal(freshTicket.operational_dedupe_key, `outreach:${channel.id}:gh-archived-collide`, 'the fresh ticket now holds the key');

    const reloadedHolder = await ticketRepo.findOneBy({ id: archivedHolder.id });
    assert.equal(reloadedHolder.operational_dedupe_key, null, 'the archived holder\'s key was released — it can never collide again');
    assert.ok(reloadedHolder.archived_at, 'the archived holder itself is otherwise untouched — still archived, not resurrected (policy C was rejected)');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1);
    assert.equal(items[0].ticket_id, freshTicket.id, 'the claim links to the fresh visible ticket, never to the archived one');

    // Subsequent poll of the SAME external item proves steady state: once
    // resolved, it stays resolved — no duplicate, no residual stuck state,
    // no re-processing.
    const reloadedChannel = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    const second = await svc.pollChannel(reloadedChannel, makeConnector([collideItem]), new Date('2026-06-25T13:00:00Z'));
    assert.equal(second.ticketed, 0);
    assert.equal(second.errors, 0);
    assert.equal(second.skipped, 1, 'the now-ticketed item is a plain dedupe skip on the next poll');
    assert.equal((await ticketRepo.find()).length, 2, 'still exactly two tickets — no duplicate created on repoll');
  } finally {
    await dataSource.destroy();
  }
});

test('two pollChannel sweeps racing on the SAME archived-holder collision still land exactly one fresh ticket', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-archived-race': { category: 'bug', confidence: 90 } });
    const raceItem = item({ external_item_id: 'gh-archived-race', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    const ticketRepo = dataSource.getRepository(Ticket);
    await ticketRepo.save(ticketRepo.create({
      column_id: col.id,
      workspace_id: 'ws-1',
      title: 'archived ticket still holding the dedupe key',
      operational_dedupe_key: `outreach:${channel.id}:gh-archived-race`,
      archived_at: new Date('2026-06-25T09:00:00Z'),
    }));

    // Same deterministic gate-on-reach pattern as the "lease fencing" test
    // below (board lesson: bounded polling / explicit gates, never guessed
    // settle counts) — but gating _resolveDedupeCollision instead of
    // _createTicket: both A and B's FIRST _createTicket() attempt collides
    // immediately with the pre-seeded archived holder (no need for either
    // side to finish creating anything first), so both reach the resolution
    // path and are stalled there before either has cleared the key.
    const gateA = deferred();
    const reachedA = deferred();
    const gateB = deferred();
    const reachedB = deferred();
    let callIndex = 0;
    const originalResolve = svc._resolveDedupeCollision.bind(svc);
    svc._resolveDedupeCollision = async (...args) => {
      const isFirst = callIndex === 0;
      callIndex++;
      if (isFirst) { reachedA.resolve(); await gateA.promise; }
      else { reachedB.resolve(); await gateB.promise; }
      return originalResolve(...args);
    };

    const nowA = new Date('2026-06-25T12:00:00Z');
    const pollA = svc.pollChannel(channel, makeConnector([raceItem]), nowA);
    await reachedA.promise; // A's claim is committed; A is stalled right after its INSERT collided with the archived holder

    const afterLease = new Date(nowA.getTime() + STALE_CLAIM_LEASE_MS + 5000);
    const pollB = svc.pollChannel(channel, makeConnector([raceItem]), afterLease);
    await reachedB.promise; // B reclaimed A's expired claim, re-attempted, collided with the SAME archived holder, and is now stalled too

    gateB.resolve();
    const resultB = await pollB;
    gateA.resolve();
    const resultA = await pollA;

    const tickets = await ticketRepo.find();
    const freshTickets = tickets.filter((t) => !t.archived_at);
    assert.equal(freshTickets.length, 1, 'exactly one fresh ticket across both racing resolutions — no duplicate');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1, 'exactly one ledger row');
    assert.equal(items[0].ticket_id, freshTickets[0].id);

    assert.equal(resultA.ticketed + resultB.ticketed, 1, 'exactly one sweep reports a ticket created');
    assert.equal(resultA.errors, 0);
    assert.equal(resultB.errors, 0);
  } finally {
    await dataSource.destroy();
  }
});

// End-to-end policy proof: once archive_ticket clears the key (the actual
// fix, not the legacy-data simulation above), a stale orphaned claim for the
// same external item reclaims into a BRAND-NEW visible ticket instead of
// resurrecting/attaching to the archived one.
test('an item whose original ticket was archived (dedupe key already cleared) reclaims into a fresh, visible ticket', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-reopen': { category: 'bug', confidence: 90 } });
    const fixedItem = item({ external_item_id: 'gh-reopen', created_at: new Date('2026-06-25T10:00:00Z') });

    // First attempt's ticket committed but its claim link never completed
    // (orphaned, same shape as the "stale claim" test below), and a human
    // later archived it — archive_ticket's current policy already cleared
    // operational_dedupe_key on that archive, so it's null here too.
    const ticketRepo = dataSource.getRepository(Ticket);
    const archivedTicket = await ticketRepo.save(ticketRepo.create({
      column_id: col.id,
      workspace_id: 'ws-1',
      title: 'orphan-linked ticket, later archived',
      operational_dedupe_key: null,
      archived_at: new Date('2026-06-25T11:00:00Z'),
    }));

    const itemRepo = dataSource.getRepository(OutreachInboundItem);
    await itemRepo.save(itemRepo.create({
      workspace_id: 'ws-1',
      channel_id: channel.id,
      external_item_id: 'gh-reopen',
      classification: 'bug',
      confidence: 90,
      status: 'ticketed',
      ticket_id: null,
      permalink: fixedItem.permalink,
      author: fixedItem.author,
      collected_at: fixedItem.created_at,
    }));

    const svc = makeService(dataSource, classifier);
    const result = await svc.pollChannel(channel, makeConnector([fixedItem]), new Date('2026-06-25T12:00:00Z'));

    assert.equal(result.ticketed, 1, 'the item is recovered into a brand-new ticket, not lost');

    const tickets = await ticketRepo.find();
    assert.equal(tickets.length, 2, 'the archived ticket is left untouched and a second, fresh ticket now exists');
    const freshTicket = tickets.find((t) => t.id !== archivedTicket.id);
    assert.ok(freshTicket, 'a new ticket distinct from the archived one was created');
    assert.equal(freshTicket.archived_at, null, 'the fresh ticket is visible on the board');

    const items = await itemRepo.find();
    assert.equal(items.length, 1);
    assert.equal(items[0].ticket_id, freshTicket.id, 'the claim links to the fresh visible ticket, never to the archived one');
  } finally {
    await dataSource.destroy();
  }
});

test('a still-active claim (fresh lease) is NOT reclaimed by a racing second poll — deterministic barrier, exactly one ticket', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-race2': { category: 'bug', confidence: 90 } });
    const raceItem = item({ external_item_id: 'gh-race2', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);
    const now = new Date('2026-06-25T12:00:00Z');

    // Deterministic barrier: A's claim INSERT has already committed (that
    // line runs BEFORE _createTicket is even called) when this mock's body
    // starts, so `reachedGate` only resolves once the claim row genuinely
    // exists with status='ticketed', ticket_id=null. B is only started after
    // that, so it always observes A's claim mid-flight — no scheduling luck
    // needed, unlike the earlier Promise.all race test above (which races on
    // the INSERT itself, not on this reclaim window).
    let releaseA;
    const gate = new Promise((resolve) => { releaseA = resolve; });
    let reachedGateResolve;
    const reachedGate = new Promise((resolve) => { reachedGateResolve = resolve; });
    const originalCreateTicket = svc._createTicket.bind(svc);
    svc._createTicket = async (...args) => {
      reachedGateResolve();
      await gate;
      return originalCreateTicket(...args);
    };

    const pollA = svc.pollChannel(channel, makeConnector([raceItem]), now);
    await reachedGate;

    // B starts while A's claim sits at status='ticketed', ticket_id=null,
    // claimed_at=now — freshly claimed, well inside the lease. Before the
    // fix, B's stale-claim check only looked at status/ticket_id and would
    // delete A's live claim here, then insert its own and create a SECOND
    // ticket while A (unaware) goes on to finish creating its own.
    const resultB = await svc.pollChannel(channel, makeConnector([raceItem]), now);
    assert.equal(resultB.ticketed, 0, 'B must not create a ticket for a claim that is still actively in-flight');
    assert.equal(resultB.skipped, 1, 'B recognizes the fresh claim as owned elsewhere and skips, not deletes');

    releaseA();
    const resultA = await pollA;
    assert.equal(resultA.ticketed, 1, 'A completes its own ticket creation undisturbed');

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1, 'exactly one ticket total — B did not fork a duplicate');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1, 'exactly one ledger row — A\'s claim was never deleted out from under it');
    assert.equal(items[0].status, 'ticketed');
    assert.equal(items[0].ticket_id, tickets[0].id);
  } finally {
    await dataSource.destroy();
  }
});

test('lease fencing: a real takeover after the lease actually expires still lands exactly one ticket, not two', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-fence': { category: 'bug', confidence: 90 } });
    const raceItem = item({ external_item_id: 'gh-fence', created_at: new Date('2026-06-25T10:00:00Z') });
    const svc = makeService(dataSource, classifier);

    // Unlike the fresh-lease barrier test above, this one lets the lease
    // genuinely expire: A claims and stalls inside _createTicket (gated, so
    // real elapsed time while paused stays negligible — claimed_at tracks
    // A's synthetic `now`, review 4th pass). B is then polled with a `now`
    // STALE_CLAIM_LEASE_MS+ past A's, so B's stale-claim reclaim is a real
    // lease expiry within the same synthetic clock domain, not simulated by
    // waiting on the real wall clock. B is released and runs to completion
    // BEFORE A resumes — matching the reviewer's scenario where A is still
    // stuck well after B has already taken over and finished (also sidesteps
    // sql.js's lack of real concurrent-transaction support, since
    // _createTicket's `dataSource.transaction()` calls would otherwise
    // collide if released at the same instant — see the claim-first comment
    // above about that same driver limitation). A is then resumed to prove
    // the fencing check on A's side: A's own _createTicket() runs AFTER B's
    // has already committed, so A's INSERT collides on operational_dedupe_key
    // (리뷰 5차 지적) — A never builds a second Ticket row at all. A looks up
    // B's ticket by the same key, then its final `itemRepo.update` finds it
    // lost claim ownership (0 rows affected, B's takeover deleted A's claim
    // row) and backs off with a skip instead of counting a ticket.
    const gateA = deferred();
    const reachedA = deferred();
    const gateB = deferred();
    const reachedB = deferred();
    let callIndex = 0;
    const originalCreateTicket = svc._createTicket.bind(svc);
    svc._createTicket = async (...args) => {
      const isFirst = callIndex === 0;
      callIndex++;
      if (isFirst) {
        reachedA.resolve();
        await gateA.promise;
      } else {
        reachedB.resolve();
        await gateB.promise;
      }
      return originalCreateTicket(...args);
    };

    const nowA = new Date('2026-06-25T12:00:00Z');
    const pollA = svc.pollChannel(channel, makeConnector([raceItem]), nowA);
    await reachedA.promise; // A's claim row is committed; A is stalled inside _createTicket

    const afterLease = new Date(nowA.getTime() + STALE_CLAIM_LEASE_MS + 5000);
    const pollB = svc.pollChannel(channel, makeConnector([raceItem]), afterLease);
    await reachedB.promise; // B has genuinely reclaimed A's expired claim and is now stalled too

    gateB.resolve();
    const resultB = await pollB;
    gateA.resolve();
    const resultA = await pollA;

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1, 'exactly one ticket total — A never built a second Ticket row, the dedupe key blocked its INSERT');

    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1, 'exactly one ledger row — B\'s takeover claim');
    assert.equal(items[0].status, 'ticketed');
    assert.equal(items[0].ticket_id, tickets[0].id);

    assert.equal(resultA.ticketed + resultB.ticketed, 1, 'exactly one of A/B reports a ticket created');
    assert.equal(resultA.skipped + resultB.skipped, 1, 'the fenced-out side reports a skip, not a silent drop');
    assert.equal(resultA.errors, 0, 'losing the ownership race is handled, not surfaced as an error');
    assert.equal(resultB.errors, 0);
  } finally {
    await dataSource.destroy();
  }
});

test('a stale ticket_id=null claim from before this fix is reclaimed and ticketed on the next poll, not skipped forever', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'gh-1': { category: 'bug', confidence: 90 } });
    const fixedItem = item({ external_item_id: 'gh-1', created_at: new Date('2026-06-25T10:00:00Z') });

    // Simulates a row a pre-fix build could have left behind: claimed
    // (status='ticketed') but the ticket itself never got created/linked
    // (e.g. the process died between the claim INSERT and the follow-up
    // UPDATE the old two-step design relied on).
    const itemRepo = dataSource.getRepository(OutreachInboundItem);
    await itemRepo.save(itemRepo.create({
      workspace_id: 'ws-1',
      channel_id: channel.id,
      external_item_id: 'gh-1',
      classification: 'bug',
      confidence: 90,
      status: 'ticketed',
      ticket_id: null,
      permalink: fixedItem.permalink,
      author: fixedItem.author,
      collected_at: fixedItem.created_at,
    }));

    const svc = makeService(dataSource, classifier);
    const result = await svc.pollChannel(channel, makeConnector([fixedItem]), new Date('2026-06-25T12:00:00Z'));

    assert.equal(result.ticketed, 1, 'the stuck item is recovered and ticketed, not silently skipped forever');
    assert.equal(result.skipped, 0);

    const tickets = await dataSource.getRepository(Ticket).find();
    assert.equal(tickets.length, 1);
    const items = await dataSource.getRepository(OutreachInboundItem).find();
    assert.equal(items.length, 1, 'the stale row was replaced, not left behind alongside a new one');
    assert.equal(items[0].ticket_id, tickets[0].id);
    assert.equal(items[0].status, 'ticketed');
  } finally {
    await dataSource.destroy();
  }
});

// 티켓 7cf4f936 — _createTicket이 TicketDuplicateService.assess()/record()에 실제로
// 배선됐는지 검증한다. same_channel 앵커 자체(신뢰도 계산 로직)는
// outreach-ticket-duplicate-gate.test.mjs가 이미 커버하므로, 여기서는 프로듀서
// 쪽 배선(source_chat_room_id=channel.id, 결과 필드가 실제 생성되는 Ticket row에
// 반영되는지, record()의 감사 흔적)만 검증한다.

test('같은 채널에서 문구가 다른 두 번째 리포트는 ambiguous 후보로 표면화되고 pending_user_action이 켜진다', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({
      'gh-1': { category: 'bug', confidence: 90 },
      'gh-2': { category: 'bug', confidence: 90 },
    });
    const svc = makeService(dataSource, classifier);

    const first = await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'gh-1',
      title: 'App crashes immediately on launch',
      created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    assert.equal(first.ticketed, 1);

    const persisted = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    const second = await svc.pollChannel(persisted, makeConnector([item({
      external_item_id: 'gh-2',
      title: 'Cannot start the app, it crashes every time',
      created_at: new Date('2026-06-25T11:00:00Z'),
    })]), new Date('2026-06-25T12:05:00Z'));
    assert.equal(second.ticketed, 1, '애매한 후보라도 티켓 자체는 생성된다 — 완전 무시되지 않는다');

    const tickets = await dataSource.getRepository(Ticket).find({ order: { created_at: 'ASC' } });
    assert.equal(tickets.length, 2);
    const [firstTicket, secondTicket] = tickets;
    assert.equal(firstTicket.source_chat_room_id, channel.id, '채널 배선: source_chat_room_id에 channel.id가 채워진다');
    assert.equal(secondTicket.source_chat_room_id, channel.id);
    assert.equal(secondTicket.canonical_ticket_id, null, '애매한 경우 자동링크되지 않는다');
    assert.equal(secondTicket.pending_user_action, true, '애매한 후보는 사람 확인 큐(pending_user_action)로 표면화된다');
    assert.match(secondTicket.pending_reason, /github/);
    assert.equal(secondTicket.pending_set_by, 'duplicate_decision_guard');
    assert.ok(secondTicket.pending_set_at);

    const decisions = await dataSource.getRepository(TicketDuplicateDecision).find();
    assert.equal(decisions.length, 1, 'record()가 감사용 TicketDuplicateDecision을 남긴다');
    assert.equal(decisions[0].report_ticket_id, secondTicket.id);
    assert.equal(decisions[0].candidate_ticket_id, firstTicket.id);
    assert.equal(decisions[0].outcome, 'ambiguous_pending');
    assert.deepEqual(JSON.parse(decisions[0].matched_signals), ['same_channel']);
  } finally {
    await dataSource.destroy();
  }
});

test('같은 채널에서 정규화 제목까지 동일한 두 번째 리포트는 canonical_ticket_id로 자동링크되어 독립 dispatch가 억제된다', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({
      'gh-1': { category: 'bug', confidence: 90 },
      'gh-2': { category: 'bug', confidence: 90 },
    });
    const svc = makeService(dataSource, classifier);

    const first = await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'gh-1',
      title: 'Crash on launch',
      created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    assert.equal(first.ticketed, 1);

    const persisted = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
    const second = await svc.pollChannel(persisted, makeConnector([item({
      external_item_id: 'gh-2',
      title: 'Crash on launch',
      created_at: new Date('2026-06-25T11:00:00Z'),
    })]), new Date('2026-06-25T12:05:00Z'));
    assert.equal(second.ticketed, 1);

    const tickets = await dataSource.getRepository(Ticket).find({ order: { created_at: 'ASC' } });
    assert.equal(tickets.length, 2, '중복이어도 리포트 자체는 감사를 위해 티켓화된다 — 억제는 dispatch 단계의 몫');
    const [firstTicket, secondTicket] = tickets;
    assert.equal(secondTicket.canonical_ticket_id, firstTicket.id, '동일 채널 + 동일 정규화 제목은 confidence 100로 자동링크된다');
    assert.equal(secondTicket.pending_user_action, false, '자동링크는 사람 확인 큐로 보내지 않는다');

    const decisions = await dataSource.getRepository(TicketDuplicateDecision).find();
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].outcome, 'auto_linked');

    const comments = await dataSource.getRepository(Comment).find();
    assert.ok(
      comments.some((c) => c.ticket_id === secondTicket.id && /independent dispatch is suppressed/.test(c.content)),
      'record()가 리포트 티켓에 억제 안내 코멘트를 남긴다',
    );
    assert.ok(
      comments.some((c) => c.ticket_id === firstTicket.id && /was linked to this canonical ticket/.test(c.content)),
      'record()가 canonical 티켓에도 상호 참조 코멘트를 남긴다',
    );
  } finally {
    await dataSource.destroy();
  }
});

// 리뷰 지적 (7cf4f936): Ticket INSERT가 record()보다 먼저 단독 커밋되던 구버전
// 구조에서는 record()(Decision/Comment 저장)만 실패해도 이미 커밋된 Ticket이
// operational_dedupe_key를 쥔 채 영구히 남았다 — 재폴링은 그 키로 그 "winner"
// 티켓을 찾아 claim만 연결할 뿐, record()/역할 배정/creation Activity를 다시
// 실행하지 않으므로 결손이 영구화된다. 수정 후에는 Ticket INSERT와 record()가
// 하나의 트랜잭션이라 record() 실패가 Ticket INSERT까지 통째로 롤백시키고,
// 다음 poll은 dedupe key 충돌 없이 _createTicket()을 처음부터 다시 실행해
// 전체 후처리(Decision/Comment/역할/Activity)를 정확히 한 번 완주한다.
test('record()(Decision/Comment 저장) 실패는 Ticket INSERT까지 롤백시키고, 재폴링은 전체 후처리를 정확히 한 번 완주한다', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1', {
      default_role_assignments: JSON.stringify({ assignee: [{ agent_id: 'agent-x' }] }),
    });
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({
      'gh-1': { category: 'bug', confidence: 90 },
      'gh-2': { category: 'bug', confidence: 90 },
    });
    const { stub: roleAssignment, calls: roleCalls } = countingRoleAssignment();
    const { stub: activity, calls: activityCalls } = countingActivity();
    const svc = makeService(dataSource, classifier, { roleAssignment, activity });

    // First report: nothing to match against yet, so assess() returns no
    // candidates and record() is a true no-op — this ticket exists purely to
    // give the second report something to auto-link against.
    const first = await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'gh-1',
      title: 'Crash on launch',
      created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    assert.equal(first.ticketed, 1);
    const afterFirst = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });

    // Second report: same channel + identical normalized title as the first
    // => same_channel + normalized_title => confidence 100 => canonical
    // auto-link, so recordTx will genuinely attempt BOTH a Decision save and
    // a pair of Comment saves (not an early-return no-op like the first).
    // Inject the failure on THIS attempt only, mid-transaction.
    const secondItem = item({
      external_item_id: 'gh-2',
      title: 'Crash on launch',
      created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const originalRecordTx = TicketDuplicateService.prototype.recordTx;
    let failedOnce = false;
    TicketDuplicateService.prototype.recordTx = async function (...args) {
      if (!failedOnce) {
        failedOnce = true;
        throw new Error('simulated duplicate-audit write failure (Decision/Comment save)');
      }
      return originalRecordTx.apply(this, args);
    };

    try {
      const failedAttempt = await svc.pollChannel(afterFirst, makeConnector([secondItem]), new Date('2026-06-25T12:05:00Z'));
      assert.equal(failedAttempt.errors, 1, 'the injected record() failure surfaces as a per-item error, not a silent drop');
      assert.equal(failedAttempt.ticketed, 0);

      const ticketsAfterFailure = await dataSource.getRepository(Ticket).find();
      assert.equal(
        ticketsAfterFailure.length, 1,
        'record() failing rolls back the second Ticket INSERT too — only the first (unrelated) ticket survives, no partial/incomplete ticket',
      );

      const claimAfterFailure = await dataSource.getRepository(OutreachInboundItem).findOneBy({ external_item_id: 'gh-2' });
      assert.equal(claimAfterFailure, null, 'the failed claim is deleted so the next poll retries the whole item from scratch');

      const channelAfterFailure = await dataSource.getRepository(OutreachChannel).findOneBy({ id: channel.id });
      assert.equal(channelAfterFailure.since_cursor, afterFirst.since_cursor, 'cursor does not advance past the failed second item');

      assert.equal(
        (await dataSource.getRepository(TicketDuplicateDecision).find()).length, 0,
        'no Decision row survives the rolled-back attempt',
      );
      assert.equal(
        (await dataSource.getRepository(Comment).find()).length, 0,
        'no Comment row survives the rolled-back attempt',
      );
      assert.equal(activityCalls.length, 1, 'only the first (successful) ticket logged an Activity row — the failed attempt logged none');
      assert.equal(roleCalls.length, 1, 'only the first (successful) ticket applied board default roles — the failed attempt applied none');

      // Retry: record() no longer fails.
      const retry = await svc.pollChannel(channelAfterFailure, makeConnector([secondItem]), new Date('2026-06-25T12:10:00Z'));
      assert.equal(retry.ticketed, 1, 'the retry succeeds fully once record() stops failing');

      const tickets = await dataSource.getRepository(Ticket).find({ order: { created_at: 'ASC' } });
      assert.equal(tickets.length, 2, 'exactly one ticket per report total — the failed attempt left no duplicate or orphan');
      const [firstTicket, secondTicket] = tickets;

      const items = await dataSource.getRepository(OutreachInboundItem).find();
      assert.equal(items.length, 2, 'exactly one claim row per report');
      const secondClaim = items.find((i) => i.external_item_id === 'gh-2');
      assert.equal(secondClaim.ticket_id, secondTicket.id, 'exactly one claim link for the retried report');

      const decisions = await dataSource.getRepository(TicketDuplicateDecision).find();
      assert.equal(decisions.length, 1, 'exactly one Decision row exists after the retry — record() ran exactly once for the surviving attempt');
      assert.equal(decisions[0].report_ticket_id, secondTicket.id);
      assert.equal(decisions[0].candidate_ticket_id, firstTicket.id);
      assert.equal(decisions[0].outcome, 'auto_linked');

      const comments = await dataSource.getRepository(Comment).find();
      assert.equal(comments.length, 2, 'exactly one Comment pair (report + canonical cross-reference) exists after the retry');

      assert.equal(activityCalls.length, 2, 'Activity logged exactly once for the retried report in addition to the first — never duplicated, never skipped');
      assert.equal(roleCalls.length, 2, 'board default roles applied exactly once for the retried report in addition to the first');
    } finally {
      TicketDuplicateService.prototype.recordTx = originalRecordTx;
    }
  } finally {
    await dataSource.destroy();
  }
});

// Threaded child items (ticket 31e7cd24 — e.g. a new GitHub issue comment):
// InboundItem.parent_external_item_id opts an item into "append to the
// parent's existing ticket" instead of classify/ticket-creation.

test('a threaded comment item (parent_external_item_id) whose parent is already ticketed appends a Comment instead of creating a new ticket', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    const issueItem = item({
      external_item_id: 'issue:x/y#1', title: 'Crash on save', permalink: 'https://github.com/x/y/issues/1',
      created_at: new Date('2026-06-25T10:00:00Z'),
    });
    await svc.pollChannel(channel, makeConnector([issueItem]), new Date('2026-06-25T12:00:00Z'));
    const channelAfterFirst = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const ticketsAfterFirst = await dataSource.getRepository(Ticket).find();
    assert.equal(ticketsAfterFirst.length, 1);
    const ticketId = ticketsAfterFirst[0].id;

    const commentItem = item({
      external_item_id: 'comment:x/y#1:555', parent_external_item_id: 'issue:x/y#1',
      author: 'commenter1', body: 'More details here', permalink: 'https://github.com/x/y/issues/1#issuecomment-555',
      created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const result = await svc.pollChannel(channelAfterFirst, makeConnector([commentItem]), new Date('2026-06-25T13:00:00Z'));
    assert.equal(result.appended, 1);
    assert.equal(result.ticketed, 0);

    const ticketsAfterSecond = await dataSource.getRepository(Ticket).find();
    assert.equal(ticketsAfterSecond.length, 1, 'no new ticket was created for the threaded comment');

    const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId } });
    assert.equal(comments.length, 1);
    assert.match(comments[0].content, /More details here/);
    assert.match(comments[0].content, /commenter1/);

    const items = await dataSource.getRepository(OutreachInboundItem).find({ where: { external_item_id: 'comment:x/y#1:555' } });
    assert.equal(items.length, 1);
    assert.equal(items[0].status, 'appended');
    assert.equal(items[0].ticket_id, null, 'appended child rows never carry ticket_id — resolve-notify only reacts to the root ticketed item');
  } finally {
    await dataSource.destroy();
  }
});

test('re-polling the SAME threaded comment appends exactly one Comment (idempotent)', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#1', title: 'Crash', created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));

    const commentItem = item({
      external_item_id: 'comment:x/y#1:555', parent_external_item_id: 'issue:x/y#1',
      created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const channelMid = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    await svc.pollChannel(channelMid, makeConnector([commentItem]), new Date('2026-06-25T13:00:00Z'));
    const channelAfter = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const second = await svc.pollChannel(channelAfter, makeConnector([commentItem]), new Date('2026-06-25T14:00:00Z'));

    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 1, 'the second poll dedupes via the existing OutreachInboundItem row');

    const comments = await dataSource.getRepository(Comment).find();
    assert.equal(comments.length, 1, 'exactly one appended Comment total across both polls');
  } finally {
    await dataSource.destroy();
  }
});

test('a threaded comment whose parent has not been ticketed yet (still noise) falls through and is classified as a standalone item', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    // Parent issue classifies as noise (never ticketed); the threaded comment
    // classifies as a bug on its own.
    const classifier = makeClassifier({
      'issue:x/y#2': { category: 'noise', confidence: 90 },
      'comment:x/y#2:9': { category: 'bug', confidence: 90 },
    });
    const svc = makeService(dataSource, classifier);

    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#2', title: 'Not really a bug', created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    assert.equal((await dataSource.getRepository(Ticket).find()).length, 0, 'the parent issue itself was noise — no ticket');

    const channelMid = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const result = await svc.pollChannel(channelMid, makeConnector([item({
      external_item_id: 'comment:x/y#2:9', parent_external_item_id: 'issue:x/y#2',
      title: '', body: 'Actually this is a real bug', created_at: new Date('2026-06-25T11:00:00Z'),
    })]), new Date('2026-06-25T13:00:00Z'));

    assert.equal(result.appended, 0);
    assert.equal(result.ticketed, 1, 'the comment was classified standalone since its parent never resolved to a ticket');
    assert.equal((await dataSource.getRepository(Ticket).find()).length, 1);
  } finally {
    await dataSource.destroy();
  }
});

// Issue-update items (review round 1, point 2 — connector-emitted
// `issue-update:{...}:{updated_at}`, parent_external_item_id = the issue):
// same _tryAppendToParent path as a threaded comment, but with distinct
// wording, and specifically exercising "re-polling the SAME body edit is a
// no-op, a LATER edit appends again" — the exact idempotency gap the review
// flagged (an earlier version silently dropped every body edit outright).

test('an issue-update item whose parent is already ticketed appends a Comment with update-specific wording (not "New comment")', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#1', title: 'Crash on save', created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    const ticketId = (await dataSource.getRepository(Ticket).find())[0].id;

    const channelAfterFirst = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const updateItem = item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z', parent_external_item_id: 'issue:x/y#1',
      author: 'reporter1', body: 'Updated repro steps', created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const result = await svc.pollChannel(channelAfterFirst, makeConnector([updateItem]), new Date('2026-06-25T13:00:00Z'));
    assert.equal(result.appended, 1);
    assert.equal(result.ticketed, 0, 'no second ticket for the body edit');
    assert.equal((await dataSource.getRepository(Ticket).find()).length, 1);

    const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId } });
    assert.equal(comments.length, 1);
    assert.match(comments[0].content, /Updated repro steps/);
    assert.match(comments[0].content, /updated/i, 'wording distinguishes a source-item update from a plain new comment');
    assert.doesNotMatch(comments[0].content, /^New comment on/);
  } finally {
    await dataSource.destroy();
  }
});

test('re-polling the SAME issue-update id (unchanged edit) appends exactly once (idempotent)', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#1', title: 'Crash', created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));

    const updateItem = item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z', parent_external_item_id: 'issue:x/y#1',
      body: 'edited body', created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const channelMid = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    await svc.pollChannel(channelMid, makeConnector([updateItem]), new Date('2026-06-25T13:00:00Z'));
    const channelAfter = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    // The SAME edit (same updated_at → same connector-emitted id) is polled
    // again — simulates GitHub's `since` window overlapping the previous poll.
    const second = await svc.pollChannel(channelAfter, makeConnector([updateItem]), new Date('2026-06-25T14:00:00Z'));

    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 1, 'deduped via the existing OutreachInboundItem row for this exact id');

    const comments = await dataSource.getRepository(Comment).find();
    assert.equal(comments.length, 1, 'exactly one appended Comment total across both polls');
  } finally {
    await dataSource.destroy();
  }
});

test('a LATER edit (different issue-update id) appends AGAIN — not deduped away like the unchanged-edit case', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#1', title: 'Crash', created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    const ticketId = (await dataSource.getRepository(Ticket).find())[0].id;

    const channelAfterFirst = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    await svc.pollChannel(channelAfterFirst, makeConnector([item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z', parent_external_item_id: 'issue:x/y#1',
      body: 'first edit', created_at: new Date('2026-06-25T11:00:00Z'),
    })]), new Date('2026-06-25T13:00:00Z'));

    const channelAfterSecond = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const third = await svc.pollChannel(channelAfterSecond, makeConnector([item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T15:00:00Z', parent_external_item_id: 'issue:x/y#1',
      body: 'second, later edit', created_at: new Date('2026-06-25T15:00:00Z'),
    })]), new Date('2026-06-25T16:00:00Z'));

    assert.equal(third.appended, 1, 'a genuinely later edit is a NEW id — it appends again, not deduped');
    const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId }, order: { created_at: 'ASC' } });
    assert.equal(comments.length, 2, 'both edits produced their own Comment');
    assert.match(comments[0].content, /first edit/);
    assert.match(comments[1].content, /second, later edit/);
  } finally {
    await dataSource.destroy();
  }
});

// Review round 2: GitHub bumps an issue's updated_at on ANY activity —
// including a plain new comment — so GitHubConnector.fetchInbound surfaces an
// `issue-update:...` candidate in the SAME poll as the comment's own
// `comment:...` item, even though the issue's body itself never changed. The
// pre-fix behavior appended both as separate Comments (a spurious "source
// item was updated" duplicate alongside the real new comment); this test
// exercises the content_hash guard that fixes that. The mirror scenario — a
// genuine body edit still appends, re-polling the SAME edit is a no-op, and a
// LATER distinct edit appends again — is already covered by the three
// "issue-update" tests just above (their update bodies all differ from the
// parent's seed body, so they already exercise the "changed → append" branch
// of this same guard); nothing new needed there.
test('a new comment on an old issue does not ALSO emit a spurious "source item was updated" comment when the issue body itself is unchanged', async () => {
  const dataSource = await setupDb();
  try {
    const { board } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    const issueBody = 'Steps to reproduce: click save while offline.';
    await svc.pollChannel(channel, makeConnector([item({
      external_item_id: 'issue:x/y#1', title: 'Crash on save', body: issueBody, created_at: new Date('2026-06-25T10:00:00Z'),
    })]), new Date('2026-06-25T12:00:00Z'));
    const ticketId = (await dataSource.getRepository(Ticket).find())[0].id;

    // Same poll surfaces BOTH the real new comment AND an issue-update
    // candidate whose body is IDENTICAL to what was already ticketed — the
    // exact shape GitHubConnector.fetchInbound produces when only a comment
    // triggered the issue's updated_at to move (its body always reflects the
    // CURRENT issue body, unedited here).
    const channelAfterFirst = await dataSource.getRepository(OutreachChannel).findOne({ where: { id: channel.id } });
    const commentItem = item({
      external_item_id: 'comment:x/y#1:555', parent_external_item_id: 'issue:x/y#1',
      author: 'commenter1', body: 'More details here', created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const staleUpdateItem = item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z', parent_external_item_id: 'issue:x/y#1',
      author: 'reporter1', body: issueBody, created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const result = await svc.pollChannel(channelAfterFirst, makeConnector([commentItem, staleUpdateItem]), new Date('2026-06-25T13:00:00Z'));

    assert.equal(result.appended, 1, 'only the real comment is appended');
    assert.equal(result.skipped, 1, 'the unchanged issue-update is recognized and skipped, not silently dropped or errored');
    assert.equal(result.ticketed, 0);
    assert.equal(result.errors, 0);

    const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: ticketId } });
    assert.equal(comments.length, 1, 'exactly one Comment — no spurious "source item was updated" duplicate');
    assert.match(comments[0].content, /More details here/);
    assert.ok(!comments.some((c) => /was updated/.test(c.content)), 'no "source item was updated" comment for an unchanged body');

    // The dedupe/audit ledger still records the issue-update candidate (so a
    // re-poll within the same `since` window can't reprocess it) — it just
    // never turns into a Comment.
    const updateLedgerRow = await dataSource.getRepository(OutreachInboundItem).findOne({
      where: { channel_id: channel.id, external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z' },
    });
    assert.ok(updateLedgerRow, 'the unchanged issue-update is still claimed for dedupe purposes');
  } finally {
    await dataSource.destroy();
  }
});

// Defends the OTHER direction of the same guard: an issue-update whose
// parent row predates the content_hash column (null) must still append —
// "unknown" is treated as "assume changed", never as "assume unchanged".
test('an issue-update compared against a parent with no recorded content_hash (legacy row) still appends — unknown is never treated as unchanged', async () => {
  const dataSource = await setupDb();
  try {
    const { board, col } = await seedBoard(dataSource, 'ws-1');
    const channel = await seedChannel(dataSource, { target_board_id: board.id });
    const classifier = makeClassifier({ 'issue:x/y#1': { category: 'bug', confidence: 90 } });
    const svc = makeService(dataSource, classifier);

    // Simulates a parent ticketed BEFORE this column existed: same shape
    // _processItem's claim would leave, but with content_hash left at its
    // column default (null) instead of going through the current code path.
    const itemRepo = dataSource.getRepository(OutreachInboundItem);
    const ticketRepo = dataSource.getRepository(Ticket);
    const legacyTicket = await ticketRepo.save(ticketRepo.create({
      column_id: col.id, workspace_id: 'ws-1', title: 'pre-existing legacy ticket',
    }));
    await itemRepo.save(itemRepo.create({
      workspace_id: 'ws-1', channel_id: channel.id, external_item_id: 'issue:x/y#1',
      classification: 'bug', confidence: 90, status: 'ticketed', ticket_id: legacyTicket.id,
      permalink: 'https://github.com/x/y/issues/1', author: 'reporter1', collected_at: new Date('2026-06-25T10:00:00Z'),
      content_hash: null,
    }));

    const updateItem = item({
      external_item_id: 'issue-update:x/y#1:2026-06-25T11:00:00Z', parent_external_item_id: 'issue:x/y#1',
      body: 'some body', created_at: new Date('2026-06-25T11:00:00Z'),
    });
    const result = await svc.pollChannel(channel, makeConnector([updateItem]), new Date('2026-06-25T13:00:00Z'));

    assert.equal(result.appended, 1, 'an unknown prior state must not be treated as "unchanged" — it still appends');
    const comments = await dataSource.getRepository(Comment).find({ where: { ticket_id: legacyTicket.id } });
    assert.equal(comments.length, 1);
  } finally {
    await dataSource.destroy();
  }
});
