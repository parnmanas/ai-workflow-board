// Pure unit tests for CiHealthMonitorService's threshold decision (ticket
// cc1c494e). `evaluateRedStreak` takes no DB / no HTTP, so these run against
// fixture run lists with no bootApp — the qa-flow e2e test
// (test/qa-flows/ci-health-monitor.test.mjs) covers the full sweep→alert→
// ticket→dedupe→recovery path against a real (sqlite) app instance.

import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRedStreak, __test__ } from '../dist/modules/agents/ci-health-monitor.service.js';
import { compareRunIds, GitHubConnectorService } from '../dist/services/github-connector.service.js';

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

// 절대 시각으로 raw run 을 만든다 — ticket 0ef405f9 의 실제 run 목록은 같은 초를 공유하는
// 쌍이 핵심이라 minutesAgo 상대 시각으로는 그 동률을 그대로 재현할 수 없다.
function rawApiRunAt(id, conclusion, iso, event, workflowId) {
  const raw = { id, status: 'completed', conclusion, event, html_url: `https://github.com/x/y/actions/runs/${id}`, created_at: iso, updated_at: iso };
  if (workflowId !== undefined) raw.workflow_id = workflowId;
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

// --- 복구 오탐 회귀 (ticket 0ef405f9) -----------------------------------------
// 성공한 CI run 이 하나도 없는 main 에 "CI 복구" 알림이 두 차례 발송됐다. 아래 픽스처는
// 그 사건의 실제 run 목록이다 — 푸시 1회가 CI(failure) 와 Publish(success) 를 **같은 초**
// 에 띄우는 저장소이고, 그 동률에서 응답 순서에 기대면 남의 workflow 성공이 이 workflow 의
// 복구로 읽힌다. 방어선은 셋: (1) 응답의 workflow 밖 run 제거, (2) (created_at, id) 로
// 최신순 재구성, (3) 기존 red 근거보다 최신이 아닌 green 거부(단조성 게이트).

const INCIDENT_WORKFLOW_ID = '304034069';  // CI
const PUBLISH_WORKFLOW_ID = '309135221';   // Publish agent-manager
// 가짜 복구가 실제로 발송된 sweep 시각
const INCIDENT_NOW = new Date('2026-09-24T06:05:22.000Z');

// 티켓 본문의 8건 — main 브랜치, workflow 무관, 최신순. 같은 초를 공유하는 쌍이 3개 있고
// 그때마다 Publish(success) 의 run id 가 CI(failure) 보다 작다.
function incidentRawRuns() {
  return [
    rawApiRunAt(35939081971, 'success', '2026-09-24T00:35:14Z', 'push', PUBLISH_WORKFLOW_ID),
    rawApiRunAt(35939082088, 'failure', '2026-09-24T00:35:14Z', 'push', INCIDENT_WORKFLOW_ID),
    rawApiRunAt(35842225615, 'failure', '2026-09-23T09:19:11Z', 'schedule', INCIDENT_WORKFLOW_ID),
    rawApiRunAt(35798148426, 'success', '2026-09-22T23:35:31Z', 'push', PUBLISH_WORKFLOW_ID),
    rawApiRunAt(35798148540, 'failure', '2026-09-22T23:35:31Z', 'push', INCIDENT_WORKFLOW_ID),
    rawApiRunAt(35709645137, 'failure', '2026-09-22T09:18:38Z', 'schedule', INCIDENT_WORKFLOW_ID),
    rawApiRunAt(35705473920, 'failure', '2026-09-22T08:33:39Z', 'push', INCIDENT_WORKFLOW_ID),
    rawApiRunAt(35705473915, 'success', '2026-09-22T08:33:39Z', 'push', PUBLISH_WORKFLOW_ID),
  ];
}

test('완료 기준 1·2 (wire): 같은 푸시의 Publish=success / CI=failure 가 한 응답에 섞여 와도 CI workflow 의 상태는 red 로 유지된다', async () => {
  await withGithubToken(async () => {
    const github = new GitHubConnectorService(null);
    // 응답이 workflow 경계를 지키지 못하고 repo 전체 run 을 돌려준 상황을 그대로 넣는다.
    const runs = await github.listWorkflowRuns('parnmanas', 'ai-workflow-board', INCIDENT_WORKFLOW_ID, 'main', null, makeFakeFetch(incidentRawRuns()));

    assert.equal(runs.length, 5, '요청한 workflow(CI) 의 run 5건만 남아야 한다');
    assert.ok(
      runs.every((r) => r.workflow_id === INCIDENT_WORKFLOW_ID),
      `다른 workflow 의 run 이 남아 있다: ${runs.filter((r) => r.workflow_id !== INCIDENT_WORKFLOW_ID).map((r) => r.id).join(', ')}`,
    );
    assert.equal(runs[0].id, '35939082088', '최신순 첫 run 은 CI 의 최신 실패 run 이어야 한다');

    const res = evaluateRedStreak(runs, INCIDENT_NOW, CONFIG);
    assert.equal(res.isGreen, false, '성공한 CI run 이 없는데 복구로 판정되면 안 된다');
    assert.equal(res.isRed, true, '연속 3회 push 실패가 그대로 red 여야 한다');
    assert.equal(res.streak, 3);
    assert.equal(res.lastRun.id, '35939082088');
  });
});

test('완료 기준 1 (정렬): 같은 created_at 의 타 workflow success 가 목록 앞자리에 와도 최신 run 은 id 로 결정된다', () => {
  // 필터를 뚫고 들어왔다고 가정해도 — 같은 초라면 run id 가 큰 쪽(나중에 만들어진 쪽)이
  // 최신이다. 응답이 준 순서를 그대로 믿던 시절의 오판이 여기서 막힌다.
  const publishSuccess = { id: '35939081971', workflow_id: PUBLISH_WORKFLOW_ID, status: 'completed', conclusion: 'success', event: 'push', html_url: '', created_at: '2026-09-24T00:35:14Z', updated_at: '2026-09-24T00:35:14Z', head_sha: '' };
  const ciFailure = { id: '35939082088', workflow_id: INCIDENT_WORKFLOW_ID, status: 'completed', conclusion: 'failure', event: 'push', html_url: '', created_at: '2026-09-24T00:35:14Z', updated_at: '2026-09-24T00:35:14Z', head_sha: '' };

  const res = evaluateRedStreak([publishSuccess, ciFailure], INCIDENT_NOW, CONFIG);
  assert.equal(res.lastRun.id, '35939082088', '같은 초 동률은 run id 내림차순으로 깨야 한다');
  assert.equal(res.isGreen, false);
});

test('완료 기준 3: 기존 red 근거보다 최신인 success 는 그대로 복구(green)로 판정된다 — 회귀 없음', () => {
  // 2026-09-17 의 실제 복구 사례 모양: 5연속 실패 뒤 더 최신 push success 가 들어왔다.
  const runs = [run(4, 'success', 5), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'failure', 60)];
  const evidence = { lastFailedRunId: '3', lastFailedAt: runs[1].created_at };
  const res = evaluateRedStreak(runs, NOW, CONFIG, evidence);
  assert.equal(res.isGreen, true, '실패보다 최신인 success 는 진짜 복구다');
  assert.equal(res.staleGreenRun, null);
});

