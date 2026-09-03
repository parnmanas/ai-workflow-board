// confirm 판정 REST 엔드포인트의 배선 (티켓 5dbe4aa2).
//
// e2e(`qa-flows/orchestration-confirm-node.test.mjs`)는 서비스 계층을 직접 부른다 —
// 이 저장소의 orchestration 테스트가 사람 쪽 동작에 대해 쓰는 방식 그대로다. 그래서
// 남는 구멍이 하나 있다: **HTTP body 의 필드가 서비스 인자로 옳게 옮겨지는가.**
// 여기서 verdict/feedback/visit 중 하나만 빠뜨려도 e2e 는 전부 초록인데 실제 UI 는
// 동작하지 않는다(특히 `visit` 이 빠지면 서버의 stale-화면 방어가 통째로 죽는다).
//
// 그래서 컨트롤러를 가짜 runner 와 함께 직접 세우고, 라우트 등록 · 인자 매핑 ·
// 응답 모양 · 에러 status 전달을 실제 호출로 확인한다.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(__dirname, '..', 'dist');

const { OrchestrationController } = await import(
  pathToFileURL(path.join(DIST, 'modules', 'orchestration', 'orchestration.controller.js')).href
);
const { PATH_METADATA, METHOD_METADATA } = await import(
  pathToFileURL(path.join(__dirname, '..', 'node_modules', '@nestjs', 'common', 'constants.js')).href
).catch(async () =>
  import(pathToFileURL(path.join(__dirname, '..', '..', '..', 'node_modules', '@nestjs', 'common', 'constants.js')).href),
);

/** 최소 Express 응답 스텁 — status/json 을 기록한다. */
function fakeRes() {
  const out = { statusCode: 200, body: undefined };
  return {
    out,
    status(code) {
      out.statusCode = code;
      return this;
    },
    json(body) {
      out.body = body;
      return this;
    },
  };
}

const fakeReq = (user) => ({ currentUser: user });

function controllerWith(runnerImpl) {
  // teams/missions/reaper 는 이 라우트가 쓰지 않는다 — 쓰기 시작하면 여기서 즉시 터진다.
  const boom = new Proxy(
    {},
    {
      get(_t, prop) {
        return () => {
          throw new Error(`this route must not call ${String(prop)}`);
        };
      },
    },
  );
  return new OrchestrationController(boom, boom, runnerImpl, boom);
}

test('confirm 라우트가 POST steps/:stepId/confirm 으로 등록돼 있다', () => {
  const handler = OrchestrationController.prototype.confirmStep;
  assert.equal(typeof handler, 'function', '핸들러가 존재해야 한다');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'steps/:stepId/confirm');
  // RequestMethod.POST === 1
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 1, '판정 제출은 GET 이면 안 된다(부수효과가 있다)');
});

test('body 의 verdict/feedback/visit 과 세션 사용자가 그대로 서비스로 전달된다', async () => {
  const calls = [];
  const controller = controllerWith({
    async submitConfirmDecision(stepId, workspaceId, actor, input) {
      calls.push({ stepId, workspaceId, actor, input });
      return {
        step: { id: stepId, step_key: 'gate', status: 'done', confirm_decision: { verdict: input.verdict } },
        already_decided: false,
        dispatched: ['ship'],
        loop_reentered: [],
        orchestrator_woken: false,
      };
    },
  });

  const res = fakeRes();
  await controller.confirmStep(
    'step-1',
    { workspace_id: 'ws-1', verdict: 'fail', feedback: 'the footer overlaps', visit: 3 },
    fakeReq({ id: 'user-9', name: 'Operator' }),
    res,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].stepId, 'step-1');
  assert.equal(calls[0].workspaceId, 'ws-1');
  assert.deepEqual(calls[0].actor, { type: 'user', id: 'user-9', name: 'Operator' }, '판정자는 세션 사용자다');
  assert.equal(calls[0].input.verdict, 'fail');
  assert.equal(calls[0].input.feedback, 'the footer overlaps');
  // 이 한 줄이 빠지면 stale 한 브라우저 탭의 판정이 현재 pass 에 기록된다.
  assert.equal(calls[0].input.visit, 3, 'visit 이 서비스까지 도달해야 한다');

  assert.equal(res.out.statusCode, 200);
  assert.deepEqual(res.out.body, {
    already_decided: false,
    step_id: 'step-1',
    step_key: 'gate',
    status: 'done',
    confirm_decision: { verdict: 'fail' },
    dispatched: ['ship'],
    loop_reentered: [],
    orchestrator_woken: false,
  });
});

test('이미 판정된 재제출은 already_decided 를 그대로 노출한다(화면이 성공으로 다룰 수 있어야 한다)', async () => {
  const controller = controllerWith({
    async submitConfirmDecision(stepId) {
      return {
        step: { id: stepId, step_key: 'gate', status: 'done', confirm_decision: { verdict: 'pass' } },
        already_decided: true,
        dispatched: [],
        loop_reentered: [],
        orchestrator_woken: false,
      };
    },
  });
  const res = fakeRes();
  await controller.confirmStep('step-1', { workspace_id: 'ws-1', verdict: 'pass', visit: 1 }, fakeReq({}), res);
  assert.equal(res.out.statusCode, 200, '중복 제출은 에러가 아니다 — 사용자는 이미 답했다');
  assert.equal(res.out.body.already_decided, true);
});

test('서비스가 던진 status 가 HTTP status 로 그대로 나간다', async () => {
  const controller = controllerWith({
    async submitConfirmDecision() {
      const e = new Error('stale confirmation for step "gate"');
      e.status = 409;
      throw e;
    },
  });
  const res = fakeRes();
  await controller.confirmStep('step-1', { workspace_id: 'ws-1', verdict: 'pass', visit: 1 }, fakeReq({}), res);
  // 409 가 400 으로 뭉개지면 화면이 "잘못된 입력"과 "화면이 낡음"을 구분할 수 없다.
  assert.equal(res.out.statusCode, 409);
  assert.match(res.out.body.error, /stale confirmation/);
});

test('세션 사용자가 없어도 500 으로 터지지 않고 서비스까지 도달한다', async () => {
  // 판정자 신원이 비는 것은 서비스가 감사 로그에서 다룰 문제이지, 컨트롤러가
  // 크래시할 이유가 아니다.
  let seen = null;
  const controller = controllerWith({
    async submitConfirmDecision(stepId, workspaceId, actor) {
      seen = actor;
      return {
        step: { id: stepId, step_key: 'gate', status: 'done', confirm_decision: null },
        already_decided: false,
        dispatched: [],
        loop_reentered: [],
        orchestrator_woken: false,
      };
    },
  });
  const res = fakeRes();
  await controller.confirmStep('step-1', { workspace_id: 'ws-1', verdict: 'pass', visit: 1 }, {}, res);
  assert.deepEqual(seen, { type: 'user', id: '', name: '' });
  assert.equal(res.out.statusCode, 200);
});
