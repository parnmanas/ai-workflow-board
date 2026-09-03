// Unit: 매니저 재시작 × in-flight 교차 재시드 판정 (ticket 4f1f33c6).
//
// `decideRestartReseed`는 DispatchReconciler 의 재시드 스킵을 결정하는 순수
// 함수다. DataSource 없이 전 분기를 직접 태워, 두 방향의 회귀를 각각 독립적으로
// 잡는다:
//
//   방향 1 (이 티켓이 고치는 결함) — self-update 재시작에 죽은 세션의 티켓이
//     "holder가 이미 응답했다"는 이유로 영원히 재시드되지 않던 문제. 열린 행 /
//     SIGTERM / disappeared / 비정상 exit 는 모두 재시드로 이어져야 한다.
//
//   방향 2 (fec25d90 회귀) — 의도적으로 대기 중인 holder 를 재시작마다 재시드해
//     `progressed` 로 해소될 수 없는 intent 를 만들어 재디스패치 루프를 만드는
//     문제. 정상 종료한 세션은 재시작이 있었더라도 재시드하지 않아야 한다.
//
// 두 방향 중 하나만 구현해도 통과하는 테스트가 되지 않도록, 같은 재시작 사실
// 위에서 "정상 종료" 와 "죽은 세션" 을 나란히 단언한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const { decideRestartReseed } = await import(
  'file://' + path.join(DIST, 'modules', 'agents', 'dispatch-reconciler.service.js')
);

const T = (min) => 1_000_000 + min * 60_000;   // 읽기 쉬운 상대 epoch ms
const HOLDER_RESPONDED_AT = T(10);

// 기본 배치: holder 가 T(10) 에 응답했고, 매니저가 T(20) 에 새로 부팅했다
// (= 그 응답을 낸 세션은 지금 살아 있을 수 없다).
const RESTARTED = [T(20)];
const session = (over = {}) => ({
  startedAtMs: T(5), endedAtMs: null, signal: null, exitCode: null, ...over,
});

test('재시작이 없으면 holder 의 침묵은 선택된 대기다 — 재시드하지 않는다 (fec25d90 유지)', () => {
  // 응답보다 먼저 뜬 매니저 프로세스는 그 세션을 계속 안고 있었다.
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(2)],
    session: session(),
  });
  assert.equal(d.reseed, false, '응답 이전에 부팅된 매니저는 재시작 근거가 아니다');
  assert.equal(d.reason, 'no_manager_restart_since_holder_response');
  assert.equal(d.restartAtMs, 0, '재시작 판정이 없으므로 근거 시각도 없다');
});

test('레지스트리가 비어 있으면(서버 재시작 직후 등) 재시드하지 않는다 — 기존 동작으로 안전 축퇴', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [],
    session: session(),
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'no_manager_restart_since_holder_response');
});

test('여러 인스턴스가 보고돼도 응답 이후의 가장 최근 부팅 시각을 근거로 삼는다', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(2), T(30), T(20), Number.NaN],
    session: session(),
  });
  assert.equal(d.reseed, true);
  assert.equal(d.restartAtMs, T(30), '응답 이후 값들 중 최댓값 — NaN 은 무시');
});

test('재시작이 있어도 세션 기록이 없으면 재시드하지 않는다 — 근거 없는 재디스패치 금지', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: null,
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'no_session_record_for_role');
  assert.equal(d.restartAtMs, T(20), '재시작 자체는 관측됐음을 근거로 남긴다');
});

test('재시작 이후에 시작된 세션이 있으면 이미 재개된 것이다 — 재시드하지 않는다', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: session({ startedAtMs: T(25) }),
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'session_started_after_restart');
});

test('가장 최근 세션이 holder 응답보다 먼저 끝났다면 그 응답을 낸 세션이 아니다 — 판단 보류', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: session({ startedAtMs: T(1), endedAtMs: T(4), exitCode: 0 }),
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'session_predates_holder_response');
});

test('fec25d90 회귀 방지 — 재시작이 있어도 세션이 정상 종료했다면 재시드하지 않는다', () => {
  // 담당자가 대기 코멘트를 남기고 세션이 idle 타이머로 정상 종료한 뒤 매니저가
  // 재시작한 경우. 여기서 재시드하면 그 holder 는 (보드 지침상) 같은 대기
  // 코멘트를 반복하지 않으므로 intent 가 `progressed` 로 해소되지 못한다.
  const exitZero = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: session({ endedAtMs: T(12), signal: null, exitCode: 0 }),
  });
  assert.equal(exitZero.reseed, false, 'exit 0 정상 종료 → 턴을 마쳤다');
  assert.equal(exitZero.reason, 'session_completed_normally');

  const exitUnreported = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: session({ endedAtMs: T(12), signal: null, exitCode: null }),
  });
  assert.equal(exitUnreported.reseed, false, 'exit code 미보고 + signal 없음도 정상 종료로 본다');
  assert.equal(exitUnreported.reason, 'session_completed_normally');
});

test('열린 세션 행은 매니저가 종료를 보고하지 못하고 사라진 것이다 — 재시드한다', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: RESTARTED,
    session: session({ endedAtMs: null }),
  });
  assert.equal(d.reseed, true);
  assert.equal(d.reason, 'holder_session_lost_to_manager_restart');
  assert.equal(d.restartAtMs, T(20));
});

test('SIGTERM / disappeared / 비정상 exit 로 끝난 세션은 턴을 마치지 못한 것이다 — 재시드한다', () => {
  for (const [label, over] of [
    ['self-update 의 SIGTERM', { endedAtMs: T(19), signal: 'SIGTERM', exitCode: null }],
    ['매니저가 사라져 서버 reconcile 이 스탬프한 disappeared', { endedAtMs: T(24), signal: 'disappeared', exitCode: null }],
    ['비정상 종료 코드', { endedAtMs: T(19), signal: null, exitCode: 143 }],
  ]) {
    const d = decideRestartReseed({
      holderProgressMs: HOLDER_RESPONDED_AT,
      managerStartedAtMs: RESTARTED,
      session: session(over),
    });
    assert.equal(d.reseed, true, `${label} → 재시드 대상`);
    assert.equal(d.reason, 'holder_session_lost_to_manager_restart');
  }
});

test('재시작 사실은 필수 조건이다 — 죽은 세션만으로는 재시드하지 않는다', () => {
  // 이 단언이 없으면 "in-flight 증거만 보고 재시드" 하는 구현도 통과한다.
  // 그 구현은 재시작과 무관한 health-watchdog kill 등에도 재시드를 열어버린다.
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(2)],
    session: session({ endedAtMs: T(12), signal: 'SIGTERM' }),
  });
  assert.equal(d.reseed, false, '매니저가 재시작하지 않았다면 재시드 근거가 없다');
  assert.equal(d.reason, 'no_manager_restart_since_holder_response');
});
