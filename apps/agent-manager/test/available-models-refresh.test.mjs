// ticket 40110b64 — 매니저 재시작 없이 CLI 모델 목록을 갱신하는 경로.
//
// 이 티켓 전까지 `available_models` 를 덮는 테스트가 서버·매니저 양쪽에 하나도
// 없었다. 여기서 열거 → 하트비트 경로를 덮는다:
//
//   1) gatherAvailableModels() 의 best-effort 계약 (일부 어댑터가 죽어도 나머지는 산다)
//   2) 하트비트가 provider 를 매 tick 읽는다 (부팅 스냅샷에 고정되지 않는다)
//   3) postNow() 가 즉시 1회 전송하고, 실패해도 throw 하지 않으며,
//      정기 타이머를 재무장해 이중 전송을 막는다
//
// 단언은 실제 POST 본문을 파싱해서 한다 (manager-capabilities-heartbeat.test.mjs
// 와 같은 기법) — 내부 객체를 들여다보면 producer 쪽 flatten 버그를 놓친다.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gatherAvailableModels } from '../dist/lib/available-models.js';
import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';

const HEARTBEAT_INTERVAL_MS = 30_000;

/** POST 본문을 순서대로 모으는 fetch 스텁. */
function collectFetch(t, { fail = false } = {}) {
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    if (fail) throw new Error('network down');
    return new Response(null, { status: 204 });
  };
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  return bodies;
}

/** 실제 타이머/마이크로태스크가 한 바퀴 돌 틈을 준다. */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function heartbeatConfig() {
  return { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' };
}

// ─── 1) 열거의 best-effort 계약 ────────────────────────────────────────────

test('gatherAvailableModels: 어댑터 하나가 throw 해도 나머지 CLI 는 그대로 열거된다', async () => {
  const logged = [];
  const models = await gatherAvailableModels({
    cliTypes: ['claude', 'codex', 'deepseek'],
    adapterFor: (cli) => ({
      async listModels() {
        if (cli === 'codex') throw new Error('codex 바이너리를 찾을 수 없음');
        return cli === 'claude' ? ['opus', 'sonnet', 'haiku'] : ['deepseek-chat'];
      },
    }),
    logger: (message) => logged.push(message),
  });

  assert.deepEqual(models, {
    claude: ['opus', 'sonnet', 'haiku'],
    deepseek: ['deepseek-chat'],
  });
  assert.equal('codex' in models, false, '실패한 CLI 는 키 자체가 빠진다');
  assert.equal(logged.length, 1);
  assert.match(logged[0], /listModels failed for cli=codex/);
});

test('gatherAvailableModels: 모든 어댑터가 실패해도 throw 하지 않고 빈 맵을 돌려준다', async () => {
  const models = await gatherAvailableModels({
    cliTypes: ['claude', 'codex'],
    adapterFor: () => ({
      async listModels() {
        throw new Error('스캔 타임아웃');
      },
    }),
    logger: () => {},
  });
  assert.deepEqual(models, {});
});

test('gatherAvailableModels: 모델을 하나도 못 찾은 CLI 는 빈 배열이 아니라 키 자체가 없다', async () => {
  const models = await gatherAvailableModels({
    cliTypes: ['claude', 'pi'],
    adapterFor: (cli) => ({
      async listModels() {
        return cli === 'claude' ? ['opus'] : [];
      },
    }),
    logger: () => {},
  });
  assert.deepEqual(models, { claude: ['opus'] });
});

// ─── 2) 하트비트가 provider 를 매 tick 읽는다 ───────────────────────────────

test('하트비트는 availableModelsProvider 를 매 tick 다시 읽는다 — 재열거 결과가 재시작 없이 실린다', async (t) => {
  const bodies = collectFetch(t);
  let models = { claude: ['opus', 'sonnet'] };
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-1', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    availableModelsProvider: () => models,
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].available_models, { claude: ['opus', 'sonnet'] });

  // refresh_available_models 가 캐시를 통째로 교체한 상황.
  models = { claude: ['opus', 'sonnet', 'haiku'], codex: ['gpt-5'] };
  await heartbeat.postNow();

  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].available_models, {
    claude: ['opus', 'sonnet', 'haiku'],
    codex: ['gpt-5'],
  });
});

