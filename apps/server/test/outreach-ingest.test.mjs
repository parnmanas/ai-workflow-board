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

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { Workspace } from '../dist/entities/Workspace.js';
import { Board } from '../dist/entities/Board.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachInboundItem } from '../dist/entities/OutreachInboundItem.js';
import { OutreachIngestService } from '../dist/modules/outreach/outreach-ingest.service.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };
const noopActivity = { async logActivity() { return {}; } };
const noopRoleAssignment = { async applyBoardDefaults() { return []; } };

function makeClassifier(map, fallback = { category: 'noise', confidence: 60 }) {
  return {
    async classify(item) {
      return map[item.external_item_id] || fallback;
    },
  };
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
    entities: [Workspace, Board, BoardColumn, Ticket, Comment, OutreachChannel, OutreachInboundItem],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedBoard(dataSource, workspaceId) {
  const wsRepo = dataSource.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ id: workspaceId, name: workspaceId }));
  const boardRepo = dataSource.getRepository(Board);
  const board = await boardRepo.save(boardRepo.create({ workspace_id: workspaceId, name: 'board' }));
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

function makeService(dataSource, classifier) {
  const itemRepo = dataSource.getRepository(OutreachInboundItem);
  const channelRepo = dataSource.getRepository(OutreachChannel);
  return new OutreachIngestService(itemRepo, channelRepo, dataSource, noopRoleAssignment, noopActivity, noopLog, classifier);
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
