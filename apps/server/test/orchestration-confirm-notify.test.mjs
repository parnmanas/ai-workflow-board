// 유닛 테스트 — confirm 게이트 대기 알림 서비스(티켓 a78cb566).
//
// `user-channel-dispatcher.test.mjs` 와 같은 방식이다: dist 에서 클래스를 불러와 스텁
// 협력자로 직접 생성한다. 여기서 재는 것은 **엔진이 아니라 알림 서비스 자체의 계약**
// 이고, 엔진과 맞물린 동작(중복 방지·loop 재진입·판정 후 침묵)은 qa-flow e2e 가 잰다.
//
// 이 파일이 지키는 계약:
//   - 수신자 해석: 사람 소유자 우선, 에이전트가 만든 미션은 워크스페이스 owner/member.
//   - payload 에 미션명·질문(instructions)·판정 화면 링크가 실제로 들어간다(요구사항 2).
//   - 어떤 실패도 던지지 않는다(요구사항 6) — dispatcher 가 던져도, ReBAC 이 던져도,
//     step 저장이 실패해도 호출자에게 예외가 새지 않는다.
//   - `notify_mention` 키로 나간다 — 기본값이 0 인 `notify_ticket` 을 쓰면 이 기능이
//     기본 침묵으로 출시되어 티켓이 고치려는 실패 모드가 그대로 남는다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function loadService() {
  const file = path.join(__dirname, '..', 'dist', 'modules', 'orchestration', 'orchestration-confirm-notify.service.js');
  try {
    return (await import('file://' + file)).OrchestrationConfirmNotifyService;
  } catch (err) {
    throw new Error(
      '이 테스트는 서버 빌드를 먼저 요구한다. `npm run --workspace=apps/server build`. 원인: ' + err.message,
    );
  }
}

const MISSION = {
  id: 'mission-1',
  workspace_id: 'ws-1',
  title: 'Ship the landing page',
  created_by_type: 'user',
  created_by: 'user-owner',
};

const STEP = {
  id: 'step-gate',
  step_key: 'gate',
  title: 'Does the page look right?',
  instructions: 'Compare the screenshot against the mockup and pass only if the layout matches.',
  visit: 1,
  status: 'awaiting_user',
  dispatched_at: new Date(),
  confirm_notice: { visit: 1, notified_at: new Date().toISOString() },
};

/** 관측 가능한 스텁 묶음. 각 테스트가 필요한 부분만 덮어쓴다. */
function makeService(ServiceClass, overrides = {}) {
  const calls = [];
  const updates = [];
  const events = [];
  const logs = { warn: [], error: [], info: [] };

  const stepRepo = {
    async findOne() {
      return overrides.freshStep !== undefined ? overrides.freshStep : { ...STEP };
    },
    async update(where, patch) {
      if (overrides.updateThrows) throw new Error('db down');
      updates.push({ where, patch });
    },
  };
  const dispatcher = {
    async dispatchForUser(userId, notifyKey, payload) {
      calls.push({ userId, notifyKey, payload });
      if (overrides.dispatchThrows) throw new Error('binding lookup exploded');
      return overrides.dispatchResult ?? { sent: 1, failed: 0 };
    },
  };
  const rebac = {
    async listSubjects(object, relation) {
      if (overrides.rebacThrows) throw new Error('rebac down');
      return (overrides.subjects ?? {})[relation] ?? [];
    },
  };
  const missions = {
    async recordEvent(mission, input) {
      events.push(input);
    },
  };
  const logService = {
    info: (...a) => logs.info.push(a),
    warn: (...a) => logs.warn.push(a),
    error: (...a) => logs.error.push(a),
  };

  const svc = new ServiceClass(stepRepo, dispatcher, rebac, missions, logService);
  return { svc, calls, updates, events, logs };
}

test('알림 payload 에 미션명·질문·판정 화면 링크가 모두 들어간다 (요구사항 2)', async () => {
  const ServiceClass = await loadService();
  const prev = process.env.AWB_PUBLIC_URL;
  process.env.AWB_PUBLIC_URL = 'https://awb.example.com/';
  try {
    const { svc, calls } = makeService(ServiceClass);
    svc.scheduleGateNotice(MISSION, STEP);
    await svc.settled();

    assert.equal(calls.length, 1, '소유자 한 명에게 한 번 나간다');
    const { userId, notifyKey, payload } = calls[0];
    assert.equal(userId, 'user-owner', '미션 소유자에게 간다');
    assert.equal(notifyKey, 'notify_mention', '기본값 0 인 notify_ticket 을 쓰면 기본 침묵이 된다');

    assert.match(payload.title, /Ship the landing page/, '미션명이 제목에 있어야 사람이 무엇인지 안다');
    assert.match(payload.body, /Does the page look right\?/, 'step 제목');
    assert.match(
      payload.body,
      /Compare the screenshot against the mockup/,
      '질문(instructions)이 본문에 그대로 실려야 화면을 열 이유가 생긴다',
    );
    assert.equal(
      payload.url,
      'https://awb.example.com/ws/ws-1/orchestration/missions/mission-1',
      '판정 화면 딥링크는 클라이언트 라우트와 같아야 한다',
    );
  } finally {
    if (prev === undefined) delete process.env.AWB_PUBLIC_URL;
    else process.env.AWB_PUBLIC_URL = prev;
  }
});