test('provider 가 throw 하면 부팅 시점 정적 스냅샷으로 접고 하트비트는 계속 돈다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-2', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    availableModels: { claude: ['opus'] },
    availableModelsProvider: () => {
      throw new Error('provider 폭발');
    },
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].available_models, { claude: ['opus'] });
});

test('provider 없이 정적 availableModels 만 주는 기존 호출부는 그대로 동작한다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-3', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    availableModels: { codex: ['gpt-5'] },
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.deepEqual(bodies[0].available_models, { codex: ['gpt-5'] });
});

test('모델을 보고한 CLI 가 하나도 없으면 available_models 필드 자체를 싣지 않는다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-4', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
    availableModelsProvider: () => ({}),
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.equal('available_models' in bodies[0], false);
});

// ─── 3) postNow() — 즉시 반영 + 이중 전송 방지 ──────────────────────────────

test('postNow() 는 정기 tick 을 기다리지 않고 즉시 1회 전송하고 true 를 돌려준다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-5', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.equal(bodies.length, 1);

  assert.equal(await heartbeat.postNow(), true);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[1].instance_id, heartbeat.instanceId);
});

test('postNow() 는 전송이 실패해도 throw 하지 않고 false 를 돌려준다 — 커맨드를 같이 죽이지 않는다', async (t) => {
  collectFetch(t, { fail: true });
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-6', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => heartbeat.stop());

  assert.equal(await heartbeat.postNow(), false);
});

test('postNow() 는 페어링 전(agent_id 없음)이면 아무것도 보내지 않고 false 를 돌려준다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), null, {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => heartbeat.stop());

  assert.equal(await heartbeat.postNow(), false);
  assert.equal(bodies.length, 0);
});

test('stop() 이후의 postNow() 는 아무것도 보내지 않는다', async (t) => {
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-7', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  heartbeat.start();
  await flush();
  const sentWhileRunning = bodies.length;
  heartbeat.stop();

  assert.equal(await heartbeat.postNow(), false);
  assert.equal(bodies.length, sentWhileRunning);
});

test('postNow() 직후에는 정기 tick 이 온전한 한 주기 뒤에 온다 — 즉시 전송과 겹쳐 이중 전송되지 않는다', async (t) => {
  // setInterval 만 가짜로 돌린다. fetch 스텁의 프로미스 해소에 쓰는
  // setImmediate 는 실제 타이머로 남겨 둬야 본문 수집이 진행된다.
  t.mock.timers.enable({ apis: ['setInterval'] });
  const bodies = collectFetch(t);
  const heartbeat = new InstanceHeartbeat(heartbeatConfig(), 'manager-8', {
    mode: 'manager',
    version: 'test',
    cli: 'mixed',
    cliAdapters: [],
  });
  t.after(() => heartbeat.stop());

  heartbeat.start();
  await flush();
  assert.equal(bodies.length, 1, 'start() 는 즉시 1회 보낸다');

  // 정기 tick 직전(주기의 2/3)에 리프레시가 들어온 상황.
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS * (2 / 3));
  await flush();
  assert.equal(bodies.length, 1, '아직 정기 tick 은 오지 않았다');

  assert.equal(await heartbeat.postNow(), true);
  assert.equal(bodies.length, 2);

  // 재무장이 없다면 남은 1/3 지점에서 정기 tick 이 곧바로 따라붙는다.
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS * (1 / 3) + 1);
  await flush();
  assert.equal(bodies.length, 2, 'postNow() 가 타이머를 재무장해 겹치는 tick 이 없다');

  // 재무장 시점부터 한 주기가 지나면 정상적으로 다시 돈다.
  t.mock.timers.tick(HEARTBEAT_INTERVAL_MS);
  await flush();
  assert.equal(bodies.length, 3, '재무장 이후 정기 tick 은 계속 돈다');
});
