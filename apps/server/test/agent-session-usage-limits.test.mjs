import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentSessionsService } from '../dist/modules/agent-sessions/agent-sessions.service.js';
import { activityEvents } from '../dist/services/activity.service.js';

test('quota events reach the session driver without changing status or becoming conversation text', (t) => {
  const service = Object.create(AgentSessionsService.prototype);
  Object.assign(service, { live: new Map(), liveRevision: 0, awaiting: new Map() });
  service.createState('host', 'Host', 'codex', 'session-quota', { cwd: '/repo', title: 'Task', status: 'ready', driver_user_id: 'owner' });
  const payload = { limit_id: 'codex', observed_at: '2026-10-27T10:00:00Z', windows: [{ id: 'primary', used_percent: 42, window_minutes: 300, resets_at: null }] };
  const received = [];
  const listener = (value) => received.push(value);
  activityEvents.on('agent_session_event', listener);
  t.after(() => activityEvents.off('agent_session_event', listener));
  assert.equal(service.relayEvents('host', 'codex', 'session-quota', [{ id: 'quota-1', seq: 1, type: 'usage_limits', payload }]).relayed, 1);
  assert.deepEqual(received[0].event.payload, payload);
  assert.equal(received[0].driver_user_id, 'owner');
  assert.equal(service.liveSnapshot('host', 'codex', 'session-quota').status, 'ready');
});
