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

test('ticket, direct-chat, room/run, and mention Hermes paths use RuntimeSupervisor', () => {
  assert.match(dispatcher, /Trigger dispatched through Hermes ACP/);
  assert.match(dispatcher, /Chat request dispatched through Hermes ACP/);
  assert.match(dispatcher, /Chat room dispatched through Hermes ACP/);
  assert.match(dispatcher, /Comment mention dispatched through Hermes ACP/);
  assert.match(dispatcher, /if \(agentContext\?\.cli === 'hermes'\)/);
  assert.match(dispatcher, /if \(runContext\?\.cli === 'hermes'\)/);
});

test('Hermes transport receives attributed AWB MCP and never selects a CLI fallback', () => {
  assert.match(supervisor, /X-AWB-Client-Type[\s\S]*runtime-child/);
  assert.match(supervisor, /X-AWB-Agent-Id/);
  assert.match(supervisor, /X-AWB-Run-Id/);
  assert.match(supervisor, /descriptor\.id !== 'hermes'/);
  assert.match(supervisor, /runtime_not_supported/);
});

test('Runtime Host canonical Agent fetch returns persisted runtime policy', () => {
  assert.match(managerController, /runtime_config: target\.runtime_config/);
});
