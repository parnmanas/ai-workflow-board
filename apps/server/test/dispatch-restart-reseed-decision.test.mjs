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
  assert.equal(d.reason, 'manager_instance_predates_holder_response');
  assert.equal(d.restartAtMs, 0, '재시작 판정이 없으므로 근거 시각도 없다');
});

test('레지스트리가 비어 있으면(서버 재시작 직후 등) 재시드하지 않는다 — 기존 동작으로 안전 축퇴', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [],
    session: session(),
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'no_live_manager_instance');
});

// --- 다중 인스턴스: 한 agent identity 를 여러 호스트가 감독할 수 있다 ---
// `listForAgent()` 는 노트북+VM 페어링이나 ST-5b 다중 agent 감독처럼 같은 agent 를
// 감독하는 **여러 호스트**의 인스턴스를 돌려주고, supersede 제거는 같은
// `agent_id + hostname` 에만 적용된다. 따라서 "하나라도 최신" 으로 판정하면
// 살아서 진행 중인 세션을 재시드한다.

test('리뷰 반례 — host A 가 세션을 계속 돌리는 중 host B 가 새로 등록해도 재시드하지 않는다', () => {
  // host A: 응답 이전부터 계속 살아 있음 → 그 세션을 아직 안고 있을 수 있다.
  // host B: 응답 이후 새로 부팅. 존재 한정으로 판정하면 여기서 재시드가 나버린다.
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(2), T(20)],
    session: session({ endedAtMs: null }),   // host A 에서 진행 중인 열린 세션
    });
  assert.equal(d.reseed, false, '응답 시점부터 살아 있는 매니저가 하나라도 있으면 재시드 근거가 없다');
  assert.equal(d.reason, 'manager_instance_predates_holder_response');
  assert.equal(d.restartAtMs, 0);
});

test('전 인스턴스가 응답 이후 부팅했을 때만 재시드하고, 기준 시각은 그중 최솟값이다', () => {
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(30), T(20), T(25)],
    session: session(),
  });
  assert.equal(d.reseed, true, '응답 시점에 존재하던 매니저 프로세스가 하나도 남아 있지 않다');
  assert.equal(d.restartAtMs, T(20), '최댓값이 아니라 최솟값 — 가장 이른 부팅조차 응답보다 나중이어야 한다');
});

test('부팅 시각을 파싱할 수 없는 인스턴스가 있으면 보수적으로 재시드하지 않는다', () => {
  // "응답 이후임" 을 증명하지 못하는 인스턴스는 살아 있던 매니저일 수 있다.
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(20), Number.NaN],
    session: session(),
  });
  assert.equal(d.reseed, false);
  assert.equal(d.reason, 'manager_instance_boot_time_unknown');
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
  assert.equal(d.reason, 'manager_instance_predates_holder_response');
});

// --- 세션 종료 시각과 재시작 시각의 선후 관계 (리뷰 지적 2) ---
//
// 리뷰는 `endedAtMs >= restartAtMs` 같은 시간 교차를 요구했지만, 그 술어를 그대로
// 쓰면 **정상적인 self-update 케이스가 깨진다**: 매니저는 세션을 SIGTERM 하고
// 그 종료를 보고한 뒤 re-exec 하므로, 죽은 세션의 `ended_at` 은 새 인스턴스의
// `started_at` 보다 항상 **앞선다**. 아래 두 테스트가 그 경계를 고정한다.

test('재시작에 죽은 세션의 ended_at 은 새 인스턴스 부팅보다 앞선다 — 그래도 재시드한다', () => {
  // 매니저가 SIGTERM 을 보고한 뒤 re-exec 한 순서 그대로: ended(19) < boot(20).
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(20)],
    session: session({ startedAtMs: T(5), endedAtMs: T(19), signal: 'SIGTERM' }),
  });
  assert.equal(d.reseed, true, 'ended_at < restartAtMs 를 요구하면 이 주력 케이스가 깨진다');
  assert.equal(d.reason, 'holder_session_lost_to_manager_restart');
});

test('재시작보다 한참 전에 비정상 종료한 세션도 재시드한다 — 그 매니저 세대가 사라졌기 때문', () => {
  // 응답(10분) 직후 12분에 비정상 종료, 매니저는 한참 뒤 30분에 부팅.
  // 전칭 조건이 이미 "응답 시점에 있던 매니저는 하나도 안 남았다" 를 보장하므로
  // 그 세션은 확실히 죽었고 티켓은 그 뒤로 침묵했다 — 복구 대상이 맞다.
  const d = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(30)],
    session: session({ startedAtMs: T(5), endedAtMs: T(12), signal: 'SIGTERM' }),
  });
  assert.equal(d.reseed, true);
  assert.equal(d.reason, 'holder_session_lost_to_manager_restart');

  // 판별자는 종료 시각이 아니라 **종료 방식**이다: 같은 타이밍이어도 정상 종료면
  // holder 가 스스로 턴을 마친 것이므로 재시드하지 않는다(fec25d90).
  const normal = decideRestartReseed({
    holderProgressMs: HOLDER_RESPONDED_AT,
    managerStartedAtMs: [T(30)],
    session: session({ startedAtMs: T(5), endedAtMs: T(12), signal: null, exitCode: 0 }),
  });
  assert.equal(normal.reseed, false, '같은 타이밍 + 정상 종료 → 선택된 대기');
  assert.equal(normal.reason, 'session_completed_normally');
});
