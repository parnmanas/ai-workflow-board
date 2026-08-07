// Behavioral tests for OutreachPublisherService (ticket d86d0c24 steps 5+6) —
// covers the ticket's completion criteria directly against a real in-memory
// sqljs DataSource, with a fake `globalThis.fetch` standing in for Reddit
// (kind='reddit' channels resolve to a REAL RedditConnector via
// connector-resolver.ts, so this exercises the actual production wiring, not
// a stubbed connector). The deployment-event entry point (`_onDeploymentReported`)
// is called directly rather than through the `activityEvents` EventEmitter —
// same pattern this codebase already uses for other "private" tick/handler
// methods (see supervisor-output-liveness.test.mjs's `service._tick()`,
// user-channel-dispatcher.test.mjs's `svc._handleChat()`): TS `private` does
// not survive compilation, and this IS the unit under test — the event-bus
// subscription itself is just wiring (onModuleInit/onModuleDestroy).
//
//   • idempotency (완료기준): the SAME (environment, deployed_commit_sha)
//     reported twice publishes exactly once (1 ledger row, 1 external call);
//     a DIFFERENT commit publishes again.
//   • deploy_post_mode='off' excludes the channel — no ledger row at all.
//   • publish_policy='approval' (default) creates a draft WITHOUT ever
//     calling the connector (완료기준: "승인 대기 상태에서는 실제 외부 호출이
//     일어나지 않음").
//   • approve() calls the connector exactly once and lands 'published';
//     two CONCURRENT approve() calls for the same post still call the
//     connector exactly once (single-winner conditional-UPDATE claim).
//   • approve() when the connector call fails lands the row 'failed' with
//     the error recorded, without throwing out of the endpoint.
//   • reject() is terminal — a later approve() attempt is rejected, connector
//     never called.
//   • deploy_post_mode='reply_to_existing' always replies to the fixed
//     reply_thread_ref; 'auto' posts new on the first release and replies on
//     a later one still inside auto_reuse_window_days.
//   • a GLOBAL deployment (workspace_id=null) never publishes anywhere
//     (fail-closed).

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
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { OutreachOutboundPost } from '../dist/entities/OutreachOutboundPost.js';
import { OutreachPublisherService } from '../dist/modules/outreach/outreach-publisher.service.js';
import { TemplateReleaseSummarizer } from '../dist/modules/outreach/release-summary.js';

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

async function setupDb() {
  const dataSource = new DataSource({
    type: 'sqljs',
    entities: [Workspace, Board, BoardColumn, Ticket, Comment, Credential, OutreachChannel, OutreachOutboundPost],
    synchronize: true,
    logging: false,
  });
  await dataSource.initialize();
  return dataSource;
}

async function seedCredential(dataSource, over = {}) {
  const repo = dataSource.getRepository(Credential);
  return repo.save(repo.create({
    workspace_id: null,
    board_id: null,
    name: 'reddit bot',
    description: '',
    provider: 'reddit',
    encrypted_data: JSON.stringify({ token: 'refresh-tok', client_id: 'cid', client_secret: 'csecret' }),
    ...over,
  }));
}

async function seedChannel(dataSource, credentialId, over = {}) {
  const repo = dataSource.getRepository(OutreachChannel);
  return repo.save(repo.create({
    workspace_id: 'ws-1',
    kind: 'reddit',
    name: 'test channel',
    targets: ['awb'],
    credential_id: credentialId,
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
    deploy_post_mode: 'new_post',
    reply_thread_ref: null,
    auto_reuse_window_days: 30,
    ...over,
  }));
}

function makeService(dataSource) {
  return new OutreachPublisherService(dataSource, noopLog, new TemplateReleaseSummarizer());
}

function signal(over = {}) {
  return {
    deployment_id: 'dep-1',
    workspace_id: 'ws-1',
    environment: 'production',
    deployed_commit_sha: 'sha-aaa',
    deployed_at: new Date('2026-06-25T12:00:00Z'),
    ...over,
  };
}

