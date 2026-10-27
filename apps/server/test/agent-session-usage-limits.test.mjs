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

test('focus quota read is scoped to the host account and leaves conversation/runtime state alone', async () => {
  const service = Object.create(AgentSessionsService.prototype);
  Object.assign(service, { live: new Map(), liveRevision: 0, awaiting: new Map() });
  const state = service.createState('host', 'Host', 'codex', 'session-quota', { cwd: '/repo', title: 'Task', status: 'busy', driver_user_id: 'owner' });
  const before = service.snapshot(state);
  service.requireHost = (account, host, cli) => {
    assert.equal(account, 'account'); assert.equal(host, 'host'); assert.equal(cli, 'codex');
  };
  const payload = { limit_id: 'codex', observed_at: '2026-10-27T10:00:00Z', windows: [{ id: 'primary', used_percent: 68, window_minutes: 300, resets_at: null }] };
  service.rpc = async (...args) => {
    assert.deepEqual(args, ['host', 'codex', 'usage_limits', { account_id: 'account', session_id: 'session-quota' }, 'reader']);
    return { events: [{ type: 'usage_limits', payload }, { type: 'text', payload: { text: 'must not reach quota refresh' } }] };
  };
  const result = await service.getUsageLimits('account', 'reader', 'host', 'codex', 'session-quota');
  assert.equal(result.events.length, 1);
  assert.deepEqual(result.events[0].payload, payload);
  assert.deepEqual(service.snapshot(state), before);
  service.requireHost = () => { throw new Error('account_access_denied'); };
  await assert.rejects(service.getUsageLimits('other-account', 'reader', 'host', 'codex', 'session-quota'), /account_access_denied/);
});
