// Pure unit tests for CiHealthMonitorService's threshold decision (ticket
// cc1c494e). `evaluateRedStreak` takes no DB / no HTTP, so these run against
// fixture run lists with no bootApp — the qa-flow e2e test
// (test/qa-flows/ci-health-monitor.test.mjs) covers the full sweep→alert→
// ticket→dedupe→recovery path against a real (sqlite) app instance.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRedStreak, __test__ } from '../dist/modules/agents/ci-health-monitor.service.js';
import { GitHubConnectorService } from '../dist/services/github-connector.service.js';

const NOW = new Date('2026-08-10T12:00:00.000Z');
const CONFIG = { minConsecutiveRuns: 3, minAgeMs: 6 * 60 * 60_000 };

function run(id, conclusion, minutesAgo, event = 'push') {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  return { id: String(id), status: 'completed', conclusion, event, html_url: `https://github.com/x/y/actions/runs/${id}`, created_at: at, updated_at: at };
}

// --- wire-path helpers (리뷰 지적: 순수 함수 fixture만으로는 GitHubConnectorService.
// listWorkflowRuns의 실제 flatten/serialize 경로 회귀를 못 잡는다) -------------------

// GitHub REST가 실제로 돌려주는 raw 모양: id는 숫자, event 키 자체가 없을 수도 있다
// (event=undefined면 키를 아예 생략 — '유실'을 흉내낸다). listWorkflowRuns가 이걸
// GitHubWorkflowRun으로 변환하는 지점(id 문자열화, event `|| ''` fallback)까지 통과시켜야
// evaluateRedStreak에 닿는 실제 wire path를 검증하는 셈이다.
function rawApiRun(id, conclusion, minutesAgo, event) {
  const at = new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
  const raw = { id, status: 'completed', conclusion, html_url: `https://github.com/x/y/actions/runs/${id}`, created_at: at, updated_at: at };
  if (event !== undefined) raw.event = event;
  return raw;
}

function makeFakeFetch(rawRuns) {
  return async (url) => {
    const u = String(url);
    if (u.includes('/actions/workflows/') && u.includes('/runs?')) {
      return { ok: true, status: 200, async json() { return { workflow_runs: rawRuns }; }, async text() { return JSON.stringify({ workflow_runs: rawRuns }); } };
    }
    throw new Error(`unexpected GitHub URL in ci-health-monitor wire-path test: ${u}`);
  };
}

// listWorkflowRuns only reaches this.dataSource when a credentialId is passed
// (DB-backed credential lookup) — every call below passes null, which routes
// straight to the env-token fallback, so a real DataSource is never needed.
async function withGithubToken(fn) {
  const prev = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'wire-path-test-token';
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prev;
  }
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

test('evaluateRedStreak: event 필드가 빈 문자열(누락)인 run은 fail-closed로 신호에서 제외된다 (리뷰 지적)', () => {
  // event를 알 수 없으면 schedule 여부도 판별할 수 없다 — '' fallback을 신호로 받아들이면
  // wire 경로에서 event가 유실되는 순간 이 티켓의 수정 자체가 무력화된다.
  const runs = [run(4, 'success', 5, ''), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'failure', 60)];
  const res = evaluateRedStreak(runs, NOW, CONFIG);
  assert.equal(res.isGreen, false, 'event를 알 수 없는 run을 green 신호로 인정하면 안 된다');
  assert.equal(res.isRed, true, 'event 미상 run을 걷어내면 남은 signal은 여전히 3연속 실패다');
  assert.equal(res.streak, 3);
});

// --- wire-path 통합 테스트 (리뷰 지적) ----------------------------------------
// 위 순수 함수 테스트들은 evaluateRedStreak에 손으로 만든 fixture를 직접 넣는다 — 따라서
// GitHubConnectorService.listWorkflowRuns가 실제 GitHub API 응답의 event 필드를 버리거나
// 잘못된 키로 읽어도 이 테스트들은 계속 통과한다. 아래 두 테스트는 raw GitHub 응답 모양
// (숫자 id, event 키 유무)을 실제 listWorkflowRuns에 통과시켜 evaluateRedStreak까지
// 연결한다 — 소비자가 새 wire 필드에 의존하므로 producer 경로 회귀를 잡아야 한다.

test('wire path: GitHubConnectorService.listWorkflowRuns가 실제 API 응답을 flatten한 뒤에도 schedule run은 evaluateRedStreak에서 제외된다', async () => {
  await withGithubToken(async () => {
    const rawRuns = [
      rawApiRun(428, 'success', 5, 'schedule'),
      rawApiRun(3, 'failure', 20, 'push'),
      rawApiRun(2, 'failure', 40, 'push'),
      rawApiRun(1, 'failure', 60, 'push'),
    ];
    const github = new GitHubConnectorService(null);
    const runs = await github.listWorkflowRuns('x', 'y', '555', 'main', null, makeFakeFetch(rawRuns));

    // listWorkflowRuns의 실제 변환이 일어났는지부터 확인 — 손으로 만든 fixture가 아니다.
    assert.equal(runs[0].id, '428', 'listWorkflowRuns는 숫자 id를 문자열로 정규화해야 한다');
    assert.equal(runs[0].event, 'schedule', 'listWorkflowRuns는 raw 응답의 event를 그대로 전달해야 한다');

    const res = evaluateRedStreak(runs, NOW, CONFIG);
    assert.equal(res.isGreen, false, '실제 fetch/flatten 경로를 거친 schedule run도 green으로 오판되면 안 된다');
    assert.equal(res.isRed, true);
    assert.equal(res.streak, 3);
  });
});

test('wire path: raw GitHub 응답에 event 키 자체가 없으면 listWorkflowRuns는 빈 문자열로 정규화하고 evaluateRedStreak는 fail-closed로 제외한다', async () => {
  await withGithubToken(async () => {
    const rawRuns = [
      rawApiRun(4, 'success', 5, undefined), // event 키 자체를 생략 — wire 유실 시뮬레이션
      rawApiRun(3, 'failure', 20, 'push'),
      rawApiRun(2, 'failure', 40, 'push'),
      rawApiRun(1, 'failure', 60, 'push'),
    ];
    const github = new GitHubConnectorService(null);
    const runs = await github.listWorkflowRuns('x', 'y', '555', 'main', null, makeFakeFetch(rawRuns));

    assert.equal(runs[0].event, '', 'listWorkflowRuns는 누락된 event를 빈 문자열로 정규화해야 한다');

    const res = evaluateRedStreak(runs, NOW, CONFIG);
    assert.equal(res.isGreen, false, 'event를 알 수 없는 run은 fail-closed로 green 신호에서 제외돼야 한다');
    assert.equal(res.isRed, true);
    assert.equal(res.streak, 3);
  });
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
