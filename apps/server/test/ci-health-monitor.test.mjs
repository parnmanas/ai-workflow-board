// Pure unit tests for CiHealthMonitorService's threshold decision (ticket
// cc1c494e). `evaluateRedStreak` takes no DB / no HTTP, so these run against
// fixture run lists with no bootApp — the qa-flow e2e test
// (test/qa-flows/ci-health-monitor.test.mjs) covers the full sweep→alert→
// ticket→dedupe→recovery path against a real (sqlite) app instance.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRedStreak, __test__ } from '../dist/modules/agents/ci-health-monitor.service.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const CONFIG = { minConsecutiveRuns: 3, minAgeMs: 6 * 60 * 60_000 };

function run(id, conclusion, minutesAgo, event = 'push') {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return { id: String(id), status: 'completed', conclusion, event, html_url: `https://github.com/x/y/actions/runs/${id}`, created_at: at, updated_at: at };
}

test('evaluateRedStreak: no completed runs → no signal', () => {
  const res = evaluateRedStreak([], NOW, CONFIG);
  assert.equal(res.isRed, false);
  assert.equal(res.isGreen, false);
  assert.equal(res.streak, 0);
  assert.equal(res.lastRun, null);
});

test('evaluateRedStreak: only cancelled/skipped runs → no signal (neither red nor green)', () => {
  const runs = [run(3, 'cancelled', 5), run(2, 'skipped', 20), run(1, 'cancelled', 40)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isRed, false);
  assert.equal(res.isGreen, false);
  assert.equal(res.streak, 0);
});

test('evaluateRedStreak: newest run success → green regardless of older failures', () => {
  const runs = [run(4, 'success', 5), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'failure', 60)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isGreen, true);
  assert.equal(res.isRed, false);
  assert.equal(res.streak, 0);
});

test('evaluateRedStreak: 3 consecutive red runs trips the count threshold', () => {
  const runs = [run(3, 'failure', 5), run(2, 'timed_out', 20), run(1, 'startup_failure', 40)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isRed, true);
  assert.equal(res.streak, 3);
  assert.equal(res.lastRun.id, '3');
  assert.equal(res.firstFailedRun.id, '1');
});

test('evaluateRedStreak: 2 consecutive red runs BELOW count threshold, but old (>= minAgeMs) trips via the age path', () => {
  const runs = [run(2, 'failure', 30), run(1, 'failure', 7 * 60)]; // oldest 7h ago > 6h floor
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.streak, 2);
  assert.equal(res.isRed, true, 'age since the oldest run in the streak exceeds minAgeMs');
});

test('evaluateRedStreak: 2 consecutive red runs, both recent → NOT tripped (below count AND below age)', () => {
  const runs = [run(2, 'failure', 5), run(1, 'failure', 30)]; // oldest only 30 min ago
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.streak, 2);
  assert.equal(res.isRed, false);
  assert.equal(res.isGreen, false);
});

test('evaluateRedStreak: cancelled run interleaved is dropped, not counted as a streak breaker', () => {
  // newest-first: failure, cancelled, failure, failure — cancelled carries no
  // signal and must not break the otherwise-consecutive red streak.
  const runs = [run(4, 'failure', 5), run(3, 'cancelled', 15), run(2, 'failure', 25), run(1, 'failure', 40)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.streak, 3, 'cancelled run must be filtered out before streak counting, not treated as a break');
  assert.equal(res.isRed, true);
});

test('evaluateRedStreak: a green run breaks the streak even with reds further back', () => {
  const runs = [run(4, 'failure', 5), run(3, 'success', 15), run(2, 'failure', 25), run(1, 'failure', 40)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  // newest (run 4) is red, but the very next signal run (run 3) is green —
  // streak stops there.
  assert.equal(res.streak, 1);
  assert.equal(res.isRed, false, 'streak of 1 recent run is below both the count and age thresholds');
});

test('evaluateRedStreak: schedule 트리거 success run은 잡이 대부분 skip돼도 신호에서 제외 — 직전 3연속 실패면 red 유지 (ticket 654465c8)', () => {
  // #428 재현: 매일 04:17 UTC cron이 6개 잡 중 5개를 skip하고도 run-level conclusion은
  // success — main이 실제로는 3연속 실패 중이어도 이 run 하나 때문에 "복구"로 오판되면 안 된다.
  const runs = [run(4, 'success', 5, 'schedule'), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'failure', 60)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isGreen, false, 'schedule run은 신호가 아니므로 green으로 오판되면 안 된다');
  assert.equal(res.isRed, true, 'schedule run을 걷어내면 최신 signal run은 여전히 3연속 실패다');
  assert.equal(res.streak, 3);
  assert.equal(res.lastRun.id, '3', 'schedule run이 lastRun으로 선택되면 안 된다');
});

test('evaluateRedStreak: push 트리거 success run은 기존대로 green (회귀 없음 확인)', () => {
  const runs = [run(4, 'success', 5, 'push'), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'failure', 60)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isGreen, true);
  assert.equal(res.isRed, false);
  assert.equal(res.streak, 0);
});

test('evaluateRedStreak: schedule 트리거 run은 중간에 껴도 red 스트릭을 끊지 않는다', () => {
  // newest-first: failure, success/schedule, failure, failure — schedule run은
  // 신호가 아니므로 필터링돼야 하고, 그러면 나머지 3개 failure가 연속으로 이어진다.
  const runs = [run(4, 'failure', 5), run(3, 'success', 15, 'schedule'), run(2, 'failure', 25), run(1, 'failure', 40)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.streak, 3, 'schedule run은 필터링돼야 하므로 3연속 실패로 이어져야 한다');
  assert.equal(res.isRed, true);
});

test('readConfigFromEnv: CI_MONITOR_MIN_RUNS / CI_MONITOR_CREATE_TICKET env overrides are honored', () => {
  const cfg = __test__.readConfigFromEnv({
    CI_MONITOR_ENABLED: 'true',
    CI_MONITOR_MIN_RUNS: '5',
    CI_MONITOR_CREATE_TICKET: 'false',
  });
  assert.equal(cfg.minRuns, 5);
  assert.equal(cfg.createTicket, false);
  assert.equal(cfg.enabled, true);
});

test('readConfigFromEnv: CI_MONITOR_ENABLED=false disables the service', () => {
  const cfg = __test__.readConfigFromEnv({ CI_MONITOR_ENABLED: 'false' });
  assert.equal(cfg.enabled, false);
});

test('readConfigFromEnv: unset env falls back to DEFAULTS', () => {
  const cfg = __test__.readConfigFromEnv({});
  assert.equal(cfg.enabled, __test__.DEFAULTS.ENABLED);
  assert.equal(cfg.sweepMs, __test__.DEFAULTS.SWEEP_MS);
  assert.equal(cfg.minRuns, __test__.DEFAULTS.MIN_RUNS);
  assert.equal(cfg.createTicket, __test__.DEFAULTS.CREATE_TICKET);
});
