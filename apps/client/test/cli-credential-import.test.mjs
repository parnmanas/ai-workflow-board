import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(
  new URL('../src/components/admin/CliCredentialImport.tsx', import.meta.url),
  'utf8',
);
const resourceSource = fs.readFileSync(
  new URL('../src/components/admin/ResourceManager.tsx', import.meta.url),
  'utf8',
);

test('Resources exposes the Codex and Claude CLI login credential importer', () => {
  assert.match(resourceSource, /<CliCredentialImport/);
  assert.match(source, /codex login/);
  assert.match(source, /claude login/);
  assert.match(source, /~\/\.codex\/auth\.json/);
  assert.match(source, /~\/\.claude\/\.credentials\.json/);
});

test('CLI login imports use the existing encrypted subscription credential API', () => {
  assert.match(source, /provider: 'codex_subscription'/);
  assert.match(source, /field: 'auth_json'/);
  assert.match(source, /provider: 'claude_subscription'/);
  assert.match(source, /field: 'credentials_json'/);
  assert.match(source, /await api\.createCredential\(/);
  assert.match(source, /validateJsonFile\(credentialJson\)/);
});

test('Codex config is optional and credential scope follows the Resources view', () => {
  assert.match(source, /config_toml: configToml/);
  assert.match(source, /scope: createScope === 'global' \? 'global' : 'workspace'/);
  assert.match(source, /workspace_id: createScope === 'global' \? undefined : workspaceId/);
});
