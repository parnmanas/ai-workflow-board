import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTranscript } from '../src/components/sessions/sessionTranscript.logic.ts';
import { DIRECT_WORK_POLICY } from '../../agent-manager/src/lib/ticket-creation-policy.ts';

const event = (text, id = 'history:1') => ({ id, seq: 1, type: 'user_prompt', turn_id: 't1', payload: { text }, created_at: '' });
test('policy history is invisible; combined and local user input is retained', () => {
  const prefix = `${DIRECT_WORK_POLICY}\n\nSession Git workflow: main. Working directory: /tmp/repo. Base branch: main.`;
  assert.deepEqual(buildTranscript([event(prefix)]), []);
  assert.equal(buildTranscript([event(`${prefix}\n\nFix login`)])[0].text, 'Fix login');
  assert.equal(buildTranscript([event(prefix, 'local:1')])[0].text, prefix);
});
