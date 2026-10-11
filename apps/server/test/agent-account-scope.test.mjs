import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentAccountId,
  agentIsVisibleInAccount,
  agentAccountWhere,
} from '../dist/common/agent-account-scope.js';

test('agent account normalization persists global scope as null', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(normalizeAgentAccountId(value), null);
  }
  assert.equal(normalizeAgentAccountId(' account-a '), 'account-a');
});

test('global agents are visible in every account while foreign agents are not', () => {
  for (const value of [null, undefined, '', '   ', 'account-a']) {
    assert.equal(agentIsVisibleInAccount(value, 'account-a'), true);
  }
  assert.equal(agentIsVisibleInAccount('account-b', 'account-a'), false);
  assert.equal(agentIsVisibleInAccount(null, ''), false, 'callers must provide a concrete target account');
});

test('agent account query includes local, legacy-empty, and null-global rows', () => {
  const where = agentAccountWhere('account-a');
  assert.equal(where.length, 3);
  assert.equal(where[0].account_id, 'account-a');
  assert.equal(where[1].account_id, '');
  assert.equal(where[2].account_id._type, 'isNull');
});
