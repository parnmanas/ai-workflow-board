import test from 'node:test';
import assert from 'node:assert/strict';
import { DIRECT_WORK_POLICY, stripDirectWorkPolicy, isDirectWorkPolicyTitle } from '../dist/lib/ticket-creation-policy.js';
import { isSyntheticPrompt } from '../dist/lib/agent-session-history.js';

test('manager policy is hidden while combined user input survives', () => {
  const prefix = `${DIRECT_WORK_POLICY}\n\nSession Git workflow: main. Working directory: /tmp/repo. Base branch: main.`;
  assert.equal(stripDirectWorkPolicy(prefix), '');
  assert.equal(isSyntheticPrompt(prefix), true);
  assert.equal(stripDirectWorkPolicy(`${prefix}\n\nFix the login`), 'Fix the login');
  assert.equal(isSyntheticPrompt(`${prefix}\n\nFix the login`), false);
  assert.equal(stripDirectWorkPolicy('Explain AWB work policy:'), 'Explain AWB work policy:');
  assert.equal(isDirectWorkPolicyTitle('AWB work policy: - Perform requested work'), true);
  assert.equal(isDirectWorkPolicyTitle('Login fix'), false);
});
