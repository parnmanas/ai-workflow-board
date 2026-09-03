// mission 대화 참여 REST 엔드포인트의 배선 (티켓 f6a0de0e).
//
// e2e(`qa-flows/orchestration-mission-conversation.test.mjs`)는 실제 HTTP 로 이 라우트를
// 때리므로 정상 경로는 거기서 이미 증명된다. 여기서 따로 보는 것은 **e2e 가 관찰할 수
// 없는 두 가지**다:
//
//   1. 참여자를 결정하는 것이 body 가 아니라 **세션 사용자**인가. 만약 컨트롤러가
//      `body.user_id` 같은 걸 읽도록 바뀌면, 호출자가 남을 임의의 미션 방에 밀어 넣을
//      수 있다. e2e 는 자기 토큰으로만 부르므로 그 회귀를 통과시킨다 — 인자 매핑을
//      직접 봐야 잡힌다(sibling `orchestration-confirm-controller.test.mjs` 와 같은 이유).
//   2. 서비스가 낸 status(409/404 등)가 400 으로 뭉개지지 않고 그대로 나가는가.

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

test('참여 라우트가 POST missions/:id/join-conversation 으로 등록돼 있다', () => {
  const handler = OrchestrationController.prototype.joinMissionConversation;
  assert.equal(typeof handler, 'function', '핸들러가 존재해야 한다');
  assert.equal(Reflect.getMetadata(PATH_METADATA, handler), 'missions/:id/join-conversation');
  // RequestMethod.POST === 1
  assert.equal(Reflect.getMetadata(METHOD_METADATA, handler), 1, '참여는 부수효과가 있으므로 GET 이면 안 된다');
});

test('참여 대상은 body 가 아니라 세션 사용자다', async () => {
  const calls = [];
  const controller = controllerWith({
    async joinMissionConversation(missionId, workspaceId, actor) {
      calls.push({ missionId, workspaceId, actor });
      return { room_id: 'room-1', joined: true };
    },
  });

  const res = fakeRes();
  await controller.joinMissionConversation(
    'mission-7',
    // body 에 남의 신원을 섞어 보낸다 — 컨트롤러가 이걸 집으면 임의의 사용자를 남의
    // 미션 방에 밀어 넣을 수 있게 된다.
    { workspace_id: 'ws-1', user_id: 'someone-else', actor: { id: 'someone-else' } },
    fakeReq({ id: 'user-9', name: 'Operator' }),
    res,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].missionId, 'mission-7');
  assert.equal(calls[0].workspaceId, 'ws-1');
  assert.deepEqual(
    calls[0].actor,
    { type: 'user', id: 'user-9', name: 'Operator' },
    '참여하는 사람은 세션 사용자여야 한다 — body 의 신원을 믿으면 안 된다',
  );
  assert.deepEqual(res.out.body, { room_id: 'room-1', joined: true }, '서비스 결과가 그대로 나간다');
});

test('이미 참여 중이면 joined:false 가 그대로 전달된다', async () => {
  const controller = controllerWith({
    async joinMissionConversation() {
      return { room_id: 'room-1', joined: false };
    },
  });
  const res = fakeRes();
  await controller.joinMissionConversation('m1', { workspace_id: 'ws-1' }, fakeReq({ id: 'u1' }), res);
  assert.deepEqual(
    res.out.body,
    { room_id: 'room-1', joined: false },
    '멱등 재호출을 실패로 바꾸면 화면이 상태를 알아야만 버튼을 그릴 수 있게 된다',
  );
});

test('서비스가 낸 status 가 그대로 전달된다', async () => {
  const controller = controllerWith({
    async joinMissionConversation() {
      const err = new Error('mission has not been started yet — there is no conversation room');
      err.status = 409;
      throw err;
    },
  });

  const res = fakeRes();
  await controller.joinMissionConversation('m1', { workspace_id: 'ws-1' }, fakeReq({ id: 'u1' }), res);
  assert.equal(res.out.statusCode, 409, '아직 시작 안 된 미션을 400 으로 뭉개면 원인을 알 수 없다');
  assert.match(res.out.body.error, /has not been started/);
});
