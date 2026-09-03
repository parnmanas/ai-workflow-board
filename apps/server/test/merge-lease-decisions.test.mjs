// 랜딩 lease 순수 판정 진실표 (ticket e630b530).
//
// 부수효과 없는 판정 함수만 다룬다 — DB·시계·네트워크 없음. 동적 회귀는
// `merge-lease-serialization.test.mjs` 가 실제 sql.js DataSource 와 프로덕션
// 서비스 경로로 따로 검증한다. 여기서 잡으려는 것은 판정 규칙 자체의 회귀다:
//
//   1. liveness 가 "작업 예산"으로 퇴화하지 않는가 — 진행 중인 CI 대기가
//      있으면 무진행 시간이 아무리 길어도 살아 있어야 한다. 이게 깨지면
//      리퍼가 진행 중인 홀더를 뺏고 두 홀더가 동시에 랜딩한다.
//   2. 대기 상한이 grant 보다 **먼저** 평가되는가 — 순서가 뒤집히면 붐비는
//      스코프에서 상한이 영원히 평가되지 않아 정확히 기아가 된다.
//   3. 재검증 예산의 경계값.
//
// 컴파일된 dist/ 를 import 한다(`npm run build` 필요 — test 스크립트가 보장).

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '..', 'dist');

const {
  decideLeaseLiveness,
  decideWaiterOutcome,
  decideReverifyOutcome,
  parseMergeLeaseContext,
} = await import('file://' + path.join(DIST, 'modules', 'tickets', 'merge-lease.js'));

const {
  resolveMergeLease,
  parseMergeLeaseConfig,
  validateMergeLeaseConfigInput,
  serializeMergeLeaseConfig,
  DEFAULT_IDLE_TIMEOUT_MINUTES,
  DEFAULT_MAX_WAIT_MINUTES,
  DEFAULT_MAX_REVERIFY_ATTEMPTS,
} = await import('file://' + path.join(DIST, 'common', 'merge-lease-config.js'));

const MIN = 60_000;
const NOW = 1_700_000_000_000;

/** 기본은 "방금 획득했고 Merging 에 있고 CI 대기는 없음" = 살아 있는 홀더. */
function livenessInput(overrides = {}) {
  return {
    inMergingColumn: true,
    hasActiveCiWait: false,
    blockedOnOther: false,
    acquiredAtMs: NOW - 1 * MIN,
    lastProgressAtMs: NOW - 1 * MIN,
    nowMs: NOW,
    idleTimeoutMs: 20 * MIN,
    maxHoldMs: 120 * MIN,
    ...overrides,
  };
}

