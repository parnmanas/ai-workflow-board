// ticket c3b767c6 — dispatch-gated feature flags on the instance heartbeat.
// Same fetch-stubbing technique as runtime-heartbeat.test.mjs's "instance
// heartbeat publishes the cached runtime capability report" test: capture the
// actual POST body InstanceHeartbeat sends, rather than asserting on an
// internal object, so a producer-side flatten bug can't hide.

import assert from 'node:assert/strict';
import test from 'node:test';

import { InstanceHeartbeat } from '../dist/lib/instance-heartbeat.js';
import {
  MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP,
  MANAGER_CAPABILITIES,
} from '../dist/lib/runtime-profiles.js';

function stubFetch(t) {
  const originalFetch = globalThis.fetch;
  let resolvePayload;
  const payloadPromise = new Promise((resolve) => { resolvePayload = resolve; });
  globalThis.fetch = async (_url, init) => {
    resolvePayload(JSON.parse(init.body));
    return new Response(null, { status: 204 });
  };
  t.after(() => { globalThis.fetch = originalFetch; });
  return payloadPromise;
}

test('MANAGER_CAPABILITIES declares context_window_clamp — this build must self-report the feature it implements', () => {
  assert.ok(MANAGER_CAPABILITIES.includes(MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP));
});

test('instance heartbeat publishes manager_capabilities on the wire when passed', async (t) => {
  const payloadPromise = stubFetch(t);
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' },
    'manager-1',
    {
      mode: 'manager',
      version: 'test',
      cli: 'mixed',
      cliAdapters: [],
      managerCapabilities: MANAGER_CAPABILITIES,
    },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();

  const payload = await payloadPromise;
  assert.deepEqual(payload.manager_capabilities, [MANAGER_CAPABILITY_CONTEXT_WINDOW_CLAMP]);
});

test('instance heartbeat omits manager_capabilities entirely when not passed (legacy wire shape, not an empty array)', async (t) => {
  const payloadPromise = stubFetch(t);
  const heartbeat = new InstanceHeartbeat(
    { url: 'http://awb.invalid', apiKey: 'secret', workspace_id: 'ws-1' },
    'manager-2',
    {
      mode: 'manager',
      version: 'test',
      cli: 'mixed',
      cliAdapters: [],
    },
  );
  t.after(() => heartbeat.stop());
  heartbeat.start();

  const payload = await payloadPromise;
  assert.equal('manager_capabilities' in payload, false);
});
