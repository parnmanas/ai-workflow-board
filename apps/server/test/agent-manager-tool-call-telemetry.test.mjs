// 회귀 테스트 — ticket d35b7b7d(Ontology Graph 6/7) 완료조건 4, reporter 결정
// 흡수 구현: POST /api/agent-manager/tool-call-telemetry.
//
// cli-login-session.test.mjs의 "층 2" 패턴을 그대로 따른다 — 실제 NestJS DI
// 부팅 없이 컨트롤러를 직접 인스턴스화하고 메서드를 fake req/res로 호출한다
// (AgentAuthGuard는 NestJS 라우팅 파이프라인에서만 동작하므로 여기선 검증
// 대상이 아니다 — 이 테스트의 관심사는 핸들러 자신의 바디 검증 + 집계 로깅
// 로직). `npm run build` 후 컴파일된 dist/를 임포트한다(관례).

import test from 'node:test';
import assert from 'node:assert/strict';

const { AgentManagerController } = await import('../dist/modules/agent-manager/agent-manager.controller.js');

function logServiceStub() {
  const calls = [];
  return {
    calls,
    info: (category, message, meta) => { calls.push({ category, message, meta }); },
    warn() {},
    error() {},
  };
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

// AgentManagerController 생성자는 18개 의존성을 받지만 reportToolCallTelemetry는
// this.logService만 사용한다 — 나머지는 절대 호출되지 않는 빈 스텁으로 채운다.
function makeController(logService) {
  const noop = {};
  return new AgentManagerController(
    noop, noop, noop, noop, logService, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop, noop,
  );
}

test('reportToolCallTelemetry: 유효한 표본은 집계 로그 1줄만 남기고 recorded=true를 반환한다', async () => {
  const logService = logServiceStub();
  const controller = makeController(logService);
  const res = response();

  await controller.reportToolCallTelemetry(
    { agent_id: 'agent-1', ticket_id: 'ticket-1', role: 'assignee', graph_calls: 2, native_calls: 5 },
    {},
    res,
  );

  assert.deepEqual(res.body, { ok: true, recorded: true });
  assert.equal(logService.calls.length, 1, '호출당 로그 라인이 아니라 이 보고 하나당 집계 로그 한 줄');
  assert.equal(logService.calls[0].category, 'Ontology');
  assert.deepEqual(
    { agent_id: logService.calls[0].meta.agent_id, ticket_id: logService.calls[0].meta.ticket_id, graph_calls: logService.calls[0].meta.graph_calls, native_calls: logService.calls[0].meta.native_calls },
    { agent_id: 'agent-1', ticket_id: 'ticket-1', graph_calls: 2, native_calls: 5 },
  );
  assert.equal(logService.calls[0].meta.source, 'claude_stream_json');
});

test('reportToolCallTelemetry: graph_calls/native_calls 둘 다 0이면 로그를 남기지 않는다', async () => {
  const logService = logServiceStub();
  const controller = makeController(logService);
  const res = response();

  await controller.reportToolCallTelemetry(
    { agent_id: 'agent-1', ticket_id: 'ticket-1', graph_calls: 0, native_calls: 0 },
    {},
    res,
  );

  assert.deepEqual(res.body, { ok: true, recorded: false });
  assert.equal(logService.calls.length, 0);
});

test('reportToolCallTelemetry: ticket_id 누락 시 로그를 남기지 않는다', async () => {
  const logService = logServiceStub();
  const controller = makeController(logService);
  const res = response();

  await controller.reportToolCallTelemetry(
    { agent_id: 'agent-1', graph_calls: 3, native_calls: 1 },
    {},
    res,
  );

  assert.deepEqual(res.body, { ok: true, recorded: false });
  assert.equal(logService.calls.length, 0);
});

test('reportToolCallTelemetry: body에 agent_id가 없으면 req.currentAgentId로 폴백한다', async () => {
  const logService = logServiceStub();
  const controller = makeController(logService);
  const res = response();

  await controller.reportToolCallTelemetry(
    { ticket_id: 'ticket-1', graph_calls: 1, native_calls: 0 },
    { currentAgentId: 'manager-agent-9' },
    res,
  );

  assert.equal(res.body.recorded, true);
  assert.equal(logService.calls[0].meta.agent_id, 'manager-agent-9');
});

test('reportToolCallTelemetry: 음수/비유한 카운트는 0으로 방어적으로 clamp된다', async () => {
  const logService = logServiceStub();
  const controller = makeController(logService);
  const res = response();

  await controller.reportToolCallTelemetry(
    { agent_id: 'agent-1', ticket_id: 'ticket-1', graph_calls: -5, native_calls: Number.NaN },
    {},
    res,
  );

  // 둘 다 clamp 후 0이 되므로 "빈 표본"과 동일하게 처리되어야 한다.
  assert.deepEqual(res.body, { ok: true, recorded: false });
  assert.equal(logService.calls.length, 0);
});
