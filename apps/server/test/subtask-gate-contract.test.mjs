import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = path => readFile(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('기본 In Progress와 migration이 subtask 게이트를 활성화한다', async () => {
  const [defaults, migration] = await Promise.all([
    read('db.ts'),
    read('database/migrations/1760000000082-AddColumnProcessSubtasks.ts'),
  ]);
  assert.match(defaults, /name: 'In Progress'[\s\S]*process_subtasks: true/);
  assert.match(migration, /LOWER\(name\) = 'in progress'/);
});

test('REST와 MCP 이동이 열린 재귀 subtask 게이트를 공유한다', async () => {
  const [rest, mcp, gate] = await Promise.all([
    read('modules/tickets/tickets.controller.ts'),
    read('modules/mcp/tools/ticket-workflow-tools.ts'),
    read('modules/tickets/subtask-gate.ts'),
  ]);
  assert.match(rest, /subtaskGateBlocksMove/);
  assert.match(mcp, /subtaskGateBlocksMove/);
  assert.match(gate, /while \(parentIds\.length\)/);
});

test('dispatch 재시도와 마지막 동시 완료는 child 단위 emit 및 CAS 이동으로 멱등하다', async () => {
  const trigger = await read('modules/agents/trigger-loop.service.ts');
  assert.match(trigger, /_emitTrigger\(child, agentId, slug, 'subtask_gate'/);
  assert.match(trigger, /id = :id AND column_id = :fromColumnId/);
  assert.match(trigger, /if \(!claimed\.affected\) return false/);
});
