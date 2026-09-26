import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const dispatcher = await readFile(
  new URL('../../../agent-manager/src/lib/event-dispatcher.ts', import.meta.url),
  'utf8',
);
const supervisor = await readFile(
  new URL('../../../agent-manager/src/lib/runtime/runtime-supervisor.ts', import.meta.url),
  'utf8',
);
const managerController = await readFile(
  new URL('../../src/modules/agent-manager/agent-manager.controller.ts', import.meta.url),
  'utf8',
);

// 라우팅 판정의 **근거**가 바뀌었다(CLI 모듈화, add99588). 예전에는 네 경로가 각각
// `agentContext?.cli === 'hermes'` 로 이름을 비교했고 이 가드가 그 문자열을 고정했다.
// 지금은 `isAcpRuntime(cli)` — CliModule 선언의 `transport === 'acp'` 를 읽는 술어 — 로
// 갈린다. 그래서 옛 문자열을 계속 요구하면 AGENTS.md 가 금지한 이름 비교(`if (cli ===
// 'claude')`)를 가드가 되레 강제하게 된다. 지키려던 불변식은 그대로다: 네 경로가 CLI
// 어댑터가 아니라 RuntimeSupervisor 를 타고, 그 판정이 선언에서 나온다.
test('ticket, direct-chat, room/run, and mention Hermes paths use RuntimeSupervisor', () => {
  assert.match(dispatcher, /Trigger dispatched through Hermes ACP/);
  assert.match(dispatcher, /Chat request dispatched through Hermes ACP/);
  assert.match(dispatcher, /Chat room dispatched through Hermes ACP/);
  assert.match(dispatcher, /Comment mention dispatched through Hermes ACP/);
  assert.match(dispatcher, /isAcpRuntime\(agentContext\.cli\)/);
  assert.match(dispatcher, /isAcpRuntime\(runContext\.cli\)/);
  // 이름 비교로 되돌아가지 않는지도 함께 고정한다 — 그것이 이 리팩터가 없앤 것이다.
  assert.doesNotMatch(dispatcher, /cli === 'hermes'/);
});

test('Hermes transport receives attributed AWB MCP and never selects a CLI fallback', () => {
  assert.match(supervisor, /X-AWB-Client-Type[\s\S]*runtime-child/);
  assert.match(supervisor, /X-AWB-Agent-Id/);
  assert.match(supervisor, /X-AWB-Run-Id/);
  // 같은 이유로 여기도 선언 기준이다: 하드코딩된 'hermes' 비교 대신 플러그인 manifest 의
  // transport 를 본다. 비-ACP 런타임이 이 supervisor 로 새어 들어오지 않는다는 불변식은 동일.
  assert.match(supervisor, /manifest\(descriptor\.id\)\.transport !== 'acp'/);
  assert.match(supervisor, /runtime_not_supported/);
});

test('Runtime Host canonical Agent fetch returns persisted runtime policy', () => {
  assert.match(managerController, /runtime_config: target\.runtime_config/);
});
