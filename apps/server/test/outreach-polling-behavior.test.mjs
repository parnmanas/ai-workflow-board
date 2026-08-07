// Behavioral test for OutreachPollingService.runOnce() (ticket 2500fea3 D2) —
// drives the scheduler sweep against in-memory stub repos with a fixed `now`,
// mirroring qa-schedule-behavior.test.mjs's shape exactly (same tick-loop
// idiom, same stub-repo pattern). Covers:
//
//   • a due channel is polled via OutreachIngestService.pollChannel and
//     next_poll_at advances.
//   • idempotency — next_poll_at is advanced BEFORE the poll, so a second
//     sweep at the SAME `now` polls nothing (cursor moved past).
//   • disabled channel is never swept (negative case).
//   • orphan self-heal — an enabled channel with next_poll_at=null gets a
//     cursor computed forward WITHOUT polling on the same sweep.
//   • one channel's poll failure does not block another channel in the same
//     sweep, and its cursor still advances (retries next occurrence, not
//     every tick).
//   • a channel whose credential fails to resolve is marked failed, not
//     crashed — pollChannel is never reached.
//   • computeNextPoll: cron overrides interval_ms; falls back to interval_ms
//     otherwise.
//
// Imports the compiled service from dist/ (built by `npm run build`) and
// injects stub repos + a pollChannel spy — the seams the service exposes via
// its constructor and the `now` param on runOnce()/computeNextPoll().

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutreachPollingService } from '../dist/modules/outreach/outreach-polling.service.js';
import { RedditConnector } from '../dist/modules/outreach/connectors/reddit.connector.js';
import { FakeOutreachConnector } from '../dist/modules/outreach/connectors/fake.connector.js';

const MIN = 60_000;
const NOW = new Date('2026-06-25T12:00:00Z');

const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

// Stub channel repo over a plain-object row array. Handles the two find
// shapes runOnce uses: { enabled, next_poll_at: IsNull() } and
// { enabled, next_poll_at: LessThanOrEqual(now) } (+ order/take). save() is a
// no-op recorder — the service mutates the same row reference it read.
function makeChannelRepo(rows) {
  return {
    rows,
    saves: [],
    async find(opts = {}) {
      const where = opts.where || {};
      const op = where.next_poll_at; // a TypeORM FindOperator or undefined
      let res = rows.filter((r) => {
        if (where.enabled !== undefined && r.enabled !== where.enabled) return false;
        if (op) {
          const threshold = op._value;
          if (threshold === undefined || threshold === null) {
            if (r.next_poll_at !== null && r.next_poll_at !== undefined) return false;
          } else {
            const thresh = new Date(threshold).getTime();
            if (!(r.next_poll_at && new Date(r.next_poll_at).getTime() <= thresh)) return false;
          }
        }
        return true;
      });
      if (opts.order?.next_poll_at) {
        res = res.slice().sort((a, b) => new Date(a.next_poll_at) - new Date(b.next_poll_at));
      }
      if (opts.take) res = res.slice(0, opts.take);
      return res;
    },
    async save(row) {
      this.saves.push(row.id);
      return row;
    },
  };
}

function makeCredentialRepo(rows = []) {
  return {
    async findOne({ where }) {
      return rows.find((r) => r.id === where.id) || null;
    },
  };
}

// pollChannel spy — records every call (including the resolved connector, so
// tests can assert kind→class selection); throws for channels named in failMap.
function makeIngestService(failMap = {}) {
  const calls = [];
  return {
    calls,
    async pollChannel(channel, connector, now) {
      calls.push({ channel_id: channel.id, now, connector });
      if (failMap[channel.id]) throw new Error(`simulated failure for ${channel.id}`);
      return { fetched: 0, ticketed: 0, noise: 0, question: 0, held: 0, skipped: 0, errors: 0 };
    },
  };
}

function makeChannel(over = {}) {
  return {
    id: 'ch-1',
    workspace_id: 'ws-1',
    kind: 'github',
    credential_id: null,
    enabled: true,
    poll_interval_ms: 30 * MIN,
    poll_cron: null,
    next_poll_at: new Date(NOW.getTime() - MIN), // due (1 min ago)
    last_poll_at: null,
    since_cursor: '',
    ...over,
  };
}

function svcWith(rows, failMap = {}, credentialRows = []) {
  const channelRepo = makeChannelRepo(rows);
  const credentialRepo = makeCredentialRepo(credentialRows);
  const ingestService = makeIngestService(failMap);
  const svc = new OutreachPollingService(channelRepo, credentialRepo, ingestService, noopLog);
  return { svc, channelRepo, credentialRepo, ingestService };
}

test('a due channel is polled via ingestService.pollChannel and next_poll_at advances', async () => {
  const ch = makeChannel();
  const { svc, ingestService } = svcWith([ch]);

  const { polled, failed } = await svc.runOnce(NOW);

  assert.deepEqual(polled, ['ch-1'], 'the due channel is polled');
  assert.deepEqual(failed, [], 'nothing failed');
  assert.equal(ingestService.calls.length, 1, 'pollChannel called once');
  assert.equal(ingestService.calls[0].channel_id, 'ch-1');
  assert.ok(new Date(ch.next_poll_at).getTime() > NOW.getTime(), 'next_poll_at moved into the future');
  assert.equal(new Date(ch.next_poll_at).getTime(), NOW.getTime() + 30 * MIN, 'next_poll_at = now + interval');
});

test('idempotency: a second sweep at the same `now` polls nothing (cursor already advanced)', async () => {
  const ch = makeChannel();
  const { svc, ingestService } = svcWith([ch]);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.polled, ['ch-1'], 'first sweep polls');

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.polled, [], 'second sweep at same now polls nothing — next_poll_at is past now');
  assert.equal(ingestService.calls.length, 1, 'pollChannel still called exactly once total');
});

