import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAgentAccountId,
  agentIsVisibleInAccount,
  agentAccountWhere,
} from '../dist/common/agent-account-scope.js';

test('agent account normalization represents a missing owner as null', () => {
  for (const value of [null, undefined, '', '   ']) {
    assert.equal(normalizeAgentAccountId(value), null);
  }
  assert.equal(normalizeAgentAccountId(' account-a '), 'account-a');
});

test('only agents owned by the target account are visible', () => {
  for (const value of [null, undefined, '', '   ', 'account-b']) {
    assert.equal(agentIsVisibleInAccount(value, 'account-a'), false);
  }
  assert.equal(agentIsVisibleInAccount('account-a', 'account-a'), true);
  assert.equal(agentIsVisibleInAccount(null, ''), false, 'callers must provide a concrete target account');
});

test('agent account query excludes unowned and foreign hosts', () => {
  const where = agentAccountWhere('account-a');
  assert.equal(where.length, 1);
  assert.equal(where[0].account_id, 'account-a');
});
