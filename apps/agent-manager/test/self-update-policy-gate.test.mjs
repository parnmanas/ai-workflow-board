// ticket 9408b308 — 갱신 개시 정책 스위치(manual/scheduled/auto)와 유지보수 창.
//
// 이 스위트가 지켜야 하는 것 중 가장 중요한 한 줄: **`scheduled` 는 창 안에서도
// 설치를 개시하지 않는다.** 창을 "무인 실행 시각"으로 잘못 구현해도 순수 함수의
// 반환값만 보는 테스트는 통과할 수 있으므로, 아래 검증은 순수 판정 함수와
// **프로덕션 UpdateChecker 의 tick 경로** 두 층에서 각각 단언한다 — 후자는
// 주입한 개시 포트가 실제로 몇 번 불렸는지를 센다(0 번이어야 한다).
//
// 네트워크 없이 "새 버전이 올라왔다"를 만들기 위해 UpdateChecker 의 npmView 와
// verifyProvenance 포트를 주입한다. 그 외 경로(파싱, semver 비교, 상태 갱신,
// 게이트 호출)는 전부 프로덕션 코드 그대로 돈다.
//
// 리뷰 라운드 1 에서 드러난 두 구멍도 여기서 막는다:
//   P1 — 승인 요청이 provenance 검증 **전에** 나가던 문제. 순수 함수는 provenance
//        를 입력으로 받지 않으므로 이 계약은 tick 경로에서만 검증된다.
//   P2 — `channel=off` 판정 줄이 프로덕션에서 한 줄도 안 남던 문제(#tick 이 그 앞에서
//        return). 개시 횟수만 세는 테스트로는 드러나지 않는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UpdateChecker,
  evaluateUpdatePolicyGate,
  resolveUpdatePolicy,
  runSelfUpdate,
  _resetSelfUpdateInFlightForTests,
  UPDATE_POLICY_ENV,
  UPDATE_CHANNEL_OFF,
} from '../dist/lib/self-update.js';
import {
  readUpdateApproval,
  writeUpdateApproval,
  updateApprovalPath,
  writeUpdatePin,
} from '../dist/lib/self-update-rollback.js';

/** 창이 확실히 열려 있는/닫혀 있는 시각. 창 판정은 호스트 로컬 시각을 쓴다. */
const AT_10_00 = new Date(2026, 8, 3, 10, 0, 0);
const WINDOW_OPEN_AT_10 = '09:00-11:00';
const WINDOW_CLOSED_AT_10 = '02:00-04:00';

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awb-policy-gate-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 판정 입력의 기본형 — 각 테스트는 바꾸려는 축만 덮어쓴다. */
function gateInput(over = {}) {
  return {
    policy: 'manual',
    channel: 'latest',
    windowRaw: WINDOW_OPEN_AT_10,
    now: AT_10_00,
    updateAvailable: true,
    latestVersion: '1.7.0',
    approvedVersion: null,
    ...over,
  };
}

// ─── resolveUpdatePolicy ────────────────────────────────────────────────────

test('resolveUpdatePolicy: 미설정/공백/모르는 값은 전부 manual 로 떨어진다', () => {
  assert.equal(resolveUpdatePolicy(''), 'manual');
  assert.equal(resolveUpdatePolicy('   '), 'manual');
  assert.equal(resolveUpdatePolicy('automatic'), 'manual');
  assert.equal(resolveUpdatePolicy('SCHEDULE'), 'manual');
  assert.equal(resolveUpdatePolicy(null), 'manual');
});

test('resolveUpdatePolicy: 아는 값은 대소문자 무시하고 인식한다', () => {
  assert.equal(resolveUpdatePolicy('manual'), 'manual');
  assert.equal(resolveUpdatePolicy('scheduled'), 'scheduled');
  assert.equal(resolveUpdatePolicy('auto'), 'auto');
  assert.equal(resolveUpdatePolicy('  AUTO  '), 'auto');
});

