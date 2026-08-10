// Behavioral tests for OutreachResolveNotifierService (ticket d86d0c24 step 8)
// against a real in-memory sqljs DataSource. `_handleActivity` is called
// directly with a plain {action, ticket_id} object — the same "call the
// private handler directly, the event-bus subscription is just wiring"
// convention this codebase already uses (see supervisor-output-liveness.test.mjs's
// `service._tick()`, outreach-publish-behavior.test.mjs's `svc._onDeploymentReported()`).
//
//   • a Done ticket with an outreach backlink replies according to the
//     channel's publish_policy — 'approval' → a draft (no external call);
//     'auto' → published (exactly one external call).
//   • re-entering Done (a duplicate 'moved' activity for the SAME item) never
//     fires a second reply — idempotency rides the OutreachOutboundPost
//     (channel_id, dedupe_key) unique index, not a ticket column.
//   • a Done ticket with NO outreach backlink is a total no-op.
//   • publish_policy='off' never creates a ledger row.
//   • this hook's idempotency is independent of `Ticket.on_done_dispatched_at`
//     (the on-ticket-done Action hook's OWN claim column, C3) — pre-setting
//     that column does not block this service, proving the two hooks cannot
//     starve each other.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataSource } from 'typeorm';
import { Workspace } from '../dist/entities/Workspace.js';
import { Board } from '../dist/entities/Board.js';
import { BoardColumn } from '../dist/entities/BoardColumn.js';
import { Ticket } from '../dist/entities/Ticket.js';
import { Comment } from '../dist/entities/Comment.js';
import { Credential } from '../dist/entities/Credential.js';
import { Deployment } from '../dist/entities/Deployment.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachInboundItem } from '../dist/entities/OutreachInboundItem.js';
import { OutreachOutboundPost } from '../dist/entities/OutreachOutboundPost.js';
import { OutreachResolveNotifierService } from '../dist/modules/outreach/outreach-resolve-notifier.service.js';
import { OutreachPublisherService } from '../dist/modules/outreach/outreach-publisher.service.js';
import { TemplateReleaseSummarizer } from '../dist/modules/outreach/release-summary.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

