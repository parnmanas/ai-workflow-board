import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCliRuntimeProfile,
  validateCliRuntimeProfiles,
} from '../dist/common/cli-runtime-profiles.js';

const profiles = [
  {
    id: 'local-anthropic',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:9001',
    model: 'model-a',
  },
  {
    id: 'local-openai',
    kind: 'claude-backend',
    protocol: 'openai-compatible',
    base_url: 'http://127.0.0.1:9002/v1',
    model: 'model-b',
    adapter: {
      module: 'proxy',
      base_url: 'http://127.0.0.1:9003',
    },
  },
];

test('validates a configuration-only backend catalog and resolves Agent > Board > Workspace', () => {
  const checked = validateCliRuntimeProfiles(profiles);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.length, 2, 'a second backend/model requires only another profile');
  assert.equal(resolveCliRuntimeProfile(checked.value, [
    { source: 'agent', value: null },
    { source: 'board', value: 'local-openai' },
    { source: 'workspace', value: 'local-anthropic' },
  ]).id, 'local-openai');
  assert.equal(resolveCliRuntimeProfile(checked.value, [
    { source: 'run', value: 'none' },
    { source: 'agent', value: 'local-openai' },
  ]), null);
});

test('returns actionable validation errors without accepting plaintext secrets', () => {
  const checked = validateCliRuntimeProfiles([
    profiles[0],
    { ...profiles[0] },
    {
      id: 'bad-openai',
      kind: 'claude-backend',
      protocol: 'openai-compatible',
      base_url: 'http://127.0.0.1:9002',
      model: 'm',
      env: { AWB_API_KEY: 'reserved', OPENAI_API_KEY: 'plaintext' },
      credential_required: true,
    },
  ]);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /duplicate profile id/);
  assert.match(checked.error, /adapter.*required/s);
  assert.match(checked.error, /reserved/);
  assert.match(checked.error, /sensitive.*credential_ref/s);
  assert.match(checked.error, /credential_ref/);
});

test('missing selected profile fails with its inheritance source', () => {
  assert.throws(
    () => resolveCliRuntimeProfile(profiles, [{ source: 'agent', value: 'deleted' }]),
    /Claude backend profile "deleted".*agent.*does not exist/,
  );
});