test('resolveUpdatePolicy: 인자 없으면 환경변수를 읽는다', (t) => {
  const previous = process.env[UPDATE_POLICY_ENV];
  t.after(() => {
    if (previous === undefined) delete process.env[UPDATE_POLICY_ENV];
    else process.env[UPDATE_POLICY_ENV] = previous;
  });
  process.env[UPDATE_POLICY_ENV] = 'scheduled';
  assert.equal(resolveUpdatePolicy(), 'scheduled');
  delete process.env[UPDATE_POLICY_ENV];
  assert.equal(resolveUpdatePolicy(), 'manual');
});

// ─── 우선순위 전수 (완료 기준 2) ────────────────────────────────────────────
// off 는 어떤 정책보다 우선하는 하드 핀이다. auto + 창 안이라는, 이 코드베이스가
// 무인 개시를 허용하는 유일한 조합에서도 off 가 이겨야 한다.

test('channel=off 는 세 정책값을 모두 이긴다 — 창 안이어도 개시하지 않는다', () => {
  for (const policy of ['manual', 'scheduled', 'auto']) {
    const r = evaluateUpdatePolicyGate(gateInput({ policy, channel: UPDATE_CHANNEL_OFF }));
    assert.equal(r.action, 'none', `${policy} + off 는 아무것도 하지 않아야 한다`);
    assert.equal(r.reason, 'channel_off');
    assert.equal(r.approvalVersion, null, `${policy} + off 는 승인 요청도 하지 않아야 한다`);
  }
});

test('정책 × 창 × 채널 조합 전수 — 개시(start)는 auto+창안+채널켜짐 하나뿐이다', () => {
  const policies = ['manual', 'scheduled', 'auto'];
  const channels = ['latest', UPDATE_CHANNEL_OFF];
  const windows = [WINDOW_OPEN_AT_10, WINDOW_CLOSED_AT_10, '', 'not-a-window'];

  const started = [];
  const requested = [];
  for (const policy of policies) {
    for (const channel of channels) {
      for (const windowRaw of windows) {
        const r = evaluateUpdatePolicyGate(gateInput({ policy, channel, windowRaw }));
        const key = `${policy}|${channel}|${windowRaw || '(unset)'}`;
        if (r.action === 'start') started.push(key);
        if (r.action === 'request_approval') requested.push(key);
      }
    }
  }

  // 승인 없이 개시하는 조합은 정확히 하나 — auto + 켜진 채널 + 열린 창.
  assert.deepEqual(started, [`auto|latest|${WINDOW_OPEN_AT_10}`]);
  // 승인 요청은 scheduled + 켜진 채널 + 열린 창 하나뿐.
  assert.deepEqual(requested, [`scheduled|latest|${WINDOW_OPEN_AT_10}`]);
});

test('창 미설정/형식오류는 scheduled·auto 를 보수적으로 manual 과 같게 떨어뜨린다', () => {
  for (const policy of ['scheduled', 'auto']) {
    for (const windowRaw of ['', null, undefined, 'not-a-window', '25:00-26:00', '10:00-10:00']) {
      const r = evaluateUpdatePolicyGate(gateInput({ policy, windowRaw }));
      assert.equal(r.action, 'none', `${policy} + 창(${String(windowRaw)}) 은 개시하면 안 된다`);
      assert.equal(r.reason, 'no_window');
    }
  }
});

test('새 버전이 없으면 창 안이어도 아무 판정도 내리지 않는다', () => {
  for (const policy of ['scheduled', 'auto']) {
    const r = evaluateUpdatePolicyGate(gateInput({ policy, updateAvailable: false }));
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'up_to_date');
  }
});

test('창 밖이면 auto 도 개시하지 않고 scheduled 도 요청하지 않는다 (완료 기준 7 후반)', () => {
  for (const policy of ['scheduled', 'auto']) {
    const r = evaluateUpdatePolicyGate(gateInput({ policy, windowRaw: WINDOW_CLOSED_AT_10 }));
    assert.equal(r.action, 'none');
    assert.equal(r.reason, 'outside_window');
  }
});

