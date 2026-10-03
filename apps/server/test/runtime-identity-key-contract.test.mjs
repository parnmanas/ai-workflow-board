// P4c-2b contract: the runtime identity key MUST be byte-identical between
// the server (`common/runtime-spec.ts`) and the agent-manager
// (`lib/event-dispatcher.ts`). Both sides key API keys, cli-homes and
// dispatch resolution off it — one side changing the recipe silently orphans
// the other's rows. This test pins the two implementations together, plus the
// holder_key / holderAssigneeId round-trip the trigger loop reads.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeHolderKey,
  holderAssigneeId,
  isRuntimeIdentityKey,
  runtimeIdentityKey as serverKey,
} from '../dist/common/runtime-spec.js';

const { runtimeIdentityKey: managerKey } = await import('../../agent-manager/dist/lib/event-dispatcher.js');

const SPEC = {
  manager_agent_id: 'host-1',
  cli: 'Claude',
  model: 'opus',
  working_dir: '/work/app',
  folder_scope: 'shared',
  credential_id: null,
  cli_runtime_profile: null,
  runtime_config: { strategy: 'single', permission_mode: 'approve' },
  label: 'app',
  role_prompt: '',
};

test('server and manager compute the same identity key', () => {
  assert.equal(serverKey(SPEC), managerKey(SPEC));
  assert.match(serverKey(SPEC), /^rt-[0-9a-f]{16}$/);
});

test('key is stable across cosmetic differences, sensitive to identity ones', () => {
  const base = serverKey(SPEC);
  // model / label / role_prompt / host id are NOT identity
  assert.equal(serverKey({ ...SPEC, model: 'other', label: 'x', role_prompt: 'y', manager_agent_id: 'host-2' }), base);
  // cli case-insensitive, rest exact
  assert.equal(serverKey({ ...SPEC, cli: 'claude' }), base);
  assert.notEqual(serverKey({ ...SPEC, cli: 'codex' }), base);
  assert.notEqual(serverKey({ ...SPEC, working_dir: '/other' }), base);
  assert.notEqual(serverKey({ ...SPEC, credential_id: 'c1' }), base);
});

test('holder_key round-trips runtime holders for the trigger loop', () => {
  const key = computeHolderKey({ runtime: SPEC });
  assert.ok(key.startsWith('runtime:'));
  assert.equal(key, `runtime:${serverKey(SPEC)}`);
  assert.equal(holderAssigneeId({ agent_id: null, user_id: null, holder_key: key }), serverKey(SPEC));
  assert.equal(isRuntimeIdentityKey(serverKey(SPEC)), true);
  assert.equal(isRuntimeIdentityKey('agent:whatever'), false);
  // agent rows keep their identity
  assert.equal(holderAssigneeId({ agent_id: 'a1', holder_key: 'agent:a1' }), 'a1');
  // user rows dispatch to nobody
  assert.equal(holderAssigneeId({ agent_id: null, user_id: 'u1', holder_key: 'user:u1' }), null);
});