test('disabled channel is never swept even when overdue', async () => {
  const ch = makeChannel({ enabled: false, next_poll_at: new Date(NOW.getTime() - 60 * MIN) });
  const { svc, ingestService } = svcWith([ch]);

  const { polled } = await svc.runOnce(NOW);
  assert.deepEqual(polled, [], 'disabled channel not polled');
  assert.equal(ingestService.calls.length, 0, 'pollChannel never called');
});

test('orphan self-heal: enabled channel with next_poll_at=null gets a cursor WITHOUT polling', async () => {
  const ch = makeChannel({ next_poll_at: null });
  const { svc, ingestService } = svcWith([ch]);

  const { polled } = await svc.runOnce(NOW);
  assert.deepEqual(polled, [], 'orphan is not polled on the heal sweep');
  assert.equal(ingestService.calls.length, 0, 'pollChannel not called');
  assert.ok(ch.next_poll_at instanceof Date, 'next_poll_at computed forward');
  assert.equal(new Date(ch.next_poll_at).getTime(), NOW.getTime() + 30 * MIN, 'cursor = now + interval');
});

test('one channel poll failure does not block another channel in the same sweep', async () => {
  const bad = makeChannel({ id: 'ch-bad' });
  const good = makeChannel({ id: 'ch-good' });
  const { svc, ingestService } = svcWith([bad, good], { 'ch-bad': true });

  const { polled, failed } = await svc.runOnce(NOW);
  assert.deepEqual(failed, ['ch-bad'], 'the failing channel is reported failed');
  assert.deepEqual(polled, ['ch-good'], 'the other channel still polls successfully');
  assert.equal(ingestService.calls.length, 2, 'both channels were attempted');
  // Cursor still advances on failure — the bad channel retries next
  // occurrence instead of spinning on the same failure every tick.
  assert.ok(new Date(bad.next_poll_at).getTime() > NOW.getTime(), "the failed channel's cursor still advanced");
});

test('a channel whose credential fails to resolve is marked failed, not crashed', async () => {
  const ch = makeChannel({ credential_id: 'missing-cred' });
  // No matching row in the stub credential repo — resolveOutreachCredential
  // throws "does not exist", caught by the sweep's per-channel try/catch.
  const { svc, ingestService } = svcWith([ch]);

  const { polled, failed } = await svc.runOnce(NOW);
  assert.deepEqual(failed, ['ch-1']);
  assert.deepEqual(polled, []);
  assert.equal(ingestService.calls.length, 0, 'pollChannel is never reached when credential resolution fails');
});

test('computeNextPoll: cron overrides interval_ms; falls back to interval_ms otherwise', () => {
  const { svc } = svcWith([]);
  const cronNext = svc.computeNextPoll({ poll_cron: '0 3 * * *', poll_interval_ms: 30 * MIN }, new Date('2026-06-25T02:00:00Z'));
  assert.equal(cronNext.toISOString(), '2026-06-25T03:00:00.000Z', 'cron next firing');
  const intervalNext = svc.computeNextPoll({ poll_cron: null, poll_interval_ms: 15 * MIN }, NOW);
  assert.equal(intervalNext.getTime(), NOW.getTime() + 15 * MIN, 'interval next firing');
});

// ── kind-based connector resolution (ticket d86d0c24 step 7) ────────────────

test('kind=reddit with a valid credential + targets resolves to a real RedditConnector', async () => {
  const ch = makeChannel({ kind: 'reddit', credential_id: 'cred-1', targets: ['awb'] });
  const credentialRows = [{
    id: 'cred-1', workspace_id: null,
    encrypted_data: JSON.stringify({ token: 'refresh-tok', client_id: 'cid', client_secret: 'csecret' }),
  }];
  const { svc, ingestService } = svcWith([ch], {}, credentialRows);

  const { polled, failed } = await svc.runOnce(NOW);

  assert.deepEqual(polled, ['ch-1']);
  assert.deepEqual(failed, []);
  assert.equal(ingestService.calls.length, 1);
  assert.ok(ingestService.calls[0].connector instanceof RedditConnector, 'kind=reddit resolved to RedditConnector, not the fake');
});

test('kind=github (or any non-reddit kind) still resolves to FakeOutreachConnector', async () => {
  const ch = makeChannel({ kind: 'github' });
  const { svc, ingestService } = svcWith([ch]);

  await svc.runOnce(NOW);

  assert.ok(ingestService.calls[0].connector instanceof FakeOutreachConnector);
});

test('kind=reddit with an EMPTY target whitelist fails closed — no collection, never falls back to discovery', async () => {
  const ch = makeChannel({ kind: 'reddit', credential_id: 'cred-1', targets: [] });
  const credentialRows = [{
    id: 'cred-1', workspace_id: null,
    encrypted_data: JSON.stringify({ token: 'refresh-tok', client_id: 'cid', client_secret: 'csecret' }),
  }];
  const { svc, ingestService } = svcWith([ch], {}, credentialRows);

  const { polled, failed } = await svc.runOnce(NOW);

  assert.deepEqual(polled, [], 'an empty whitelist never polls');
  assert.deepEqual(failed, ['ch-1'], 'surfaced as a failed poll, not a silent no-op, so an operator notices the missing whitelist');
  assert.equal(ingestService.calls.length, 0, 'pollChannel/connector.fetchInbound is never reached — the failure happens at connector resolution');
  // Cursor still advances (same "retries next occurrence, not every tick" contract as any other poll failure).
  assert.ok(new Date(ch.next_poll_at).getTime() > NOW.getTime());
});
