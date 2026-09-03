// ticket 9408b308 — 승인 요청의 **전달 경로**.
//
// 정책값 자체보다 이쪽이 중요하다: 전달 경로가 없으면 `scheduled` 는 `manual` 과
// 동작이 완전히 같아진다(승인을 요청해도 아무도 볼 수 없으므로). 그래서 여기서는
// 프로덕션 UpdateChecker 를 실제로 승인 대기 상태까지 몰아넣고, InstanceHeartbeat
// 이 **실제로 POST 하는 본문**을 잡아 그 값이 실렸는지 본다 — 내부 객체가 아니라
// 와이어를 보는 이유는 producer 쪽 flatten 버그가 숨을 수 없게 하기 위해서다
// (manager-capabilities-heartbeat.test.mjs 와 같은 기법).

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';
import { UpdateChecker } from '../dist/lib/self-update.js';
import { writeUpdateApproval } from '../dist/lib/self-update-rollback.js';

const AT_10_00 = new Date(2026, 8, 3, 10, 0, 0);
const WINDOW_OPEN_AT_10 = '09:00-11:00';

function stubFetch(t) {
  const originalFetch = globalThis.fetch;
  let resolvePayload;
  const payloadPromise = new Promise((resolve) => { resolvePayload = resolve; });
  globalThis.fetch = async (_url, init) => {
    resolvePayload(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return payloadPromise;
}

function tempHome(t) {
  const dir = mkdtempSync(join(tmpdir(), 'awb-approval-hb-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 승인 대기 상태까지 실제로 몰아넣은 프로덕션 UpdateChecker. */
async function checkerAt(t, { policy, home, latest = '1.7.0', window = WINDOW_OPEN_AT_10 }) {
  const starts = [];
  const checker = new UpdateChecker({
    installMode: 'npm-global',
    updateChannel: 'latest',
    currentVersion: '1.6.0',
    updatePolicy: policy,
    updateWindow: window,
    stateDir: home,
    now: () => AT_10_00,
    log: () => {},
    npmView: async () => ({ ok: true, stdout: `${latest}\n`, stderr: '' }),
    runUpdate: async (opts) => { starts.push(opts); return { changed: true, summary: 'stub' }; },
  });
  t.after(() => checker.stop());
  await checker.checkNow();
  return { checker, starts };
}

function heartbeatFor(t, checker, instanceId) {
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' },
    instanceId,
    { mode: 'manager', version: 'test', cli: 'mixed', cliAdapters: [], updateChecker: checker },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();
  return heartbeat;
}

test('scheduled 로 승인 대기 중이면 하트비트 본문에 대상 버전이 실린다', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = await checkerAt(t, { policy: 'scheduled', home });
  assert.equal(starts.length, 0, '전제: scheduled 는 설치를 개시하지 않는다');

  const payloadPromise = stubFetch(t);
  heartbeatFor(t, checker, 'approval-pending-1');
  const payload = await payloadPromise;

  assert.equal(payload.update_approval_pending_version, '1.7.0');
  // 기존 필드도 함께 실려야 한다 — 새 필드가 기존 계약을 밀어내지 않았는지.
  assert.equal(payload.latest_version, '1.7.0');
  assert.equal(payload.update_available, true);
});

test('manual 호스트의 하트비트는 승인 대기 없음을 null 로 보고한다', async (t) => {
  const home = tempHome(t);
  const { checker } = await checkerAt(t, { policy: 'manual', home });

  const payloadPromise = stubFetch(t);
  heartbeatFor(t, checker, 'approval-pending-2');
  const payload = await payloadPromise;

  // null 과 undefined 는 서버에서 의미가 다르다: null = "이 필드를 아는 매니저인데
  // 지금은 대기 없음", undefined = "필드를 모르는 구버전". manual 은 전자다.
  assert.equal(payload.update_approval_pending_version, null);
  assert.ok(
    Object.prototype.hasOwnProperty.call(payload, 'update_approval_pending_version'),
    '이 빌드는 필드를 항상 보고해야 한다 — 침묵은 구버전 매니저의 신호로 예약돼 있다',
  );
});

test('승인이 기록돼 개시로 넘어가면 대기 신호가 하트비트에서 사라진다', async (t) => {
  const home = tempHome(t);
  const { checker, starts } = await checkerAt(t, { policy: 'scheduled', home });
  assert.equal(checker.status().update_approval_pending_version, '1.7.0');

  writeUpdateApproval({ version: '1.7.0', source: 'update_manager', approvedAtMs: 1 }, home);
  await checker.checkNow();
  assert.equal(starts.length, 1, '승인 뒤에는 개시된다');

  const payloadPromise = stubFetch(t);
  heartbeatFor(t, checker, 'approval-pending-3');
  const payload = await payloadPromise;

  assert.equal(payload.update_approval_pending_version, null);
});

test('updateChecker 없이 구성된 하트비트는 이 필드를 아예 보내지 않는다 (구버전 와이어 모양)', async (t) => {
  const payloadPromise = stubFetch(t);
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' },
    'approval-pending-4',
    { mode: 'manager', version: 'test', cli: 'mixed', cliAdapters: [] },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();
  const payload = await payloadPromise;

  assert.equal(
    Object.prototype.hasOwnProperty.call(payload, 'update_approval_pending_version'),
    false,
    'self-update 를 안 쓰는 구성은 필드 자체를 보내지 않아야 한다',
  );
});
