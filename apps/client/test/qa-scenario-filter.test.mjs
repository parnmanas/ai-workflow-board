import assert from 'node:assert/strict';
import test from 'node:test';
import { filterQaScenarios, qaBatchIds, qaDeliveryForm, qaDeliveryPayload } from '../src/components/admin/qaScenario.logic.ts';

const rows = [
  { id: 'a', project_id: 'project-a', name: 'Login', description: 'OAuth', tags: ['smoke'], enabled: true },
  { id: 'b', project_id: 'project-b', name: 'Login B', tags: [], enabled: true },
  { id: 'disabled', project_id: 'project-a', name: 'Paused', tags: [], enabled: false },
  { id: 'legacy', project_id: null, name: 'Legacy', tags: [], enabled: true },
];
test('filtered execution never includes hidden, disabled, or stale selected scenarios', () => {
  const visible = filterQaScenarios(rows, 'project-a', '', 'all');
  assert.deepEqual(qaBatchIds(visible), ['a']);
  assert.deepEqual(qaBatchIds(visible, new Set(['b', 'disabled', 'missing'])), []);
  assert.deepEqual(filterQaScenarios(rows, '', 'SMOKE', 'all').map(s => s.id), ['a']);
  assert.deepEqual(filterQaScenarios(rows, 'unassigned', '', 'all').map(s => s.id), ['legacy']);
  assert.deepEqual(filterQaScenarios(rows, '', '', 'disabled').map(s => s.id), ['disabled']);
});
test('record-only, share-only, email-only and combined settings round trip independently', () => {
  assert.equal(qaDeliveryPayload(qaDeliveryForm(null)), null);
  for (const policy of [
    { when: 'failure', channel_ids: ['channel'], email: null },
    { when: 'always', channel_ids: [], email: { connection_id: 'mail', from: 'qa@example.test', to: ['owner@example.test'] } },
    { when: 'failure', channel_ids: ['channel'], email: { connection_id: 'mail', from: 'qa@example.test', to: ['owner@example.test'] } },
  ]) assert.deepEqual(qaDeliveryPayload(qaDeliveryForm(policy)), policy);
  assert.throws(() => qaDeliveryPayload({ ...qaDeliveryForm(null), share: true }), /채널/);
  assert.throws(() => qaDeliveryPayload({ ...qaDeliveryForm(null), email: true }), /수신자/);
});