test('scheduled 는 창 안에서 승인 요청만 한다 — 절대 start 를 내지 않는다', () => {
  const r = evaluateUpdatePolicyGate(gateInput({ policy: 'scheduled' }));
  assert.equal(r.action, 'request_approval');
  assert.notEqual(r.action, 'start');
  assert.equal(r.approvalVersion, '1.7.0');
});

test('승인은 대상 버전과 정확히 같을 때만 인정된다 (완료 기준 6)', () => {
  // 같은 버전 → 개시
  const approved = evaluateUpdatePolicyGate(
    gateInput({ policy: 'scheduled', approvedVersion: '1.7.0' }),
  );
  assert.equal(approved.action, 'start');
  assert.equal(approved.reason, 'approved');

  // 더 새 버전이 올라옴 → 예전 승인은 무효, 다시 요청
  const superseded = evaluateUpdatePolicyGate(
    gateInput({ policy: 'scheduled', approvedVersion: '1.7.0', latestVersion: '1.8.0' }),
  );
  assert.equal(superseded.action, 'request_approval');
  assert.equal(superseded.approvalVersion, '1.8.0');

  // auto 는 승인 자체를 보지 않는다.
  const auto = evaluateUpdatePolicyGate(gateInput({ policy: 'auto', approvedVersion: null }));
  assert.equal(auto.action, 'start');
  assert.equal(auto.reason, 'auto_in_window');
});

test('판정마다 Self-update 로그로 쓸 한 줄이 있고 서로 구분된다 (완료 기준 8)', () => {
  const lines = new Map();
  for (const [label, over] of [
    ['channel_off', { channel: UPDATE_CHANNEL_OFF }],
    ['policy_manual', { policy: 'manual' }],
    ['up_to_date', { policy: 'auto', updateAvailable: false }],
    ['no_window', { policy: 'auto', windowRaw: '' }],
    ['outside_window', { policy: 'auto', windowRaw: WINDOW_CLOSED_AT_10 }],
    ['auto_in_window', { policy: 'auto' }],
    ['approved', { policy: 'scheduled', approvedVersion: '1.7.0' }],
    ['awaiting_approval', { policy: 'scheduled' }],
  ]) {
    const r = evaluateUpdatePolicyGate(gateInput(over));
    assert.equal(r.reason, label);
    assert.equal(typeof r.logLine, 'string');
    assert.ok(r.logLine.length > 0, `${label} 은 로그 한 줄을 내야 한다`);
    assert.ok(!lines.has(r.logLine), `${label} 의 로그가 ${lines.get(r.logLine)} 와 구분되지 않는다`);
    lines.set(r.logLine, label);
  }
});

// ─── 승인 기록 영속 (호스트 × 버전) ─────────────────────────────────────────

test('승인 기록은 매니저 홈 파일이다 — 다른 홈(=다른 호스트)에는 적용되지 않는다', (t) => {
  const hostA = tempHome(t);
  const hostB = tempHome(t);

  writeUpdateApproval({ version: '1.7.0', source: 'update_manager', approvedAtMs: 1 }, hostA);

  assert.equal(readUpdateApproval(hostA)?.version, '1.7.0');
  assert.equal(readUpdateApproval(hostB), null, '다른 호스트 홈에는 승인이 없어야 한다');
  assert.ok(existsSync(updateApprovalPath(hostA)));
  assert.ok(!existsSync(updateApprovalPath(hostB)));
});

test('손상된 승인 기록은 승인으로 읽지 않는다 (안전한 실패 방향)', (t) => {
  const home = tempHome(t);
  writeUpdateApproval({ version: 'not-a-version', source: 'x', approvedAtMs: 1 }, home);
  assert.equal(readUpdateApproval(home), null);
});

// ─── 프로덕션 tick 경로 (여기가 진짜 회귀 방어선) ───────────────────────────

/**
 * 프로덕션 UpdateChecker 를 네트워크 없이 구동한다. 개시 포트 호출을 세어
 * "설치를 개시했는가"를 부수효과 없이 관찰한다.
 */