test('AWB_PUBLIC_URL 이 없어도 링크만 빠질 뿐 알림은 나간다', async () => {
  const ServiceClass = await loadService();
  const prev = process.env.AWB_PUBLIC_URL;
  delete process.env.AWB_PUBLIC_URL;
  try {
    const { svc, calls } = makeService(ServiceClass);
    svc.scheduleGateNotice(MISSION, STEP);
    await svc.settled();

    assert.equal(calls.length, 1, '링크가 없다고 발송을 포기하면 안 된다');
    assert.equal(calls[0].payload.url, undefined);
    assert.match(calls[0].payload.body, /Compare the screenshot/, '무엇을 묻는지는 여전히 전달된다');
  } finally {
    if (prev !== undefined) process.env.AWB_PUBLIC_URL = prev;
  }
});

test('instructions 가 비면 step 제목으로 대체한다 — 무엇을 묻는지 없는 알림은 쓸모없다', async () => {
  const ServiceClass = await loadService();
  const { svc, calls } = makeService(ServiceClass);
  svc.scheduleGateNotice(MISSION, { ...STEP, instructions: '   ' });
  await svc.settled();

  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.body, /Does the page look right\?/);
});

test('에이전트가 만든 미션은 워크스페이스 owner/member 로 넓힌다 (중복 제거)', async () => {
  const ServiceClass = await loadService();
  const { svc, calls } = makeService(ServiceClass, {
    subjects: {
      owner: [{ type: 'user', id: 'u-owner' }],
      // 같은 사람이 두 relation 에 있어도 한 번만, agent subject 는 제외.
      member: [
        { type: 'user', id: 'u-owner' },
        { type: 'user', id: 'u-member' },
        { type: 'agent', id: 'a-1' },
        { type: 'user', id: '' },
      ],
    },
  });

  svc.scheduleGateNotice({ ...MISSION, created_by_type: 'agent', created_by: 'agent-77' }, STEP);
  await svc.settled();

  assert.deepEqual(
    calls.map((c) => c.userId).sort(),
    ['u-member', 'u-owner'],
    'agent subject 와 빈 id 는 빠지고, 중복 사용자는 한 번만 받는다',
  );
});

test('사람 소유자가 있으면 워크스페이스로 넓히지 않는다 — 소음을 만들지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc, calls } = makeService(ServiceClass, {
    subjects: { owner: [{ type: 'user', id: 'u-owner' }], member: [{ type: 'user', id: 'u-member' }] },
  });
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  assert.deepEqual(calls.map((c) => c.userId), ['user-owner'], '소유자 한 명에게만 간다');
});

test('수신자가 하나도 없어도 조용히 끝난다 (요구사항 6)', async () => {
  const ServiceClass = await loadService();
  const { svc, calls, events } = makeService(ServiceClass, {
    subjects: { owner: [], member: [] },
  });
  svc.scheduleGateNotice({ ...MISSION, created_by_type: 'agent', created_by: 'agent-77' }, STEP);
  await svc.settled();

  assert.equal(calls.length, 0);
  assert.equal(events.length, 1, '보낼 곳이 없다는 사실도 타임라인에 남는다');
  assert.equal(events[0].data.recipients, 0);
  assert.equal(events[0].data.sent, 0);
});

test('dispatcher 가 던져도 호출자에게 예외가 새지 않는다 (요구사항 6)', async () => {
  const ServiceClass = await loadService();
  const { svc, events, logs } = makeService(ServiceClass, { dispatchThrows: true });

  // scheduleGateNotice 는 동기 반환이므로 여기서 던지면 게이트 오픈이 죽는다.
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  assert.equal(events.length, 1, '실패해도 감사 기록은 남는다');
  assert.equal(events[0].data.failed, 1);
  assert.equal(events[0].data.sent, 0);
  assert.ok(logs.warn.length >= 1, '실패는 로그로 드러나야 한다');
});

test('provider 가 전부 실패해도(sent=0) 예외가 아니라 기록으로 끝난다', async () => {
  const ServiceClass = await loadService();
  const { svc, events } = makeService(ServiceClass, { dispatchResult: { sent: 0, failed: 2 } });
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  assert.equal(events[0].data.sent, 0);
  assert.equal(events[0].data.failed, 2);
});

