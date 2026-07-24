import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCliRuntimeProfile,
  validateCliRuntimeProfiles,
} from '../dist/common/cli-runtime-profiles.js';

const profiles = [{
  id: 'local-vllm',
  provider: 'vllm',
  type: 'server',
  model: 'demo',
  module: 'vllm.entrypoints.openai.api_server',
  port: 8000,
}];

test('validates registry and resolves Agent > Board > Workspace with explicit none', () => {
  const checked = validateCliRuntimeProfiles(profiles);
  assert.equal(checked.ok, true);
  const profile = resolveCliRuntimeProfile(checked.value, [
    { source: 'agent', value: null },
    { source: 'board', value: 'local-vllm' },
    { source: 'workspace', value: 'none' },
  ]);
  assert.equal(profile.id, 'local-vllm');
  assert.equal(resolveCliRuntimeProfile(checked.value, [
    { source: 'agent', value: 'none' },
    { source: 'board', value: 'local-vllm' },
  ]), null);
});

test('rejects duplicate ids, invalid ports, reserved env and missing credentials', () => {
  const checked = validateCliRuntimeProfiles([
    ...profiles,
    { ...profiles[0], port: 70_000, env: { AWB_API_KEY: 'leak' }, credential_required: true },
  ]);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /duplicate profile id/);
  assert.match(checked.error, /<=65535/);
  assert.match(checked.error, /reserved/);
  assert.match(checked.error, /credential_ref/);
});

test('missing selected profile fails with source instead of silently falling back', () => {
  assert.throws(
    () => resolveCliRuntimeProfile(profiles, [{ source: 'agent', value: 'deleted' }]),
    /"deleted".*agent.*does not exist/,
  );
});
