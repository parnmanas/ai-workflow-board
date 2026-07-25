import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parseCliRuntimeProfiles,
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

const here = dirname(fileURLToPath(import.meta.url));
const triggerSource = await readFile(
  join(here, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts'),
  'utf8',
);

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

test('migrates safely reusable legacy Anthropic rows instead of silently dropping the catalog', () => {
  const migrated = parseCliRuntimeProfiles(JSON.stringify([{
    id: 'legacy-anthropic',
    provider: 'anthropic',
    type: 'server',
    model: 'legacy-model',
    base_url: 'http://127.0.0.1:9010',
    shutdown_policy: 'reuse',
    claude: { env: { LEGACY_PUBLIC: 'preserved' }, args: ['--legacy-flag'] },
  }]));
  assert.deepEqual(migrated, [{
    id: 'legacy-anthropic',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:9010',
    model: 'legacy-model',
    env: { LEGACY_PUBLIC: 'preserved' },
    args: ['--legacy-flag'],
    credential_required: false,
    auth_env: 'ANTHROPIC_AUTH_TOKEN',
  }]);
});

test('legacy backend-launch rows fail with an actionable migration error', () => {
  const legacyVllm = [{
    id: 'legacy-vllm',
    provider: 'vllm',
    type: 'server',
    model: 'demo',
    module: 'vllm.entrypoints.openai.api_server',
    port: 8000,
  }];
  const checked = validateCliRuntimeProfiles(legacyVllm);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /legacy profile "legacy-vllm".*cannot be migrated safely.*openai-compatible.*adapter.*no longer starts/s);
  assert.throws(
    () => parseCliRuntimeProfiles(JSON.stringify(legacyVllm)),
    /legacy profile "legacy-vllm".*cannot be migrated safely/,
  );
});

test('trigger dispatch resolves and validates Claude backend profiles only for Claude agents', () => {
  const guard = triggerSource.match(
    /if \(agent\?\.type === 'claude'\) \{[\s\S]*?runtimeProfile = resolveCliRuntimeProfile\([\s\S]*?credential_required[\s\S]*?\n    \}/,
  );
  assert.ok(guard, 'profile resolution and credential validation must share an agent.type === claude guard');
  assert.match(
    triggerSource,
    /let runtimeProfile: CliRuntimeProfile \| null = null;/,
    'non-Claude SSE payload must retain a null cli_runtime_profile',
  );
  assert.doesNotMatch(
    triggerSource.slice(guard.index + guard[0].length),
    /runtimeProfile = resolveCliRuntimeProfile/,
    'profile resolution must not have an unguarded fallback',
  );
});