function makeChecker(
  t,
  {
    policy,
    window,
    latest,
    home,
    now = () => AT_10_00,
    channel = 'latest',
    // 리뷰 P1: 승인 요청은 provenance 를 통과해야만 나간다. 기본 스텁은 npmView 가
    // 보고하는 것과 같은 버전을 검증 통과로 돌려준다. provenance 를 주입하지 않으면
    // 프로덕션 코드가 실제 레지스트리를 부르므로, 이 스텁이 없는 테스트는 곧
    // 네트워크 테스트가 된다.
    provenance,
  },
) {
  const starts = [];
  const logs = [];
  const provenanceCalls = [];
  const npmViewCalls = [];
  let latestVersion = latest;
  const checker = new UpdateChecker({
    installMode: 'npm-global',
    updateChannel: channel,
    currentVersion: '1.6.0',
    updatePolicy: policy,
    updateWindow: window,
    stateDir: home,
    now,
    log: (m) => logs.push(m),
    npmView: async (spec) => {
      npmViewCalls.push(spec);
      return { ok: true, stdout: `${latestVersion}\n`, stderr: '' };
    },
    verifyProvenance: async (ch) => {
      provenanceCalls.push(ch);
      if (typeof provenance === 'function') return provenance(latestVersion);
      return { ok: true, version: latestVersion, reason: `stub: v${latestVersion} carries provenance` };
    },
    runUpdate: async (opts) => {
      starts.push(opts);
      return { changed: true, summary: 'stub install' };
    },
  });
  t.after(() => checker.stop());
  return {
    checker,
    starts,
    logs,
    provenanceCalls,
    npmViewCalls,
    setLatest: (v) => { latestVersion = v; },
  };
}

test('두 env 미설정(=manual)이면 tick 이 아무것도 개시하지 않는다 (완료 기준 1)', async (t) => {
  const home = tempHome(t);
  const { checker, starts, logs } = makeChecker(t, {
    policy: 'manual', window: undefined, latest: '1.7.0', home,
  });

  const status = await checker.checkNow();

  assert.equal(starts.length, 0, 'manual 은 개시하지 않는다');
  assert.equal(status.update_available, true, '새 버전 광고는 그대로 동작해야 한다');
  assert.equal(status.latest_version, '1.7.0');
  assert.equal(status.update_approval_pending_version, null, 'manual 은 승인도 요청하지 않는다');
  assert.ok(logs.some((l) => l.includes('Self-update: update policy manual')));
});

test('channel=off 는 정책이 auto 여도 tick 자체가 개시로 가지 않는다 (완료 기준 2)', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home, channel: UPDATE_CHANNEL_OFF,
  });

  const status = await checker.checkNow();

  assert.equal(starts.length, 0, 'off 는 auto 를 이긴다');
  assert.equal(status.update_approval_pending_version, null);
});

test('scheduled + 창 안 → 승인 요청만 하고 설치를 개시하지 않는다 (완료 기준 3)', async (t) => {
  const home = tempHome(t);
  const { checker, starts, logs } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });

  const status = await checker.checkNow();

  assert.equal(starts.length, 0, 'scheduled 는 창 안이어도 설치를 개시하지 않는다');
  assert.equal(status.update_approval_pending_version, '1.7.0');
  assert.ok(logs.some((l) => l.includes('requesting operator approval for v1.7.0')));
  // 승인 기록이 저절로 생기지 않는다 — 요청은 요청일 뿐이다.
  assert.equal(readUpdateApproval(home), null);
});

test('scheduled 는 미승인 상태로 창을 여러 번 지나가도 무인 실행으로 승격되지 않는다 (완료 기준 5)', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });

  // 창을 세 번 통과시킨다(시계는 계속 창 안이다).
  await checker.checkNow();
  await checker.checkNow();
  const status = await checker.checkNow();

  assert.equal(starts.length, 0, '시간이 지난다고 승인 없이 개시되면 안 된다');
  assert.equal(status.update_approval_pending_version, '1.7.0', '요청은 계속 표면화된다');
});

