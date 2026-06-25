// Behavioral test for SecurityRunReaperService.runOnce() — drives the reaper
// against an in-memory fake SecurityRun repository (no DB) with a fixed `now`,
// asserting the same contract as the QA reaper:
//   • a run older than the TTL with status='running'  -> reaped to 'error'
//   • a run older than the TTL with status='pending'  -> reaped to 'error'
//   • a fresh running run (within TTL)                 -> left untouched
//   • an already-terminal run (passed/failed)          -> never selected/touched
//   • started_at=null falls back to created_at for the age gate
//   • finished_at is stamped and the summary carries the reaped marker
//   • idempotency: a second sweep reaps nothing

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SecurityRunReaperService } from '../dist/modules/security/security-run-reaper.service.js';

const HOUR = 60 * 60_000;

function makeRepo(rows) {
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

const noopLog = { info() {}, warn() {}, error() {} };

function makeRun(id, status, ageHours, { startedNull = false } = {}) {
  const now = new Date('2026-06-25T12:00:00Z').getTime();
  const ts = new Date(now - ageHours * HOUR);
  return {
    id,
    status,
    started_at: startedNull ? null : ts,
    created_at: ts,
    finished_at: null,
    summary: '',
  };
}

test('runOnce reaps stale running/pending runs and spares fresh + terminal runs', async () => {
  const now = new Date('2026-06-25T12:00:00Z');
  const rows = [
    makeRun('stale-running', 'running', 10),               // 10h old > 6h TTL -> reap
    makeRun('stale-pending', 'pending', 8),                // 8h old  -> reap
    makeRun('fresh-running', 'running', 1),                // 1h old  -> spare
    makeRun('done-passed', 'passed', 48),                  // terminal -> never selected
    makeRun('done-failed', 'failed', 48),                  // terminal -> never selected
    makeRun('stale-startednull', 'running', 9, { startedNull: true }), // created_at fallback -> reap
  ];
  const repo = makeRepo(rows);
  const svc = new SecurityRunReaperService(repo, noopLog);

  const { reaped } = await svc.runOnce(now);

  assert.deepEqual(
    reaped.sort(),
    ['stale-pending', 'stale-running', 'stale-startednull'].sort(),
    'exactly the stale non-terminal runs are reaped',
  );

  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  for (const id of reaped) {
    assert.equal(byId[id].status, 'error', `${id} closed with status=error`);
    assert.ok(byId[id].finished_at instanceof Date, `${id} stamps finished_at`);
    assert.match(byId[id].summary, /auto-reaped by SecurityRunReaperService/, `${id} summary carries marker`);
    assert.match(byId[id].summary, /NOT a confirmed pass\/fail/, `${id} marker distinguishes from a real result`);
  }
  assert.equal(byId['fresh-running'].status, 'running', 'fresh run untouched');
  assert.equal(byId['done-passed'].status, 'passed', 'passed run untouched');
  assert.equal(byId['done-failed'].status, 'failed', 'failed run untouched');
});

test('runOnce is idempotent — a second sweep reaps nothing', async () => {
  const now = new Date('2026-06-25T12:00:00Z');
  const rows = [makeRun('stale-running', 'running', 10)];
  const repo = makeRepo(rows);
  const svc = new SecurityRunReaperService(repo, noopLog);

  const first = await svc.runOnce(now);
  assert.deepEqual(first.reaped, ['stale-running'], 'first sweep reaps the stale run');

  const second = await svc.runOnce(now);
  assert.deepEqual(second.reaped, [], 'second sweep reaps nothing (now terminal)');
});
