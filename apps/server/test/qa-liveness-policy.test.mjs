// Board-pluggable QaRun liveness policy (ticket 40010b25).
//
// Covers the proposed DoD acceptance cases for replacing the single global
// zero-progress fuse with a registered, per-board liveness policy:
//   (a) a progressing heartbeat token is NOT reaped even past the deadline
//       relative to run start                                   (false-reap guard)
//   (b) a stalled token IS reaped exactly once after the deadline
//   (c) a repeated (same) token does NOT extend the deadline    (false-immortal guard,
//       enforced at qa_run_heartbeat ingestion)
//   (d) an empty-step run is NOT reaped while its token advances (false-reap guard)
//   (e) a run with no liveness_policy keeps the exact `zero_progress` TTL behavior
//
// Plus the policy registry parse/resolve contract and the never-heartbeat grace
// window. Imports the compiled modules from dist/ (built by `npm run build`).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { QaRunReaperService } from '../dist/modules/qa/qa-run-reaper.service.js';
import { QaRunService } from '../dist/modules/qa/qa-run.service.js';
import {
  parseLivenessPolicy,
  resolveLivenessPolicy,
  serializeLivenessPolicy,
  DEFAULT_LIVENESS_POLICY,
} from '../dist/modules/qa/qa-liveness-policy.js';

const SEC = 1000;
const HOUR = 60 * 60_000;
const NOW = new Date('2026-06-26T12:00:00Z');

function makeRunRepo(rows) {
  return {
    rows,
    saved: [],
    async find({ where, take }) {
      const statuses = where.status?._value || where.status?._object || ['running', 'pending'];
      return rows.filter((r) => statuses.includes(r.status)).slice(0, take ?? rows.length);
    },
    async save(row) {
      this.saved.push(row.id);
      return row;
    },
  };
}

// Scenario/Board repos: the reaper calls find({ where: { id: In([...]) } }) and
// then indexes the results by id itself, so a stub that returns its full row set
// is sufficient.
const listRepo = (rows) => ({ async find() { return rows; } });

function hbPolicy(deadlineSec) {
  return serializeLivenessPolicy({ type: 'heartbeat_deadline', deadline_sec: deadlineSec });
}

function makeRun(id, overrides = {}) {
  return {
    id,
    scenario_id: 'sc-hb',
    board_id: null,
    status: 'running',
    started_at: new Date(NOW.getTime() - 2 * HOUR),
    created_at: new Date(NOW.getTime() - 2 * HOUR),
    finished_at: null,
    step_results: [],
    liveness_token: null,
    liveness_token_at: null,
    summary: '',
    ...overrides,
  };
}

const noopLog = { info() {}, warn() {}, error() {} };
// The reaper advances any sequential batch a reaped run belonged to via
// QaRunService.onRunFinalized (5th ctor arg). These fixtures have no batch_id, so
// a no-op stub matches the real DI-injected surface.
const noopQaRunService = { onRunFinalized: async () => {} };

// ── Policy registry: parse + resolve ─────────────────────────────────────────

test('parseLivenessPolicy validates and normalizes; fails safe to null', () => {
  assert.equal(parseLivenessPolicy(null), null, 'null → null');
  assert.equal(parseLivenessPolicy(''), null, 'empty → null');
  assert.equal(parseLivenessPolicy('{not json'), null, 'bad JSON → null (never throws)');
  assert.equal(parseLivenessPolicy('{"type":"nope"}'), null, 'unknown type → null');
  assert.equal(parseLivenessPolicy('{"type":"heartbeat_deadline"}'), null, 'heartbeat without deadline → null');

  assert.deepEqual(parseLivenessPolicy('{"type":"zero_progress"}'), { type: 'zero_progress' });
  assert.deepEqual(
    parseLivenessPolicy('{"type":"zero_progress","deadline_sec":120}'),
    { type: 'zero_progress', deadline_sec: 120 },
  );
  assert.deepEqual(
    parseLivenessPolicy('{"type":"heartbeat_deadline","deadline_sec":180}'),
    { type: 'heartbeat_deadline', deadline_sec: 180 },
  );
});

