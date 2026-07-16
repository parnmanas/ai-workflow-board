// Board Environment Setup editor logic (ticket 8fbe90e9). The editor is a
// repository-Resource picker; its load-bearing, React-free logic lives in
// environmentConfig.logic.ts (extracted for testability — this repo has no
// jsdom, see root CLAUDE.md). We test the real module the component imports:
//   - parseEnvironmentConfigRaw: tolerant LOAD → selected resource_ids +
//     hasLegacy flag (drives the "will be dropped on save" note).
//   - buildEnvironmentConfig: SAVE → { repositories: [{ resource_id }] } | null.
//
// Run: node --import tsx --test apps/client/test/environment-config-editor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvironmentConfigRaw,
  buildEnvironmentConfig,
} from '../src/components/environmentConfig.logic.ts';

// ── LOAD (parse) ────────────────────────────────────────────────────────────

test('parse: null / empty / malformed raw → empty, no legacy', () => {
  for (const raw of [null, undefined, '', '{bad json', '42', '"str"', '[]']) {
    assert.deepEqual(parseEnvironmentConfigRaw(raw), { resourceIds: [], hasLegacy: false }, `raw=${raw}`);
  }
});

test('parse: a repository-Resource-only config → resource_ids, no legacy', () => {
  const raw = JSON.stringify({ repositories: [{ resource_id: 'a' }, { resource_id: 'b' }] });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), { resourceIds: ['a', 'b'], hasLegacy: false });
});

test('parse: trims resource_id and drops blank repos', () => {
  const raw = JSON.stringify({ repositories: [{ resource_id: '  a  ' }, { resource_id: '' }] });
  const p = parseEnvironmentConfigRaw(raw);
  assert.deepEqual(p.resourceIds, ['a']);
  assert.equal(p.hasLegacy, true, 'a resource_id-less repo counts as legacy (can\'t be shown as a pick)');
});

test('parse: legacy top-level keys flag hasLegacy but resource_ids still extracted', () => {
  const raw = JSON.stringify({
    repositories: [{ resource_id: 'a' }],
    env_vars: { NODE_ENV: 'development' },
    setup_commands: ['npm ci'],
    setup_timeout_seconds: 120,
    version: 2,
  });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), { resourceIds: ['a'], hasLegacy: true });
});

test('parse: legacy per-repo keys (url/branch/target_dir/post_clone) flag hasLegacy', () => {
  const raw = JSON.stringify({
    repositories: [{ resource_id: 'a', url: 'u', branch: 'main', target_dir: 'repos/a', post_clone_commands: ['x'] }],
  });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), { resourceIds: ['a'], hasLegacy: true });
});

test('parse: a url-only (resource-less) repo → hasLegacy, no editable id', () => {
  const raw = JSON.stringify({ repositories: [{ url: 'https://github.com/x/y.git' }] });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), { resourceIds: [], hasLegacy: true });
});

// ── SAVE (build) ─────────────────────────────────────────────────────────────

test('build: selected ids → { repositories: [{ resource_id }] }', () => {
  assert.deepEqual(buildEnvironmentConfig(['a', 'b']), {
    repositories: [{ resource_id: 'a' }, { resource_id: 'b' }],
  });
});

test('build: blank / whitespace rows collapse; all-empty → null', () => {
  assert.deepEqual(buildEnvironmentConfig(['a', '', '  ']), { repositories: [{ resource_id: 'a' }] });
  assert.equal(buildEnvironmentConfig([]), null);
  assert.equal(buildEnvironmentConfig(['', '   ']), null);
});

test('load→save round-trip drops legacy fields (the migration-on-save behaviour)', () => {
  const legacyRaw = JSON.stringify({
    repositories: [{ resource_id: 'a', url: 'u', branch: 'main' }],
    env_vars: { A: '1' },
    setup_commands: ['npm ci'],
  });
  const { resourceIds } = parseEnvironmentConfigRaw(legacyRaw);
  assert.deepEqual(buildEnvironmentConfig(resourceIds), { repositories: [{ resource_id: 'a' }] });
});