test('holder liveness', async (t) => {
  await t.test('정상 홀더는 살아 있다', () => {
    assert.equal(decideLeaseLiveness(livenessInput()), 'alive');
  });

  await t.test('Merging 을 떠난 홀더는 즉시 회수 대상', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({ inMergingColumn: false })),
      'reap_not_merging',
    );
  });

  await t.test('무진행이 idle 상한을 넘기면 회수', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({ lastProgressAtMs: NOW - 21 * MIN })),
      'reap_idle',
    );
  });

  await t.test('idle 상한 직전(경계)은 아직 살아 있다', () => {
    // now - lastProgress === idleTimeout 이면 회수. 1ms 모자라면 alive.
    assert.equal(
      decideLeaseLiveness(livenessInput({ lastProgressAtMs: NOW - 20 * MIN + 1 })),
      'alive',
    );
    assert.equal(
      decideLeaseLiveness(livenessInput({ lastProgressAtMs: NOW - 20 * MIN })),
      'reap_idle',
    );
  });

  // ★ 이 티켓의 설계 보정 A 그 자체 — 이게 깨지면 리퍼가 진행 중인 홀더를 뺏고
  //   홀더는 그 사실을 모른 채 push 로 진입해, 없애려던 경쟁이 되살아난다.
  await t.test('미해소 CI 대기가 있으면 무진행 시간이 아무리 길어도 살아 있다', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({
        hasActiveCiWait: true,
        lastProgressAtMs: NOW - 90 * MIN, // idle 상한의 4배 이상
      })),
      'alive',
    );
  });

  await t.test('CI 대기 중이어도 절대 상한(백스톱)은 이긴다', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({
        hasActiveCiWait: true,
        acquiredAtMs: NOW - 121 * MIN,
        lastProgressAtMs: NOW - 1 * MIN,
      })),
      'reap_max_hold',
    );
  });

  await t.test('acquiredAt 이 없으면 백스톱 판정을 건너뛴다', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({ acquiredAtMs: null, lastProgressAtMs: NOW })),
      'alive',
    );
  });

  // ★ pend_ticket 은 컬럼을 옮기지 않아 이동 트랜잭션의 해제 훅이 걸리지 않는다.
  //   사람의 답을 무기한 기다리는 티켓이 저장소 전체의 랜딩 구간을 쥐고 있으면
  //   안 되므로, liveness 규칙 한 곳에서 처리한다.
  await t.test('사람/다른 티켓을 기다리는 홀더는 진행 증거와 무관하게 회수된다', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({ blockedOnOther: true })),
      'reap_blocked',
    );
    // CI 가 돌고 있어도(가장 강한 진행 증거) 차단이 이긴다 — 사람 대기 중에
    // CI 결과가 와도 그 티켓은 진행할 수 없다.
    assert.equal(
      decideLeaseLiveness(livenessInput({ blockedOnOther: true, hasActiveCiWait: true })),
      'reap_blocked',
    );
  });

  await t.test('Merging 이탈은 CI 대기·백스톱보다 먼저 판정된다', () => {
    assert.equal(
      decideLeaseLiveness(livenessInput({ inMergingColumn: false, hasActiveCiWait: true })),
      'reap_not_merging',
    );
  });
});

function waiterInput(overrides = {}) {
  return {
    queuedAtMs: NOW - 1 * MIN,
    nowMs: NOW,
    maxWaitMs: 45 * MIN,
    isFifoHead: true,
    scopeFree: true,
    ...overrides,
  };
}

test('waiter outcome', async (t) => {
  await t.test('스코프가 비었고 FIFO 머리면 부여', () => {
    assert.equal(decideWaiterOutcome(waiterInput()), 'grant');
  });

  await t.test('스코프가 안 비었으면 계속 대기', () => {
    assert.equal(decideWaiterOutcome(waiterInput({ scopeFree: false })), 'keep_waiting');
  });

  await t.test('FIFO 머리가 아니면 계속 대기(기아 없는 순서 보장)', () => {
    assert.equal(decideWaiterOutcome(waiterInput({ isFifoHead: false })), 'keep_waiting');
  });

  // ★ 이 티켓의 fail-open 원칙 그 자체.
  await t.test('대기 상한을 넘기면 fail-open', () => {
    assert.equal(
      decideWaiterOutcome(waiterInput({ queuedAtMs: NOW - 46 * MIN })),
      'fail_open_timeout',
    );
  });

  await t.test('상한 판정이 grant 보다 먼저다 — 붐비는 스코프에서도 반드시 빠져나간다', () => {
    // 스코프가 계속 붐비고(scopeFree=false) 머리도 아닌(isFifoHead=false),
    // 즉 grant 가 절대 나올 수 없는 최악의 조합에서도 상한을 넘기면 탈출한다.
    // 순서를 뒤집어 grant 를 먼저 보면 이 케이스가 영원히 keep_waiting 이 되어
    // 정확히 기아가 된다.
    assert.equal(
      decideWaiterOutcome(waiterInput({
        queuedAtMs: NOW - 46 * MIN,
        isFifoHead: false,
        scopeFree: false,
      })),
      'fail_open_timeout',
    );
  });

  await t.test('상한 경계값', () => {
    assert.equal(
      decideWaiterOutcome(waiterInput({ queuedAtMs: NOW - 45 * MIN })),
      'fail_open_timeout',
    );
    assert.equal(
      decideWaiterOutcome(waiterInput({ queuedAtMs: NOW - 45 * MIN + 1 })),
      'grant',
    );
  });
});