test('scheduled + 승인 기록 → 개시한다. 그 뒤 새 버전이 오면 다시 요청한다 (완료 기준 6)', async (t) => {
  const home = tempHome(t);
  const { checker, starts, setLatest } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });

  // 1) 미승인 — 요청만.
  await checker.checkNow();
  assert.equal(starts.length, 0);

  // 2) 운영자가 v1.7.0 을 승인 — 개시된다.
  writeUpdateApproval({ version: '1.7.0', source: 'update_manager', approvedAtMs: 1 }, home);
  const approvedTick = await checker.checkNow();
  assert.equal(starts.length, 1, '승인된 버전은 개시된다');
  assert.equal(approvedTick.update_approval_pending_version, null, '개시 중에는 대기 신호가 없다');

  // 3) 승인 소진 전에 더 새 버전이 올라옴 — 예전 승인은 이 버전에 적용되지 않는다.
  setLatest('1.8.0');
  const supersededTick = await checker.checkNow();
  assert.equal(starts.length, 1, '승인되지 않은 v1.8.0 을 개시하면 안 된다');
  assert.equal(supersededTick.update_approval_pending_version, '1.8.0', '새 버전에 대해 다시 요청한다');
});

test('auto + 창 안 → 승인 없이 개시. auto + 창 밖 → 개시하지 않는다 (완료 기준 7)', async (t) => {
  const homeIn = tempHome(t);
  const inWindow = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home: homeIn,
  });
  await inWindow.checker.checkNow();
  assert.equal(inWindow.starts.length, 1, 'auto 는 창 안에서 승인 없이 개시한다');
  assert.equal(readUpdateApproval(homeIn), null, 'auto 는 승인 기록을 요구하지 않는다');

  const homeOut = tempHome(t);
  const outWindow = makeChecker(t, {
    policy: 'auto', window: WINDOW_CLOSED_AT_10, latest: '1.7.0', home: homeOut,
  });
  const status = await outWindow.checker.checkNow();
  assert.equal(outWindow.starts.length, 0, 'auto 도 창 밖에서는 개시하지 않는다');
  assert.equal(status.update_approval_pending_version, null);
});

test('개시는 격리된 stateDir 을 그대로 물려준다 — 정책 경로가 매니저 홈을 우회하지 않는다', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });
  await checker.checkNow();
  assert.equal(starts.length, 1);
  assert.equal(starts[0].stateDir, home);
});

test('같은 판정이 이어지면 로그는 한 번만, 판정이 바뀌면 새 줄이 나온다', async (t) => {
  const home = tempHome(t);
  const { checker, logs, setLatest } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });

  await checker.checkNow();
  await checker.checkNow();
  const first = logs.filter((l) => l.includes('requesting operator approval for v1.7.0'));
  assert.equal(first.length, 1, '같은 판정을 tick 마다 반복해 찍지 않는다');

  setLatest('1.8.0');
  await checker.checkNow();
  assert.ok(
    logs.some((l) => l.includes('requesting operator approval for v1.8.0')),
    '판정이 바뀌면 새 줄이 나온다',
  );
});

// ─── 리뷰 P1: 승인 요청은 provenance 를 통과한 뒤에만 나간다 ─────────────────
//
// 이 블록이 없으면 서명되지 않은(혹은 증명을 읽을 수 없는) 릴리스도 운영자에게
// "승인해 달라"는 요청 + 감사행으로 먼저 표면화된다. 순수 판정 함수는 provenance
// 를 입력으로 받지 않으므로, 이 계약은 **프로덕션 tick 경로에서만** 검증된다.

test('scheduled: provenance 거부면 승인 대기 신호도 감사 대상도 만들지 않는다 (fail-closed)', async (t) => {
  const home = tempHome(t);
  const { checker, starts, logs } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: () => ({ ok: false, version: '1.7.0', reason: 'no SLSA provenance attached' }),
  });

  const status = await checker.checkNow();

  assert.equal(status.update_approval_pending_version, null, '거부된 릴리스를 승인 요청으로 올리면 안 된다');
  assert.equal(starts.length, 0, '설치도 개시하지 않는다');
  assert.ok(
    logs.some((l) => l.includes('approval NOT requested') && l.includes('no SLSA provenance attached')),
    '거부 사유가 Self-update 로그로 남아야 한다',
  );
});

