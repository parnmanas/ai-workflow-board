// Empty/default selections must stay on Anthropic even with a legacy host override.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoomBroadcastRuntimeProfile, resolveTriggerRuntimeProfile } from '../dist/lib/event-dispatcher.js';

const HOST_PROFILE = {
  id: 'host-vllm', protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:8000', model: 'qwen',
};
const SELECTED_PROFILE = { ...HOST_PROFILE, id: 'selected-backend', model: 'selected-model' };

for (const selection of [undefined, null, '', 'default', 'none', { id: 'incomplete' }]) {
  test(`ticket/DM: ${JSON.stringify(selection)} never inherits the host backend`, () => {
    assert.equal(resolveTriggerRuntimeProfile(selection, HOST_PROFILE), null);
  });
  test(`broadcast: ${JSON.stringify(selection)} never inherits host or another member's backend`, () => {
    const payload = { cli_runtime_profiles: { member: selection, other: SELECTED_PROFILE } };
    assert.equal(resolveRoomBroadcastRuntimeProfile(payload, 'member', HOST_PROFILE), null);
  });
}

for (const host of [undefined, null, HOST_PROFILE]) {
  test(`explicit execution profile is used with host=${host?.id}`, () => {
    assert.deepEqual(resolveTriggerRuntimeProfile(SELECTED_PROFILE, host), SELECTED_PROFILE);
    assert.deepEqual(resolveRoomBroadcastRuntimeProfile({
      cli_runtime_profiles: { member: SELECTED_PROFILE },
    }, 'member', host), SELECTED_PROFILE);
  });
}

test('missing broadcast map or responder stays native', () => {
  assert.equal(resolveRoomBroadcastRuntimeProfile({}, 'member', HOST_PROFILE), null);
  assert.equal(resolveRoomBroadcastRuntimeProfile({ cli_runtime_profiles: { '': SELECTED_PROFILE } }, '', HOST_PROFILE), null);
});