const REAL_FETCH = globalThis.fetch;
function restoreFetch() { globalThis.fetch = REAL_FETCH; }

/** Fakes Reddit's OAuth + submit/comment endpoints. Only counts calls to
 *  /api/submit and /api/comment — the actual external side-effecting calls
 *  ("did we post to Reddit"), not the OAuth token fetch. */
function installFakeRedditFetch({ fail = false } = {}) {
  let calls = 0;
  const okHeaders = { get: () => null };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u === 'https://www.reddit.com/api/v1/access_token') {
      return { ok: true, status: 200, headers: okHeaders, json: async () => ({ access_token: 'tok', expires_in: 3600 }), text: async () => '' };
    }
    if (u.includes('/api/submit')) {
      calls++;
      if (fail) return { ok: false, status: 500, headers: okHeaders, json: async () => ({}), text: async () => 'boom' };
      return {
        ok: true, status: 200, headers: okHeaders,
        json: async () => ({ json: { errors: [], data: { name: `t3_post${calls}`, url: `/r/awb/comments/post${calls}/x` } } }),
        text: async () => '',
      };
    }
    if (u.includes('/api/comment')) {
      calls++;
      if (fail) return { ok: false, status: 500, headers: okHeaders, json: async () => ({}), text: async () => 'boom' };
      return {
        ok: true, status: 200, headers: okHeaders,
        json: async () => ({ json: { errors: [], data: { things: [{ data: { name: `t1_reply${calls}`, permalink: `/r/awb/comments/x/y/reply${calls}` } }] } } }),
        text: async () => '',
      };
    }
    throw new Error(`unexpected reddit url in publish-behavior test: ${u}`);
  };
  return { callCount: () => calls };
}

test('idempotency: the SAME (environment, commit) reported twice publishes exactly once', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'auto', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal());
      await svc._onDeploymentReported(signal()); // same env + sha, re-triggered
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1, 'exactly one ledger row for the same (environment, commit)');
    assert.equal(rows[0].status, 'published');
    assert.equal(fake.callCount(), 1, 'the connector was called exactly once — no duplicate post');
  } finally { await dataSource.destroy(); }
});

test('a DIFFERENT commit publishes again — not deduped against the previous release', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'auto', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal({ deployed_commit_sha: 'sha-aaa' }));
      await svc._onDeploymentReported(signal({ deployed_commit_sha: 'sha-bbb' }));
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 2);
    assert.equal(fake.callCount(), 2);
  } finally { await dataSource.destroy(); }
});

test('deploy_post_mode=off excludes the channel entirely — no ledger row created', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'auto', deploy_post_mode: 'off' });
    const svc = makeService(dataSource);
    await svc._onDeploymentReported(signal());

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 0);
  } finally { await dataSource.destroy(); }
});

test('publish_policy=approval (default) creates a draft WITHOUT ever calling the connector', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'approval', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal());
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'draft');
    assert.equal(fake.callCount(), 0, 'no external call while awaiting approval');
  } finally { await dataSource.destroy(); }
});

test('approve() on a draft calls the connector exactly once and lands published', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'approval', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    await svc._onDeploymentReported(signal());
    const draft = (await dataSource.getRepository(OutreachOutboundPost).find())[0];

    const fake = installFakeRedditFetch();
    let approved;
    try {
      approved = await svc.approve(draft.id, channel.workspace_id);
    } finally { restoreFetch(); }

    assert.equal(approved.status, 'published');
    assert.ok(approved.permalink);
    assert.equal(fake.callCount(), 1);
  } finally { await dataSource.destroy(); }
});

test('two CONCURRENT approve() calls for the same post result in exactly one external call', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'approval', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    await svc._onDeploymentReported(signal());
    const draft = (await dataSource.getRepository(OutreachOutboundPost).find())[0];

    const fake = installFakeRedditFetch();
    let settled;
    try {
      settled = await Promise.allSettled([
        svc.approve(draft.id, channel.workspace_id),
        svc.approve(draft.id, channel.workspace_id),
      ]);
    } finally { restoreFetch(); }

    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s) => s.status === 'rejected');
    assert.equal(fulfilled.length, 1, 'exactly one approve() call wins the claim');
    assert.equal(rejected.length, 1, 'the other is rejected (already claimed), not silently ignored');
    assert.equal(rejected[0].reason?.status, 409);
    assert.equal(fake.callCount(), 1, 'the connector is called exactly once regardless of the race');
  } finally { await dataSource.destroy(); }
});

