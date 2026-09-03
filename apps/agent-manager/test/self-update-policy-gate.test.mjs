// ticket 9408b308 — 갱신 개시 정책 스위치(manual/scheduled/auto)와 유지보수 창.
//
// 이 스위트가 지켜야 하는 것 중 가장 중요한 한 줄: **`scheduled` 는 창 안에서도
// 설치를 개시하지 않는다.** 창을 "무인 실행 시각"으로 잘못 구현해도 순수 함수의
// 반환값만 보는 테스트는 통과할 수 있으므로, 아래 검증은 순수 판정 함수와
// **프로덕션 UpdateChecker 의 tick 경로** 두 층에서 각각 단언한다 — 후자는
// 주입한 개시 포트가 실제로 몇 번 불렸는지를 센다(0 번이어야 한다).
//
// 네트워크 없이 "새 버전이 올라왔다"를 만들기 위해 UpdateChecker 의 npmView
// 포트를 주입한다. 그 외 경로(파싱, semver 비교, 상태 갱신, 게이트 호출)는 전부
// 프로덕션 코드 그대로 돈다.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  UpdateChecker,
  evaluateUpdatePolicyGate,
  resolveUpdatePolicy,
  UPDATE_POLICY_ENV,
  UPDATE_CHANNEL_OFF,
} from '../dist/lib/self-update.js';
import {
  readUpdateApproval,
  writeUpdateApproval,
  updateApprovalPath,
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
function makeChecker(t, { policy, window, latest, home, now = () => AT_10_00, channel = 'latest' }) {
  const starts = [];
  const logs = [];
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
    npmView: async () => ({ ok: true, stdout: `${latestVersion}\n`, stderr: '' }),
    runUpdate: async (opts) => {
      starts.push(opts);
      return { changed: true, summary: 'stub install' };
    },
  });
  t.after(() => checker.stop());
  return { checker, starts, logs, setLatest: (v) => { latestVersion = v; } };
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