test('scheduled: provenance 조회가 실패(throw)해도 fail-closed — 요청하지 않는다', async (t) => {
  const home = tempHome(t);
  const { checker, starts, logs } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: () => { throw new Error('registry unreachable'); },
  });

  const status = await checker.checkNow();

  assert.equal(status.update_approval_pending_version, null);
  assert.equal(starts.length, 0);
  assert.ok(logs.some((l) => l.includes('provenance check threw') && l.includes('registry unreachable')));
});

test('scheduled: provenance 가 대상 버전을 못 집으면 요청하지 않는다', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: () => ({ ok: true, version: null, reason: 'attestation present but version unreadable' }),
  });

  const status = await checker.checkNow();

  assert.equal(status.update_approval_pending_version, null);
  assert.equal(starts.length, 0);
});

test('요청하는 버전은 npm view 가 아니라 provenance 가 검증한 그 버전이다 (검증≡요청)', async (t) => {
  const home = tempHome(t);
  // dist-tag 가 두 조회 사이에 움직인 상황: npm view 는 1.7.0, 증명 조회는 1.7.1.
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: () => ({ ok: true, version: '1.7.1', reason: 'v1.7.1 carries SLSA provenance' }),
  });

  const status = await checker.checkNow();

  assert.equal(
    status.update_approval_pending_version,
    '1.7.1',
    '승인 대상은 검증한 버전이어야 한다 — 검증하지 않은 1.7.0 을 요청하면 승인이 의미를 잃는다',
  );
  assert.equal(starts.length, 0);
});

test('검증된 버전이 이미 승인돼 있으면 그대로 개시한다 (재판정이 승인을 인식)', async (t) => {
  const home = tempHome(t);
  writeUpdateApproval({ version: '1.7.1', source: 'update_manager', approvedAtMs: 1 }, home);
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: () => ({ ok: true, version: '1.7.1', reason: 'v1.7.1 carries SLSA provenance' }),
  });

  const status = await checker.checkNow();

  assert.equal(starts.length, 1, '검증된 버전이 승인된 버전과 같으면 개시한다');
  assert.equal(status.update_approval_pending_version, null);
});

test('검증된 버전이 현재보다 낮으면(태그 되감김) 개시도 요청도 하지 않는다', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    // 현재 버전은 1.6.0 — 1.5.0 은 다운그레이드다.
    provenance: () => ({ ok: true, version: '1.5.0', reason: 'v1.5.0 carries SLSA provenance' }),
  });

  const status = await checker.checkNow();

  assert.equal(starts.length, 0);
  assert.equal(status.update_approval_pending_version, null);
});

test('거부 상태는 고착되지 않는다 — 다음 tick 에서 통과하면 요청이 다시 올라온다', async (t) => {
  const home = tempHome(t);
  let ok = false;
  const { checker, starts } = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
    provenance: (v) =>
      ok
        ? { ok: true, version: v, reason: `v${v} carries SLSA provenance` }
        : { ok: false, version: v, reason: 'transient: could not read publish provenance' },
  });

  assert.equal((await checker.checkNow()).update_approval_pending_version, null);
  ok = true;
  assert.equal((await checker.checkNow()).update_approval_pending_version, '1.7.0');
  assert.equal(starts.length, 0, '요청이 올라왔다고 설치가 개시되면 안 된다');
});

test('auto 개시 경로는 tick 에서 provenance 를 다시 부르지 않는다 (runSelfUpdate 가 이미 fail-closed)', async (t) => {
  const home = tempHome(t);
  const { checker, starts, provenanceCalls } = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home,
  });

  await checker.checkNow();

  assert.equal(starts.length, 1);
  assert.equal(
    provenanceCalls.length,
    0,
    'auto 는 곧바로 runSelfUpdate 로 가므로 여기서 한 번 더 부르면 레지스트리 왕복만 두 배가 된다',
  );
});