test('approve() when the connector call fails lands the post as failed with the error recorded, without throwing', async () => {
  const dataSource = await setupDb();
  try {
    // A credential id that resolves to no row forces resolveOutreachCredential
    // to throw INSIDE _executePublish — exercising the failure path without
    // needing a fetch-level fault injection.
    const channel = await seedChannel(dataSource, 'nonexistent-credential-id', { publish_policy: 'approval', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    await svc._onDeploymentReported(signal());
    const draft = (await dataSource.getRepository(OutreachOutboundPost).find())[0];

    const approved = await svc.approve(draft.id, channel.workspace_id);
    assert.equal(approved.status, 'failed');
    assert.ok(approved.error.length > 0);
  } finally { await dataSource.destroy(); }
});

test('reject() is terminal — a later approve() attempt is rejected, connector never called', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    const channel = await seedChannel(dataSource, cred.id, { publish_policy: 'approval', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    await svc._onDeploymentReported(signal());
    const draft = (await dataSource.getRepository(OutreachOutboundPost).find())[0];

    const rejected = await svc.reject(draft.id, channel.workspace_id);
    assert.equal(rejected.status, 'rejected');

    const fake = installFakeRedditFetch();
    try {
      await assert.rejects(svc.approve(draft.id, channel.workspace_id), (err) => err.status === 409);
    } finally { restoreFetch(); }
    assert.equal(fake.callCount(), 0);
  } finally { await dataSource.destroy(); }
});

test('deploy_post_mode=reply_to_existing always replies to the fixed reply_thread_ref', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, {
      publish_policy: 'auto', deploy_post_mode: 'reply_to_existing', reply_thread_ref: 't3_fixedthread',
    });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal());
    } finally { restoreFetch(); }

    const row = (await dataSource.getRepository(OutreachOutboundPost).find())[0];
    assert.equal(row.thread_ref, 't3_fixedthread');
    assert.equal(row.target, '');
    assert.equal(row.status, 'published');
    assert.equal(fake.callCount(), 1);
  } finally { await dataSource.destroy(); }
});

test('deploy_post_mode=auto posts new on the first release, replies on a later one within the reuse window', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'auto', deploy_post_mode: 'auto', auto_reuse_window_days: 30 });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal({ deployed_commit_sha: 'sha-1' }));
      await svc._onDeploymentReported(signal({ deployed_commit_sha: 'sha-2' }));
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find({ order: { created_at: 'ASC' } });
    assert.equal(rows.length, 2);
    assert.notEqual(rows[0].target, '', 'first release is a new post (no prior publish to reply to)');
    assert.equal(rows[0].thread_ref, '');
    assert.equal(rows[1].target, '', 'second release replies instead of posting new');
    assert.equal(rows[1].thread_ref, rows[0].external_item_id, 'threading stays under the first post');
    assert.equal(fake.callCount(), 2);
  } finally { await dataSource.destroy(); }
});

test('a GLOBAL deployment (workspace_id=null) never publishes to any workspace channel (fail-closed)', async () => {
  const dataSource = await setupDb();
  try {
    const cred = await seedCredential(dataSource);
    await seedChannel(dataSource, cred.id, { publish_policy: 'auto', deploy_post_mode: 'new_post' });
    const svc = makeService(dataSource);
    const fake = installFakeRedditFetch();
    try {
      await svc._onDeploymentReported(signal({ workspace_id: null }));
    } finally { restoreFetch(); }

    const rows = await dataSource.getRepository(OutreachOutboundPost).find();
    assert.equal(rows.length, 0);
    assert.equal(fake.callCount(), 0);
  } finally { await dataSource.destroy(); }
});