async function setupDb() {
  const dataSource = new DataSource({
    type: 'sqljs',
    entities: [Workspace, Board, BoardColumn, Ticket, Comment, Credential, Deployment, OutreachChannel, OutreachInboundItem, OutreachOutboundPost],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedTerminalColumn(dataSource) {
  const wsRepo = dataSource.getRepository(Workspace);
  await wsRepo.save(wsRepo.create({ id: 'ws-1', name: 'ws-1' }));
  const boardRepo = dataSource.getRepository(Board);
  const board = await boardRepo.save(boardRepo.create({ workspace_id: 'ws-1', name: 'board' }));
  const colRepo = dataSource.getRepository(BoardColumn);
  const doneCol = await colRepo.save(colRepo.create({
    board_id: board.id, workspace_id: 'ws-1', name: 'Done', position: 1, kind: 'terminal', is_terminal: true,
  }));
  return { board, doneCol };
}

async function seedDoneTicket(dataSource, doneCol, over = {}) {
  const repo = dataSource.getRepository(Ticket);
  return repo.save(repo.create({
    column_id: doneCol.id,
    workspace_id: 'ws-1',
    title: 'Fixed the reported bug',
    description: 'desc',
    priority: 'medium',
    labels: '[]',
    channel_ids: '[]',
    position: 0,
    source_kind: 'outreach',
    created_by: 'Outreach',
    created_by_type: 'system',
    created_by_id: '',
    terminal_entered_at: new Date('2026-06-25T12:00:00Z'),
    ...over,
  }));
}

async function seedCredential(dataSource) {
  const repo = dataSource.getRepository(Credential);
  return repo.save(repo.create({
    workspace_id: null, board_id: null, name: 'bot', description: '', provider: 'reddit',
    encrypted_data: JSON.stringify({ token: 'refresh-tok', client_id: 'cid', client_secret: 'csecret' }),
  }));
}

async function seedChannel(dataSource, credentialId, over = {}) {
  const repo = dataSource.getRepository(OutreachChannel);
  return repo.save(repo.create({
    workspace_id: 'ws-1', kind: 'reddit', name: 'ch', targets: ['awb'], credential_id: credentialId,
    enabled: true, publish_policy: 'approval', rate_limit_per_hour: 0, target_board_id: null,
    poll_interval_ms: 3600000, poll_cron: null, next_poll_at: null, last_poll_at: null,
    since_cursor: '', classify_threshold: 70, deploy_post_mode: 'off', reply_thread_ref: null,
    auto_reuse_window_days: 30,
    ...over,
  }));
}

async function seedInboundItem(dataSource, channel, ticketId, over = {}) {
  const repo = dataSource.getRepository(OutreachInboundItem);
  return repo.save(repo.create({
    workspace_id: 'ws-1', channel_id: channel.id, external_item_id: 't1_origcomment',
    classification: 'bug', confidence: 90, status: 'ticketed', ticket_id: ticketId,
    claimed_at: null, permalink: 'https://reddit.com/r/awb/comments/x/y/origcomment', author: 'reporter',
    collected_at: new Date('2026-06-25T10:00:00Z'),
    ...over,
  }));
}

async function seedGithubCredential(dataSource) {
  const repo = dataSource.getRepository(Credential);
  return repo.save(repo.create({
    workspace_id: null, board_id: null, name: 'gh-bot', description: '', provider: 'github',
    encrypted_data: JSON.stringify({ token: 'ghp_test123' }),
  }));
}

async function seedDeployment(dataSource, over = {}) {
  const repo = dataSource.getRepository(Deployment);
  return repo.save(repo.create({
    workspace_id: 'ws-1', environment: 'prod', base_url: '', repo_resource_id: '',
    deployed_commit_sha: 'a'.repeat(40), ancestor_shas: null, source: 'manual', reported_by: '',
    deployed_at: new Date('2026-06-25T13:00:00Z'),
    ...over,
  }));
}

function makeServices(dataSource) {
  const publisher = new OutreachPublisherService(dataSource, noopLog, new TemplateReleaseSummarizer());
  const notifier = new OutreachResolveNotifierService(dataSource, publisher, noopLog);
  return { publisher, notifier };
}

const REAL_FETCH = globalThis.fetch;
function restoreFetch() { globalThis.fetch = REAL_FETCH; }
function installFakeRedditFetch() {
  let calls = 0;
  const okHeaders = { get: () => null };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://www.reddit.com/api/v1/access_token') {
      return { ok: true, status: 200, headers: okHeaders, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' };
    }
    if (u.includes('/api/comment')) {
      calls++;
      return {
        ok: true, status: 200, headers: okHeaders,
        json: async () => ({ json: { errors: [], data: { things: [{ data: { name: 't1_resolvereply', permalink: '/r/awb/comments/x/y/resolvereply' } }] } } }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected reddit url in resolve-notifier test: ${u}`);
  };
  return { callCount: () => calls };
}

/** Fake fetch for GitHub-kind channels — GET /user (bot login), POST issue
 *  comment (resolve reply), PATCH issue (close_on_resolve). */
function installFakeGithubFetch() {
  const calls = { comment: 0, close: 0 };
  const okHeaders = { get: () => null };
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.endsWith('/user')) {
      return { ok: true, status: 200, headers: okHeaders, json: async () => ({ login: 'awb-bot' }), text: async () => '' };
    }
    if (u.includes('/comments') && init?.method === 'POST') {
      calls.comment++;
      return {
        ok: true, status: 201, headers: okHeaders,
        json: async () => ({ id: 999, html_url: 'https://github.com/x/y/issues/1#issuecomment-999' }),
        text: async () => '',
      };
    }
    if (init?.method === 'PATCH') {
      calls.close++;
      return { ok: true, status: 200, headers: okHeaders, json: async () => ({ number: 1, state: 'closed' }), text: async () => '' };
    }
    throw new Error(`unexpected github url in resolve-notifier test: ${u} ${init?.method || 'GET'}`);
  };
  return calls;
}

test('publish_policy=approval: a Done backlinked ticket creates a draft reply, no external call', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'approval' });
    const ticket = await seedDoneTicket(dataSource, doneCol);
    await seedInboundItem(dataSource, channel, ticket.id);
    const { notifier } = makeServices(dataSource);

    const fake = installFakeRedditFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].kind, 'resolve');
    assert.equal(rows[0].status, 'draft');
    assert.equal(rows[0].thread_ref, 't1_origcomment');
    assert.equal(rows[0].source_ticket_id, ticket.id);
    assert.match(rows[0].body, /Fixed the reported bug/);
    assert.equal(fake.callCount(), 0, 'no external call while awaiting approval');
  } finally { await dataSource.destroy(); }
});

test('publish_policy=auto: a Done backlinked ticket replies immediately, exactly one external call', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'auto' });
    const ticket = await seedDoneTicket(dataSource, doneCol);
    await seedInboundItem(dataSource, channel, ticket.id);
    const { notifier } = makeServices(dataSource);

    const fake = installFakeRedditFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'published');
    assert.equal(rows[0].external_item_id, 't1_resolvereply');
    assert.equal(fake.callCount(), 1);
  } finally { await dataSource.destroy(); }
});

test('re-entering Done for the SAME backlinked item never fires a second reply', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'auto' });
    const ticket = await seedDoneTicket(dataSource, doneCol);
    await seedInboundItem(dataSource, channel, ticket.id);
    const { notifier } = makeServices(dataSource);

    const fake = installFakeRedditFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id }); // duplicate 'moved' for the same entry
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1, 'still exactly one ledger row');
    assert.equal(fake.callCount(), 1, 'still exactly one external call');
  } finally { await dataSource.destroy(); }
});

test('a Done ticket with NO outreach backlink is a total no-op', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const ticket = await seedDoneTicket(dataSource, doneCol);
    // No OutreachInboundItem row references this ticket.
    const { notifier } = makeServices(dataSource);

    await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 0);
  } finally { await dataSource.destroy(); }
});

test('publish_policy=off never creates a ledger row', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'off' });
    const ticket = await seedDoneTicket(dataSource, doneCol);
    await seedInboundItem(dataSource, channel, ticket.id);
    const { notifier } = makeServices(dataSource);

    await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 0);
  } finally { await dataSource.destroy(); }
});

test('idempotency is independent of Ticket.on_done_dispatched_at — the on-done Action hook cannot starve this service', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'approval' });
    // Simulate the on-ticket-done Action hook having ALREADY claimed this
    // terminal entry via its own column (C3's exact race concern).
    const ticket = await seedDoneTicket(dataSource, doneCol, { on_done_dispatched_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id);
    const { notifier } = makeServices(dataSource);

    await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1, 'this hook fires regardless of on_done_dispatched_at state');
  } finally { await dataSource.destroy(); }
});

// Deployment-fact gate (ticket 31e7cd24) — kind='github' only. Reddit's
// existing "fire on terminal arrival alone" behavior (all tests above) is
// verified unchanged since none of them set target_environment.

test('github kind, target_environment configured, NO matching deployment yet: no comment is posted (evidence gate holds it pending)', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod',
    });
    const ticket = await seedDoneTicket(dataSource, doneCol);
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 0, 'no ledger row — evidence gate held, nothing claimed yet');
    assert.equal(fake.comment, 0);
  } finally { await dataSource.destroy(); }
});

test('github kind, freshness-ordering fallback (no fix-commit label): a deployment at/after Done satisfies the gate and includes evidence in the body', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod',
    });
    const ticket = await seedDoneTicket(dataSource, doneCol, { terminal_entered_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    await seedDeployment(dataSource, { environment: 'prod', deployed_at: new Date('2026-06-25T13:00:00Z'), deployed_commit_sha: 'b'.repeat(40) });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'published');
    assert.match(rows[0].body, /prod/);
    assert.match(rows[0].body, /b{12}/);
    assert.equal(fake.comment, 1);
  } finally { await dataSource.destroy(); }
});

test('github kind, fix-commit label + matching ancestor_shas satisfies the gate immediately (no freshness fallback needed)', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod',
    });
    const fixSha = 'c'.repeat(40);
    const ticket = await seedDoneTicket(dataSource, doneCol, { labels: JSON.stringify([`fix-commit:${fixSha}`]) });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    // deployed_at is BEFORE terminal_entered_at (freshness would fail), but
    // ancestor_shas includes the fix commit — the sha-based check must win.
    await seedDeployment(dataSource, {
      environment: 'prod', deployed_commit_sha: 'd'.repeat(40), ancestor_shas: [fixSha],
      deployed_at: new Date('2026-06-20T00:00:00Z'),
    });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'published');
    assert.match(rows[0].body, new RegExp(fixSha.slice(0, 12)));
    assert.equal(fake.comment, 1);
  } finally { await dataSource.destroy(); }
});

test('github kind: a deployment reported AFTER the ticket reached Done fires the previously-pending resolve', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod',
    });
    const ticket = await seedDoneTicket(dataSource, doneCol, { terminal_entered_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id }); // no deployment yet — registers pending
      let rows = await dataSource.getRepository(OutreachOutboundPost).find();
      assert.equal(rows.length, 0, 'still pending — no evidence yet');

      await seedDeployment(dataSource, { environment: 'prod', deployed_at: new Date('2026-06-25T13:00:00Z'), deployed_commit_sha: 'e'.repeat(40) });
      await notifier._onDeploymentReported({ workspace_id: 'ws-1', environment: 'prod', deployed_commit_sha: 'e'.repeat(40) });

      rows = await dataSource.getRepository(OutreachOutboundPost).find();
      assert.equal(rows.length, 1, 'the pending resolve fired once the deployment landed');
      assert.equal(rows[0].status, 'published');
      assert.equal(fake.comment, 1);
    } finally { restoreFetch(); }
  } finally { await dataSource.destroy(); }
});

test('close_on_resolve=false (default): the issue is never closed even under publish_policy=auto', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod', close_on_resolve: false,
    });
    const ticket = await seedDoneTicket(dataSource, doneCol, { terminal_entered_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    await seedDeployment(dataSource, { environment: 'prod', deployed_at: new Date('2026-06-25T13:00:00Z'), deployed_commit_sha: 'f'.repeat(40) });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    assert.equal(fake.comment, 1, 'the resolve reply was posted — evidence gate satisfied');
    assert.equal(fake.close, 0, 'close_on_resolve defaults to false — the issue was never closed');
  } finally { await dataSource.destroy(); }
});

test('close_on_resolve=true + publish_policy=auto: the issue is closed after a successful resolve reply', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'auto', target_environment: 'prod', close_on_resolve: true,
    });
    const ticket = await seedDoneTicket(dataSource, doneCol, { terminal_entered_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    await seedDeployment(dataSource, { environment: 'prod', deployed_at: new Date('2026-06-25T13:00:00Z'), deployed_commit_sha: 'a1'.repeat(20) });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    assert.equal(fake.comment, 1);
    assert.equal(fake.close, 1, 'close_on_resolve=true — the issue was closed after the reply succeeded');
  } finally { await dataSource.destroy(); }
});

test('close_on_resolve=true but publish_policy=approval: the draft is never auto-published, so close is never called either', async () => {
  const dataSource = await setupDb();
  try {
    const { doneCol } = await seedTerminalColumn(dataSource);
    const cred = await seedGithubCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, {
      kind: 'github', targets: ['x/y'], publish_policy: 'approval', target_environment: 'prod', close_on_resolve: true,
    });
    const ticket = await seedDoneTicket(dataSource, doneCol, { terminal_entered_at: new Date('2026-06-25T12:00:00Z') });
    await seedInboundItem(dataSource, channel, ticket.id, {
      external_item_id: 'issue:x/y#1', permalink: 'https://github.com/x/y/issues/1',
    });
    await seedDeployment(dataSource, { environment: 'prod', deployed_at: new Date('2026-06-25T13:00:00Z'), deployed_commit_sha: 'a2'.repeat(20) });
    const { notifier } = makeServices(dataSource);

    const fake = installFakeGithubFetch();
    try {
      await notifier._handleActivity({ action: 'moved', ticket_id: ticket.id });
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft', 'evidence satisfied, but publish_policy=approval leaves it as a draft');
    assert.equal(fake.comment, 0);
    assert.equal(fake.close, 0);
  } finally { await dataSource.destroy(); }
});