test('요청이 없는 판정(manual · 창 밖)에서는 provenance 를 아예 부르지 않는다', async (t) => {
  const manualHome = tempHome(t);
  const manual = makeChecker(t, {
    policy: 'manual', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home: manualHome,
  });
  await manual.checker.checkNow();
  assert.equal(manual.provenanceCalls.length, 0);

  const outHome = tempHome(t);
  const outside = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_CLOSED_AT_10, latest: '1.7.0', home: outHome,
  });
  await outside.checker.checkNow();
  assert.equal(outside.provenanceCalls.length, 0);
});

// ─── 리뷰 P2: off 판정이 프로덕션 로그에 실제로 남는다 ──────────────────────
//
// evaluateUpdatePolicyGate 에 channel_off 문구가 있어도, tick 이 그 앞에서
// return 하면 프로덕션에서는 한 줄도 남지 않는다 — 완료 기준 8 의 grep 계약이
// 깨지는데 `starts.length` 만 보는 테스트로는 드러나지 않는다.

test('off × 세 정책 모두 tick 에서 Self-update 판정 줄을 남기고, 레지스트리는 조회하지 않는다', async (t) => {
  for (const policy of ['manual', 'scheduled', 'auto']) {
    const home = tempHome(t);
    const { checker, starts, logs, npmViewCalls, provenanceCalls } = makeChecker(t, {
      policy, window: WINDOW_OPEN_AT_10, latest: '1.7.0', home, channel: UPDATE_CHANNEL_OFF,
    });

    const status = await checker.checkNow();

    const decisionLines = logs.filter((l) => l.startsWith('Self-update: ') && l.includes('off'));
    assert.equal(
      decisionLines.length,
      1,
      `${policy} + off 는 Self-update 판정 줄을 정확히 한 줄 남겨야 한다 (실제: ${JSON.stringify(logs)})`,
    );
    assert.equal(starts.length, 0, `${policy} + off 는 개시하지 않는다`);
    assert.equal(status.update_approval_pending_version, null, `${policy} + off 는 승인 요청도 없다`);
    assert.equal(npmViewCalls.length, 0, 'off 는 레지스트리 조회 자체를 하지 않는다');
    assert.equal(provenanceCalls.length, 0, 'off 는 provenance 조회도 하지 않는다');
  }
});

test('off 는 주기 tick 이 아예 돌지 않으므로 start() 가 판정 줄을 남기는 유일한 지점이다', async (t) => {
  const home = tempHome(t);
  const { checker, logs, starts } = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home, channel: UPDATE_CHANNEL_OFF,
  });

  checker.start();
  // start() 안의 판정은 비동기로 예약된다 — 마이크로태스크가 비워질 때까지 기다린다.
  await new Promise((r) => setImmediate(r));

  assert.ok(
    logs.some((l) => l.startsWith('Self-update: ') && l.includes('off')),
    `start() 도 Self-update 판정 줄을 남겨야 한다 (실제: ${JSON.stringify(logs)})`,
  );
  assert.equal(starts.length, 0);
});

// ─── 승인한 버전 ≡ 설치되는 버전 ────────────────────────────────────────────
//
// 리뷰 P1(검증≡요청)을 고치면서 같은 결함 계열의 잔여 구멍이 드러났다: 승인으로
// 개시할 때 설치 경로가 채널(`latest`)을 **다시** 해석하므로, 승인 판정과 설치
// 사이에 dist-tag 가 움직이면 승인한 적 없는 버전이 설치된다. 그러면 "승인은
// (호스트 × 버전) 1회성"(완료 기준 6)이 실질적으로 무너진다.
//
// 아래 테스트는 `noReExec: true` 로 **설치 직전**에서 멈춘다 — 실제 설치나 분리
// 헬퍼를 띄우지 않으므로 POSIX/Windows 양축에서 그대로 돈다(그래서 skip 이 없다).

