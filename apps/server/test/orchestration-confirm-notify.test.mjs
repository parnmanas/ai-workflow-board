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
//     선점 UPDATE 가 실패해도 호출자에게 예외가 새지 않는다.
//   - 선점(claim)은 **DB 가 판정한다** — 무엇을 SET 하고 무엇을 WHERE 에 거는지, 그리고
//     `affected` 가 0 이거나 없을 때 반드시 진다는 fail-closed 규칙(단일 승자 보장).
//     여러 서버가 실제로 경쟁했을 때의 결과는 qa-flow e2e 가 잰다.
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
  confirm_notified_visit: 1,
  confirm_notified_at: new Date(),
  confirm_reminded_visit: null,
};

/** 관측 가능한 스텁 묶음. 각 테스트가 필요한 부분만 덮어쓴다. */
function makeService(ServiceClass, overrides = {}) {
  const calls = [];
  const updates = [];
  const events = [];
  const logs = { warn: [], error: [], info: [] };

  // 선점(claim)은 QueryBuilder 한 방이라, 무엇을 SET 하고 무엇을 WHERE 에 걸었는지
  // 그대로 받아 적는 가짜를 둔다. `affected` 는 테스트가 정한다 — 승패를 정하는 것이
  // 애플리케이션이 아니라 DB 라는 사실이 이 스텁으로 드러난다.
  const claims = [];
  const stepRepo = {
    async findOne() {
      return overrides.freshStep !== undefined ? overrides.freshStep : { ...STEP };
    },
    async update(where, patch) {
      if (overrides.updateThrows) throw new Error('db down');
      updates.push({ where, patch });
    },
    createQueryBuilder() {
      const record = { patch: null, conditions: [], params: {} };
      const qb = {
        update() { return qb; },
        set(patch) { record.patch = patch; return qb; },
        where(sql, params) { record.conditions.push(sql); Object.assign(record.params, params); return qb; },
        andWhere(sql, params) { record.conditions.push(sql); Object.assign(record.params, params); return qb; },
        async execute() {
          if (overrides.claimThrows) throw new Error('db down');
          claims.push(record);
          // `'claimAffected' in overrides` 로 본다 — 값을 채우지 않는 드라이버(affected:
          // undefined)를 표현해야 하는데 `?? 1` 로 받으면 그 경우가 사라진다.
          return { affected: 'claimAffected' in overrides ? overrides.claimAffected : 1 };
        },
      };
      return qb;
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
  return { svc, calls, updates, events, logs, claims };
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

test('발송 경로는 step 테이블에 아무것도 쓰지 않는다 — 선점이 이미 끝냈다', async () => {
  const ServiceClass = await loadService();
  const { svc, updates, events } = makeService(ServiceClass);
  svc.scheduleGateNotice(MISSION, STEP);
  await svc.settled();

  // 발송은 미션 락 밖에서 배경으로 돈다. 그 사이 사람이 판정을 제출할 수 있으므로, 발송이
  // 끝난 뒤에 step 을 쓰면 그 판정을 덮어쓸 위험이 생긴다. 이제 쓰기는 발송 **전**의 선점
  // 한 방뿐이고, 발송 경로는 타임라인 기록만 남긴다.
  assert.deepEqual(updates, [], '발송 후에는 step 을 건드리지 않는다');
  assert.equal(events.length, 1, '남기는 것은 타임라인 기록뿐이다');
  assert.equal(events[0].type, 'confirm_notified');
  assert.equal(events[0].data.sent, 1, '관측용 수치는 컬럼이 아니라 이벤트에 있다');
});

test('최초 알림 선점은 (visit, awaiting_user, 아직 미선점) 셋을 전부 DB 에 건다', async () => {
  const ServiceClass = await loadService();
  const { svc, claims } = makeService(ServiceClass);

  assert.equal(await svc.claimGateNotice({ ...STEP }, 1), true, 'affected>0 이면 이겼다');
  assert.equal(claims.length, 1);
  const [claim] = claims;

  assert.equal(claim.patch.confirm_notified_visit, 1, '선점 키는 pass 번호다');
  assert.ok(claim.patch.confirm_notified_at instanceof Date, '리마인더 기준 시각을 함께 찍는다');
  assert.equal(claim.params.visit, 1);
  assert.equal(claim.params.status, 'awaiting_user');

  const sql = claim.conditions.join(' AND ');
  assert.match(sql, /visit = :visit/, 'loop 로 pass 가 넘어갔으면 이 선점은 무효다');
  assert.match(sql, /status = :status/, '판정이 들어왔으면 보내지 않는다 (요구사항 4)');
  assert.match(
    sql,
    /confirm_notified_visit IS NULL OR confirm_notified_visit <> :visit/,
    '이 pass 를 아직 아무도 선점하지 않았을 때만 이긴다',
  );
});

test('리마인더 선점은 별도 컬럼을 쓴다 — 최초 알림과 서로를 막지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc, claims } = makeService(ServiceClass);

  assert.equal(await svc.claimReminder({ ...STEP }, 1), true);
  const [claim] = claims;
  assert.deepEqual(Object.keys(claim.patch), ['confirm_reminded_visit']);
  assert.equal(claim.patch.confirm_reminded_visit, 1);
  assert.match(
    claim.conditions.join(' AND '),
    /confirm_reminded_visit IS NULL OR confirm_reminded_visit <> :visit/,
  );
});

test('선점에서 지면 false — 진 쪽은 아무것도 보내지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc, calls } = makeService(ServiceClass, { claimAffected: 0 });

  assert.equal(await svc.claimGateNotice({ ...STEP }, 1), false);
  assert.equal(await svc.claimReminder({ ...STEP }, 1), false);
  await svc.settled();
  assert.equal(calls.length, 0, '패자가 보내면 중복 방지 자체가 무의미하다');
});

test('선점 UPDATE 가 던져도 예외가 새지 않고 졌다고 본다 (fail-closed)', async () => {
  const ServiceClass = await loadService();
  const { svc, logs } = makeService(ServiceClass, { claimThrows: true });

  // 낡은 스냅샷으로 추측해 "이겼다"고 치면 두 경쟁자가 모두 승자가 되어 단일 승자 보장이
  // 깨진다. 여기서 지는 최악은 알림 1회 유실이고 그건 리마인더 스윕이 주워 간다.
  assert.equal(await svc.claimGateNotice({ ...STEP }, 1), false);
  assert.equal(await svc.claimReminder({ ...STEP }, 1), false);
  assert.ok(logs.warn.length >= 2, '선점 실패는 warn 으로 드러난다');
});

test('affected 를 채우지 않는 드라이버에서도 이겼다고 가정하지 않는다', async () => {
  const ServiceClass = await loadService();
  const { svc } = makeService(ServiceClass, { claimAffected: undefined });

  // `?? 0` 이 아니라 `|| true` 같은 관대한 처리를 쓰면, 값을 안 채우는 드라이버에서 두
  // 경쟁자가 모두 이긴다. 알림 유실(회복 가능) < 중복 발송(사람에게 두 번 울림).
  assert.equal(await svc.claimGateNotice({ ...STEP }, 1), false);
});

test('리마인더 payload 는 대기 시간과 질문을 함께 싣는다 (요구사항 5)', async () => {
  const ServiceClass = await loadService();
  const { svc, calls, updates, events } = makeService(ServiceClass);

  const result = await svc.sendReminder(MISSION, STEP, 26 * 60 * 60_000);
  assert.equal(result.sent, 1);

  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.title, /Still waiting on your decision/, '리마인더임이 제목에서 드러난다');
  assert.match(calls[0].payload.body, /26h/, '얼마나 기다렸는지 알려준다');
  assert.match(calls[0].payload.body, /Compare the screenshot/, '리마인더에도 질문이 그대로 실린다');

  assert.deepEqual(updates, [], '리마인더도 발송 뒤에 step 을 쓰지 않는다 — 선점이 이미 끝냈다');
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