test('단조성 게이트: 기록된 실패 run 보다 오래된 success 는 복구로 인정하지 않는다 (상태 유지 + 관측 가능)', () => {
  // 응답에서 최신 실패들이 누락돼 과거의 green 이 첫 자리로 올라온 모양 — 사건의 09-23
  // 케이스가 이것이다(성공 run 은 09-22 06:34 뿐이었다).
  const staleGreen = run(10, 'success', 24 * 60);       // 24시간 전 성공
  const res = evaluateRedStreak([staleGreen], NOW, CONFIG, {
    lastFailedRunId: '20',
    lastFailedAt: new Date(NOW.getTime() - 60 * 60_000).toISOString(), // 1시간 전 실패가 red 근거
  });
  assert.equal(res.isGreen, false, '기존 실패보다 오래된 success 는 복구가 아니다');
  assert.equal(res.isRed, false, 'red 를 새로 트립하지도 않는다 — 기존 상태를 그대로 둔다');
  assert.ok(res.staleGreenRun, '거부된 green run 이 호출자에게 노출돼야 로그로 남길 수 있다');
  assert.equal(res.staleGreenRun.id, '10');
});

test('단조성 게이트: 기록된 실패와 created_at 이 같은 success 는 복구로 인정하지 않는다 (형제 run)', () => {
  const sameSecond = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  const siblingSuccess = { id: '35939081971', workflow_id: PUBLISH_WORKFLOW_ID, status: 'completed', conclusion: 'success', event: 'push', html_url: '', created_at: sameSecond, updated_at: sameSecond, head_sha: '' };
  const res = evaluateRedStreak([siblingSuccess], NOW, CONFIG, { lastFailedRunId: '35939082088', lastFailedAt: sameSecond });
  assert.equal(res.isGreen, false, '한 푸시가 나란히 띄운 형제 run 은 그 실패를 고친 run 이 아니다');
  assert.ok(res.staleGreenRun);
});