test('reverify budget', async (t) => {
  await t.test('상한 미만은 계속', () => {
    assert.equal(decideReverifyOutcome(0, 3), 'continue');
    assert.equal(decideReverifyOutcome(2, 3), 'continue');
  });

  await t.test('상한에 도달하면 소진', () => {
    assert.equal(decideReverifyOutcome(3, 3), 'exhausted');
    assert.equal(decideReverifyOutcome(4, 3), 'exhausted');
  });
});

test('board config resolution', async (t) => {
  // ★ merge_gate_config 와 기본값이 반대라는 것이 이 기능의 핵심 결정이다.
  //   merge-gate 는 "기본 OFF" 로 출시된 뒤 이 인스턴스의 모든 보드에서 한 번도
  //   켜지지 않았다 — 같은 기본값이면 이 기능도 실무상 동작하지 않는다.
  await t.test('설정이 없으면 활성 (기본 ON)', () => {
    assert.equal(resolveMergeLease(null).enabled, true);
    assert.equal(resolveMergeLease('').enabled, true);
    assert.equal(resolveMergeLease('{}').enabled, true);
  });

  await t.test('명시적 false 만 끈다 (킬 스위치)', () => {
    assert.equal(resolveMergeLease('{"enabled":false}').enabled, false);
    assert.equal(resolveMergeLease('{"enabled":true}').enabled, true);
  });

  await t.test('깨진 JSON·스키마 위반도 활성으로 떨어진다', () => {
    // 깨진 설정 때문에 조용히 꺼져 루프가 되살아나는 것보다, 켜진 채
    // fail-open 하는 편이 안전하다.
    assert.equal(resolveMergeLease('{not json').enabled, true);
    assert.equal(resolveMergeLease('{"unknown_key":1}').enabled, true);
    assert.equal(parseMergeLeaseConfig('{"unknown_key":1}'), null);
  });

  await t.test('기본 타이밍 값', () => {
    const r = resolveMergeLease(null);
    assert.equal(r.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MINUTES * MIN);
    assert.equal(r.maxWaitMs, DEFAULT_MAX_WAIT_MINUTES * MIN);
    assert.equal(r.maxReverifyAttempts, DEFAULT_MAX_REVERIFY_ATTEMPTS);
  });

  await t.test('보드별 오버라이드가 반영된다', () => {
    const r = resolveMergeLease('{"idle_timeout_minutes":5,"max_wait_minutes":7,"max_reverify_attempts":2}');
    assert.equal(r.idleTimeoutMs, 5 * MIN);
    assert.equal(r.maxWaitMs, 7 * MIN);
    assert.equal(r.maxReverifyAttempts, 2);
  });

  await t.test('쓰기 경로는 오타 난 키를 거부한다', () => {
    assert.equal(validateMergeLeaseConfigInput({ enabled: false }).ok, true);
    assert.equal(validateMergeLeaseConfigInput({ enabld: false }).ok, false);
    assert.equal(validateMergeLeaseConfigInput({ max_wait_minutes: -1 }).ok, false);
  });

  await t.test('빈 설정은 null 로 접힌다', () => {
    assert.equal(serializeMergeLeaseConfig({}), null);
    assert.equal(serializeMergeLeaseConfig(null), null);
    assert.equal(serializeMergeLeaseConfig({ enabled: false }), '{"enabled":false}');
  });
});

test('lease context parsing', async (t) => {
  await t.test('정상 컨텍스트', () => {
    const ctx = parseMergeLeaseContext(JSON.stringify({
      lease_id: 'L1', repo_resource_id: 'R1', base_branch: 'main',
      queued_at: '2026-09-03T00:00:00.000Z', requested_by: 'Rolf/Programmer', ahead_ticket_id: 'T9',
    }));
    assert.equal(ctx.lease_id, 'L1');
    assert.equal(ctx.base_branch, 'main');
    assert.equal(ctx.ahead_ticket_id, 'T9');
  });

  await t.test('비었거나 깨졌거나 필수 필드가 없으면 null', () => {
    assert.equal(parseMergeLeaseContext(''), null);
    assert.equal(parseMergeLeaseContext(null), null);
    assert.equal(parseMergeLeaseContext('{oops'), null);
    assert.equal(parseMergeLeaseContext('{"lease_id":"L1"}'), null); // repo 없음
  });
});