test('수신자 해석(ReBAC)이 던져도 예외가 새지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc, calls, logs } = makeService(ServiceClass, {
    rebacThrows: true,
  });
  svc.scheduleGateNotice({ ...MISSION, created_by_type: 'agent', created_by: 'agent-77' }, STEP);
  await svc.settled();

  assert.equal(calls.length, 0);
  assert.ok(logs.error.length >= 1, '해석 실패는 error 로그로 드러난다');
});

test('confirm_notice 저장이 실패해도 예외가 새지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc, events, logs } = makeService(ServiceClass, { updateThrows: true });
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  assert.ok(logs.warn.length >= 1);
  assert.equal(events.length, 1, '컬럼 저장이 실패해도 타임라인 기록은 이어진다');
});

test('발송 결과는 step 전체 save 가 아니라 confirm_notice 컬럼만 update 한다', async () => {
  const ServiceClass = await loadService();
  const { svc, updates } = makeService(ServiceClass);
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  assert.equal(updates.length, 1);
  assert.deepEqual(Object.keys(updates[0].patch), ['confirm_notice'], '판정을 덮어쓸 수 있는 전체 저장은 금지');
  assert.equal(updates[0].where.id, 'step-gate');
  assert.equal(updates[0].patch.confirm_notice.visit, 1);
  assert.equal(updates[0].patch.confirm_notice.sent, 1);
  assert.equal(updates[0].patch.confirm_notice.reminded_at, undefined, '최초 알림은 리마인더가 아니다');
});

test('저장된 notice 가 다른 pass 의 것이면 이어붙이지 않는다 — 중복 방지 키가 어긋난다', async () => {
  const ServiceClass = await loadService();
  // DB 에는 pass 1 의 기록이 남아 있는데 지금 알리는 것은 pass 2 다.
  const { svc, updates } = makeService(ServiceClass, {
    freshStep: { ...STEP, visit: 2, confirm_notice: { visit: 1, notified_at: '2020-01-01T00:00:00.000Z', reminded_at: '2020-01-02T00:00:00.000Z' } },
  });
  svc.scheduleGateNotice(MISSION, { ...STEP, visit: 2 });
  await svc.settled();

  const notice = updates[0].patch.confirm_notice;
  assert.equal(notice.visit, 2, '현재 pass 로 기록돼야 다음 pump 가 재발송하지 않는다');
  assert.notEqual(notice.notified_at, '2020-01-01T00:00:00.000Z', '옛 pass 의 시각을 물려받으면 안 된다');
  assert.equal(notice.reminded_at, undefined, '옛 pass 의 리마인더 기록이 새 pass 를 막으면 안 된다');
});

test('리마인더는 같은 pass 기록 위에 reminded_at 만 얹는다 (요구사항 5)', async () => {
  const ServiceClass = await loadService();
  const firstAt = '2026-09-01T00:00:00.000Z';
  const { svc, calls, updates, events } = makeService(ServiceClass, {
    freshStep: { ...STEP, confirm_notice: { visit: 1, notified_at: firstAt } },
  });

  const result = await svc.sendReminder(MISSION, STEP, 26 * 60 * 60_000);
  assert.equal(result.sent, 1);

  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.title, /Still waiting on your decision/, '리마인더임이 제목에서 드러난다');
  assert.match(calls[0].payload.body, /26h/, '얼마나 기다렸는지 알려준다');
  assert.match(calls[0].payload.body, /Compare the screenshot/, '리마인더에도 질문이 그대로 실린다');

  const notice = updates[0].patch.confirm_notice;
  assert.equal(notice.visit, 1);
  assert.equal(notice.notified_at, firstAt, '최초 알림 시각은 보존된다');
  assert.ok(notice.reminded_at, '리마인더를 보냈다는 사실이 남아야 두 번 가지 않는다');
  assert.equal(events[0].data.kind, 'reminder');
});

test('settled() 는 진행 중인 배경 발송을 모두 기다린다', async () => {
  const ServiceClass = await loadService();
  let release;
  const gate = new Promise((r) => { release = r; });
  const { svc, calls } = makeService(ServiceClass, { subjects: {} });
  // dispatchForUser 를 붙잡아 두고 settled() 가 실제로 기다리는지 본다.
  const slowDispatcher = {
    async dispatchForUser(userId, notifyKey, payload) {
      calls.push({ userId, notifyKey, payload });
      await gate;
      return { sent: 1, failed: 0 };
    },
  };
  // 서비스 내부 참조를 교체한다(생성자 주입 필드).
  svc.dispatcher = slowDispatcher;

  svc.scheduleGateNotice(MISSION, STEP);
  let settledDone = false;
  const settled = svc.settled().then(() => { settledDone = true; });

  await new Promise((r) => setImmediate(r));
  assert.equal(settledDone, false, '발송이 끝나기 전에 settled 가 풀리면 e2e 단언이 경합한다');

  release();
  await settled;
  assert.equal(settledDone, true);
  assert.equal(calls.length, 1);
});