test('compareRunIds: 2^53 을 넘는 run id 도 정밀도 손실 없이 비교한다 (Number 변환이면 동률로 무너진다)', () => {
  // Number('9007199254740993') === Number('9007199254740992') — double 로 접히면 서로 다른
  // 두 run 이 같은 값이 되어 동률 깨기가 조용히 무력화된다.
  const lower = '9007199254740992';
  const higher = '9007199254740993';
  assert.equal(Number(lower), Number(higher), '전제: 이 두 id 는 double 로는 구분되지 않는다');
  assert.ok(compareRunIds(higher, lower) > 0, 'BigInt 비교라면 더 큰 id 를 더 나중으로 판정해야 한다');
  assert.ok(compareRunIds(lower, higher) < 0);
  assert.equal(compareRunIds(lower, lower), 0);
  // 10진 정수가 아닌 id 는 비교 불가(0) — 복구 판정에서 `> 0` 이 성립하지 않아 fail-closed.
  assert.equal(compareRunIds('run-6', 'run-5'), 0);
  assert.equal(compareRunIds('12', ''), 0);
});

test('단조성 게이트: 같은 run 이 재실행되어 green 으로 뒤집힌 경우는 복구로 인정한다', () => {
  // run_attempt 증가는 run id 와 created_at 을 바꾸지 않는다 — 시각 비교만 하면 이 진짜
  // 복구가 영원히 거부돼 alert 행이 갇힌다.
  const at = new Date(NOW.getTime() - 30 * 60_000).toISOString();
  const rerun = { id: '777', workflow_id: INCIDENT_WORKFLOW_ID, status: 'completed', conclusion: 'success', event: 'push', html_url: '', created_at: at, updated_at: new Date(NOW.getTime() - 60_000).toISOString(), head_sha: '' };
  const res = evaluateRedStreak([rerun], NOW, CONFIG, { lastFailedRunId: '777', lastFailedAt: at });
  assert.equal(res.isGreen, true, '같은 run 의 재실행 flip 은 진짜 복구다');
  assert.equal(res.staleGreenRun, null);
});

test('단조성 게이트: 하한선이 비어 있으면(이 필드 이전에 만들어진 행) 게이트하지 않는다', () => {
  const runs = [run(4, 'success', 5), run(3, 'failure', 20)];
  const res = evaluateRedStreak(runs, NOW, CONFIG, { lastFailedRunId: '3', lastFailedAt: '' });
  assert.equal(res.isGreen, true, '비교 대상이 없는 것은 검증 실패가 아니다 — 다음 sweep 이 값을 채운다');
});

test('정렬: 응답이 뒤죽박죽 순서로 와도 판정은 (created_at, id) 기준으로 동일하다', () => {
  const ordered = [run(4, 'failure', 5), run(3, 'failure', 20), run(2, 'failure', 40), run(1, 'success', 60)];
  const shuffled = [ordered[2], ordered[0], ordered[3], ordered[1]];
  const a = evaluateRedStreak(ordered, NOW, CONFIG);
  const b = evaluateRedStreak(shuffled, NOW, CONFIG);
  assert.deepEqual(
    { isRed: b.isRed, isGreen: b.isGreen, streak: b.streak, last: b.lastRun.id },
    { isRed: a.isRed, isGreen: a.isGreen, streak: a.streak, last: a.lastRun.id },
  );
  assert.equal(b.lastRun.id, '4', '입력 순서와 무관하게 가장 최신 run 이 선택돼야 한다');
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