test('resolveLivenessPolicy: scenario overrides board overrides default', () => {
  const scenario = hbPolicy(60);
  const board = serializeLivenessPolicy({ type: 'zero_progress', deadline_sec: 999 });

  assert.deepEqual(resolveLivenessPolicy(scenario, board), { type: 'heartbeat_deadline', deadline_sec: 60 }, 'scenario wins');
  assert.deepEqual(resolveLivenessPolicy(null, board), { type: 'zero_progress', deadline_sec: 999 }, 'board used when no scenario');
  assert.deepEqual(resolveLivenessPolicy(null, null), DEFAULT_LIVENESS_POLICY, 'default when neither set');
  // A malformed scenario policy falls through to the board, not throws.
  assert.deepEqual(resolveLivenessPolicy('{"type":"bogus"}', board), { type: 'zero_progress', deadline_sec: 999 });
});

// ── Reaper: heartbeat_deadline policy ────────────────────────────────────────

test('(a)+(d) progressing token with empty step_results is never reaped, past start-deadline', async () => {
  const scenarios = [{ id: 'sc-hb', board_id: null, liveness_policy: hbPolicy(180) }];
  const run = makeRun('live-progressing', {
    step_results: [],                                          // (d) empty steps
    liveness_token: 42,
    liveness_token_at: new Date(NOW.getTime() - 60 * SEC),     // advanced 60s ago < 180s
    started_at: new Date(NOW.getTime() - 2 * HOUR),            // run is hours old (would die under TTL)
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, [], 'a live run whose token advanced within the deadline is spared');
  assert.equal(run.status, 'running', 'status untouched');
});

test('(b) stalled token is reaped exactly once with an infra-death marker', async () => {
  const scenarios = [{ id: 'sc-hb', board_id: null, liveness_policy: hbPolicy(180) }];
  const run = makeRun('dead-stalled', {
    liveness_token: 141,
    liveness_token_at: new Date(NOW.getTime() - 600 * SEC),    // stalled 10min > 180s
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const first = await svc.runOnce(NOW);
  assert.deepEqual(first.reaped, ['dead-stalled'], 'stalled token reaped');
  assert.equal(run.status, 'error');
  assert.ok(run.finished_at instanceof Date, 'finished_at stamped');
  assert.match(run.summary, /auto-reaped by QaRunReaperService/);
  assert.match(run.summary, /token stalled/i, 'marker names the infra-death (token stalled) cause');
  assert.match(run.summary, /NOT a tested failure/);

  const second = await svc.runOnce(NOW);
  assert.deepEqual(second.reaped, [], 'idempotent — terminal run not re-reaped');
});

test('(c-reaper) a stale token still reaps even when step_results is non-empty (no false-immortal)', async () => {
  // The pre-ticket fuse went permanently inactive once ANY step was recorded.
  // Under heartbeat_deadline the presence of a pending step is irrelevant —
  // only the (stalled) token decides.
  const scenarios = [{ id: 'sc-hb', board_id: null, liveness_policy: hbPolicy(180) }];
  const run = makeRun('dead-with-pending-step', {
    step_results: [{ idx: 0, status: 'pending', log: 'heartbeat-as-step (the old anti-pattern)' }],
    liveness_token: 141,
    liveness_token_at: new Date(NOW.getTime() - 900 * SEC),    // stalled 15min
  });
  const repo = makeRunRepo([run]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['dead-with-pending-step'], 'a single stale pending step no longer immortalizes the run');
});

test('never-heartbeat run: grace within deadline of start, reaped once past it', async () => {
  const scenarios = [{ id: 'sc-hb', board_id: null, liveness_policy: hbPolicy(180) }];
  const fresh = makeRun('hb-grace', {
    started_at: new Date(NOW.getTime() - 60 * SEC),            // 60s old, never heartbeat → grace
    liveness_token: null,
    liveness_token_at: null,
  });
  const expired = makeRun('hb-no-first-beat', {
    started_at: new Date(NOW.getTime() - 600 * SEC),           // 600s old, never heartbeat → reap
    liveness_token: null,
    liveness_token_at: null,
  });
  const repo = makeRunRepo([fresh, expired]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo([]), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['hb-no-first-beat'], 'first-heartbeat grace = deadline_sec from start');
  assert.match(expired.summary, /no liveness heartbeat ever received/);
});

// ── Reaper: zero_progress default unchanged (regression-safe) ────────────────

test('(e) a run on a board/scenario with no liveness_policy keeps zero_progress TTL behavior', async () => {
  // Scenario + board both present but neither sets liveness_policy → default.
  const scenarios = [{ id: 'sc-none', board_id: 'b-none', liveness_policy: null }];
  const boards = [{ id: 'b-none', liveness_policy: null }];
  const stale = makeRun('zp-stale', {
    scenario_id: 'sc-none',
    board_id: 'b-none',
    started_at: new Date(NOW.getTime() - 10 * HOUR),           // > 6h TTL → reap
    // a recent heartbeat token must NOT save it under zero_progress (which ignores tokens)
    liveness_token: 99,
    liveness_token_at: new Date(NOW.getTime() - 1 * SEC),
  });
  const fresh = makeRun('zp-fresh', {
    scenario_id: 'sc-none',
    board_id: 'b-none',
    started_at: new Date(NOW.getTime() - 30 * 60_000),        // 30m: < 40m zero-progress window & < 6h TTL → spare
  });
  const repo = makeRunRepo([stale, fresh]);
  const svc = new QaRunReaperService(repo, listRepo(scenarios), listRepo(boards), noopLog, noopQaRunService);

  const { reaped } = await svc.runOnce(NOW);
  assert.deepEqual(reaped, ['zp-stale'], 'zero_progress still reaps purely on age, ignoring heartbeat token');
  assert.match(stale.summary, /no terminal status within/, 'zero_progress marker (not the heartbeat one)');
  assert.equal(fresh.status, 'running', 'fresh run within TTL is spared');
});

// ── Heartbeat ingestion: monotonic token, (c) false-immortal guard ───────────

function makeHeartbeatService(run) {
  const runRepo = {
    async findOne() { return run; },
    async save(r) { return r; },
  };
  // Only runRepo (2nd ctor arg) is exercised by recordHeartbeat; the rest are unused.
  return new QaRunService(null, runRepo, null, null, null, null, null, null, null);
}

test('recordHeartbeat advances the deadline only on a STRICT token increase', async () => {
  const run = {
    id: 'r1', workspace_id: 'w1', status: 'running',
    liveness_token: null, liveness_token_at: null,
  };
  const svc = makeHeartbeatService(run);

  await svc.recordHeartbeat({ runId: 'r1', workspaceId: 'w1', progressToken: 10 });
  assert.equal(run.liveness_token, 10, 'first token recorded');
  const t1 = run.liveness_token_at;
  assert.ok(t1 instanceof Date, 'liveness_token_at stamped on first heartbeat');

  // (c) Same token again — must NOT advance the deadline clock.
  await svc.recordHeartbeat({ runId: 'r1', workspaceId: 'w1', progressToken: 10 });
  assert.equal(run.liveness_token, 10, 'token unchanged');
  assert.strictEqual(run.liveness_token_at, t1, 'repeated token does NOT bump liveness_token_at (false-immortal guard)');

  // Lower token (out-of-order / replay) — also no advance, keep the high-water mark.
  await svc.recordHeartbeat({ runId: 'r1', workspaceId: 'w1', progressToken: 7 });
  assert.equal(run.liveness_token, 10, 'high-water mark preserved against a lower token');
  assert.strictEqual(run.liveness_token_at, t1, 'lower token does NOT bump the deadline');

  // Strict increase — advances both.
  await svc.recordHeartbeat({ runId: 'r1', workspaceId: 'w1', progressToken: 11 });
  assert.equal(run.liveness_token, 11, 'strict increase updates token');
  assert.notStrictEqual(run.liveness_token_at, t1, 'strict increase resets the deadline');
});

test('recordHeartbeat rejects a terminal run and a non-finite token', async () => {
  const terminal = { id: 'r2', workspace_id: 'w1', status: 'passed', liveness_token: null, liveness_token_at: null };
  const svcT = makeHeartbeatService(terminal);
  await assert.rejects(
    () => svcT.recordHeartbeat({ runId: 'r2', workspaceId: 'w1', progressToken: 5 }),
    /already 'passed'/, 'heartbeats refused once the run is terminal',
  );

  const live = { id: 'r3', workspace_id: 'w1', status: 'running', liveness_token: null, liveness_token_at: null };
  const svcN = makeHeartbeatService(live);
  await assert.rejects(
    () => svcN.recordHeartbeat({ runId: 'r3', workspaceId: 'w1', progressToken: Number.NaN }),
    /finite number/, 'NaN token rejected',
  );
});