/** 설치/증명/재기동/프로브를 전부 가짜로 물린 포트. 증명 버전 = 요청한 채널. */
function pinPorts() {
  const calls = { provenance: [], install: [] };
  const ports = {
    install: async (spec) => { calls.install.push(spec); return { ok: true, detail: '' }; },
    verifyProvenance: async (channel) => {
      calls.provenance.push(channel);
      return {
        ok: true,
        version: channel === 'latest' ? '99.0.0' : channel,
        reason: `fake ok for ${channel}`,
      };
    },
    restart: () => {},
    probe: async () => ({ ok: true, reportedVersion: '99.0.0', detail: 'fake' }),
  };
  return { ports, calls };
}

test('pinnedTargetVersion 없이는 채널을 다시 해석한다 (기존 동작 — 대조군)', async (t) => {
  const home = tempHome(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = pinPorts();
  const r = await runSelfUpdate({ stateDir: home, ports, noReExec: true, log: () => {} });

  assert.deepEqual(calls.provenance, ['latest'], '핀이 없으면 채널 그대로 조회한다');
  assert.match(r.summary, /awb-agent-manager@99\.0\.0/);
  assert.equal(calls.install.length, 0, 'noReExec 은 설치 직전에서 멈춘다');
});

test('승인된 개시는 그 버전으로 설치를 고정한다 — 채널이 다시 해석되지 않는다', async (t) => {
  const home = tempHome(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  const { ports, calls } = pinPorts();
  const r = await runSelfUpdate({
    stateDir: home, ports, noReExec: true, log: () => {},
    pinnedTargetVersion: '98.0.0',
  });

  assert.deepEqual(
    calls.provenance,
    ['98.0.0'],
    '승인한 버전으로 조회해야 한다 — latest 로 조회하면 그 사이 움직인 태그가 들어온다',
  );
  assert.match(r.summary, /awb-agent-manager@98\.0\.0/);
  assert.doesNotMatch(r.summary, /99\.0\.0/, '승인하지 않은 버전이 설치 spec 에 들어가면 안 된다');
});

test('복귀 핀은 승인 고정보다 우선한다 — 안전 핀이 승인보다 세다', async (t) => {
  const home = tempHome(t);
  _resetSelfUpdateInFlightForTests();
  t.after(() => _resetSelfUpdateInFlightForTests());

  writeUpdatePin({ version: '97.0.0', reason: 'boot verification failed', pinnedAtMs: 1 }, home);
  const { ports, calls } = pinPorts();
  await runSelfUpdate({
    stateDir: home, ports, noReExec: true, log: () => {},
    pinnedTargetVersion: '98.0.0',
  });

  assert.deepEqual(
    calls.provenance,
    ['97.0.0'],
    '복귀 핀이 걸려 있으면 승인 고정이 그것을 덮어써서는 안 된다',
  );
});

test('정책 경로: 승인 개시만 pinnedTargetVersion 을 넘기고, auto 는 넘기지 않는다', async (t) => {
  const approvedHome = tempHome(t);
  writeUpdateApproval({ version: '1.7.0', source: 'update_manager', approvedAtMs: 1 }, approvedHome);
  const approved = makeChecker(t, {
    policy: 'scheduled', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home: approvedHome,
  });
  await approved.checker.checkNow();
  assert.equal(approved.starts.length, 1);
  assert.equal(
    approved.starts[0].pinnedTargetVersion,
    '1.7.0',
    '승인으로 개시하면 그 버전으로 설치를 고정해야 한다',
  );

  const autoHome = tempHome(t);
  const auto = makeChecker(t, {
    policy: 'auto', window: WINDOW_OPEN_AT_10, latest: '1.7.0', home: autoHome,
  });
  await auto.checker.checkNow();
  assert.equal(auto.starts.length, 1);
  assert.equal(
    auto.starts[0].pinnedTargetVersion,
    undefined,
    'auto 는 승인을 보지 않으므로 채널 의미(항상 최신)를 그대로 둔다',
  );
});
