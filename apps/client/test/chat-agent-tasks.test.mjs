import assert from 'node:assert/strict';
import test from 'node:test';
import { getDmAgentPartnerId, normalizeAgentTasks } from '../src/components/chat/utils/agentTasks.ts';

const legacy = { ticket_id: 'legacy', ticket_title: 'Legacy', claimed_at: '2026-01-01T00:00:00Z' };
const current = { ticket_id: 'current', ticket_title: 'Current', claimed_at: '2026-01-01T00:00:00Z' };

test('active_tasks wins and current_task remains a legacy fallback', () => {
  assert.deepEqual(normalizeAgentTasks({ active_tasks: [current], current_task: legacy }), [current]);
  assert.deepEqual(normalizeAgentTasks({ current_task: legacy }), [legacy]);
  assert.deepEqual(normalizeAgentTasks({ active_tasks: [] }), []);
});

test('only a participant agent DM resolves a task owner', () => {
  const base = { roomType: 'dm', currentUserId: 'me', isObserver: false };
  assert.equal(getDmAgentPartnerId({ ...base, participants: [{ id: 'me', name: 'Me', type: 'user' }, { id: 'agent', name: 'Agent', type: 'agent' }] }), 'agent');
  assert.equal(getDmAgentPartnerId({ ...base, roomType: 'group', participants: [{ id: 'agent', name: 'Agent', type: 'agent' }] }), null);
  assert.equal(getDmAgentPartnerId({ ...base, isObserver: true, participants: [{ id: 'agent', name: 'Agent', type: 'agent' }] }), null);
  assert.equal(getDmAgentPartnerId({ ...base, participants: [{ id: 'me', name: 'Me', type: 'user' }, { id: 'other', name: 'Other', type: 'user' }] }), null);
});
