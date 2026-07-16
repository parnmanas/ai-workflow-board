// Board Environment Setup editor logic (ticket 8fbe90e9). The editor is a
// SINGLE repository-Resource picker; its load-bearing, React-free logic lives in
// environmentConfig.logic.ts (extracted for testability — this repo has no
// jsdom, see root CLAUDE.md). We test the real module the component imports:
//   - parseEnvironmentConfigRaw: tolerant LOAD → the single selected resource_id
//     + hasLegacy (drives the "will be dropped on save" note) +
//     losesWorktreeSourceOnSave (drives the stronger url-only warning).
//   - buildEnvironmentConfig: SAVE → { repositories: [{ resource_id }] } | null.
//
// Run: node --import tsx --test apps/client/test/environment-config-editor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseEnvironmentConfigRaw,
  buildEnvironmentConfig,
} from '../src/components/environmentConfig.logic.ts';

const EMPTY = { resourceId: '', hasLegacy: false, losesWorktreeSourceOnSave: false };

// ── LOAD (parse) ────────────────────────────────────────────────────────────

test('parse: null / empty / malformed raw → empty, no legacy', () => {
  for (const raw of [null, undefined, '', '{bad json', '42', '"str"', '[]']) {
    assert.deepEqual(parseEnvironmentConfigRaw(raw), EMPTY, `raw=${raw}`);
  }
});

test('parse: a single repository-Resource config → resourceId, no legacy', () => {
  const raw = JSON.stringify({ repositories: [{ resource_id: 'a' }] });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), {
    resourceId: 'a',
    hasLegacy: false,
    losesWorktreeSourceOnSave: false,
  });
});

test('parse: extra repositories beyond the first → keep first, flag legacy', () => {
  // Only repositories[0] is ever provisioned; the rest are dead config dropped on save.
  const raw = JSON.stringify({ repositories: [{ resource_id: 'a' }, { resource_id: 'b' }] });
  const p = parseEnvironmentConfigRaw(raw);
  assert.equal(p.resourceId, 'a', 'the provisioned (first) repo is the editable selection');
  assert.equal(p.hasLegacy, true, 'the dropped second repo is flagged');
  assert.equal(p.losesWorktreeSourceOnSave, false, 'a Resource-backed repo survives → no source loss');
});

test('parse: trims resource_id and treats a blank repo as legacy', () => {
  const raw = JSON.stringify({ repositories: [{ resource_id: '  a  ' }, { resource_id: '' }] });
  const p = parseEnvironmentConfigRaw(raw);
  assert.equal(p.resourceId, 'a');
  assert.equal(p.hasLegacy, true, "a resource_id-less repo counts as legacy (can't be shown as a pick)");
});

test('parse: legacy top-level keys flag hasLegacy but resourceId still extracted', () => {
  const raw = JSON.stringify({
    repositories: [{ resource_id: 'a' }],
    env_vars: { NODE_ENV: 'development' },
    setup_commands: ['npm ci'],
    setup_timeout_seconds: 120,
    version: 2,
  });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), {
    resourceId: 'a',
    hasLegacy: true,
    losesWorktreeSourceOnSave: false,
  });
});

test('parse: legacy per-repo keys (url/branch/target_dir/post_clone) flag hasLegacy', () => {
  const raw = JSON.stringify({
    repositories: [{ resource_id: 'a', url: 'u', branch: 'main', target_dir: 'repos/a', post_clone_commands: ['x'] }],
  });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), {
    resourceId: 'a',
    hasLegacy: true,
    losesWorktreeSourceOnSave: false,
  });
});

test('parse: a url-only (resource-less) repo → losesWorktreeSourceOnSave, no editable id', () => {
  const raw = JSON.stringify({ repositories: [{ url: 'https://github.com/x/y.git' }] });
  assert.deepEqual(parseEnvironmentConfigRaw(raw), {
    resourceId: '',
    hasLegacy: true,
    losesWorktreeSourceOnSave: true,
  });
});

test('parse: url-only repo ALONGSIDE a Resource repo → no source loss (Resource survives)', () => {
  const raw = JSON.stringify({
    repositories: [{ resource_id: 'a' }, { url: 'https://github.com/x/y.git' }],
  });
  const p = parseEnvironmentConfigRaw(raw);
  assert.equal(p.resourceId, 'a');
  assert.equal(p.hasLegacy, true);
  assert.equal(p.losesWorktreeSourceOnSave, false, 'the Resource repo is kept, so the source is not lost');
});

// ── SAVE (build) ─────────────────────────────────────────────────────────────

test('build: a selected id → { repositories: [{ resource_id }] }', () => {
  assert.deepEqual(buildEnvironmentConfig('a'), { repositories: [{ resource_id: 'a' }] });
});

test('build: blank / whitespace / empty selection → null', () => {
  assert.equal(buildEnvironmentConfig(''), null);
  assert.equal(buildEnvironmentConfig('   '), null);
  assert.equal(buildEnvironmentConfig(null), null);
  assert.equal(buildEnvironmentConfig(undefined), null);
});

test('build: trims the selected id', () => {
  assert.deepEqual(buildEnvironmentConfig('  a  '), { repositories: [{ resource_id: 'a' }] });
});

// ── LOAD → SAVE round-trip (the migration-on-save behaviour) ─────────────────

test('round-trip: legacy fields + extra repo drop; the first repo is what bootstrap uses', () => {
  const legacyRaw = JSON.stringify({
    repositories: [{ resource_id: 'a', url: 'u', branch: 'main' }, { resource_id: 'b' }],
    env_vars: { A: '1' },
    setup_commands: ['npm ci'],
  });
  const { resourceId } = parseEnvironmentConfigRaw(legacyRaw);
  // Saving persists exactly the single first repo — the one env.repositories[0]
  // (worktree bootstrap) consumes — with every legacy key + the extra repo dropped.
  assert.deepEqual(buildEnvironmentConfig(resourceId), { repositories: [{ resource_id: 'a' }] });
});

test('round-trip: changing the selection saves the newly-picked repo', () => {
  const { resourceId } = parseEnvironmentConfigRaw(JSON.stringify({ repositories: [{ resource_id: 'a' }] }));
  assert.equal(resourceId, 'a');
  // Operator picks a different Resource in the single dropdown, then Saves.
  assert.deepEqual(buildEnvironmentConfig('c'), { repositories: [{ resource_id: 'c' }] });
});
