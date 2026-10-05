import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentAccountId,
  agentIsVisibleInWorkspace,
  agentWorkspaceWhere,
} from '../dist/common/agent-account-scope.js';

test('agent workspace normalization persists global scope as null', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(normalizeAgentAccountId(value), null);
  }
  assert.equal(normalizeAgentAccountId(' workspace-a '), 'workspace-a');
});

test('global agents are visible in every workspace while foreign agents are not', () => {
  for (const value of [null, undefined, '', '   ', 'workspace-a']) {
    assert.equal(agentIsVisibleInWorkspace(value, 'workspace-a'), true);
  }
  assert.equal(agentIsVisibleInWorkspace('workspace-b', 'workspace-a'), false);
  assert.equal(agentIsVisibleInWorkspace(null, ''), false, 'callers must provide a concrete target workspace');
});

test('agent workspace query includes local, legacy-empty, and null-global rows', () => {
  const where = agentWorkspaceWhere('workspace-a');
  assert.equal(where.length, 3);
  assert.equal(where[0].account_id, 'workspace-a');
  assert.equal(where[1].account_id, '');
  assert.equal(where[2].account_id._type, 'isNull');
});
