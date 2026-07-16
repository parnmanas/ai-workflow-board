// Environment Setup simplification (ticket 8fbe90e9): Board/Workspace
// environment_config is now a repository-Resource picker only. This guards the
// three contracts the change rests on:
//
//   1. WRITE (validateEnvironmentConfigInput) normalises any input to
//      { repositories: [{ resource_id }] } — legacy keys are DROPPED (not 400'd,
//      so a not-yet-reloaded client bundle during a deploy window still saves),
//      and a repository with no resource_id is rejected.
//   2. READ (parseEnvironmentConfig) stays permissive so a board already saved
//      with the legacy keys keeps parsing + executing unchanged (backward compat).
//   3. RESOLVE (resolveEnvironmentConfig) turns a resource-only config into a
//      concrete worktree-bootstrap repo (url/branch from the Resource, target_dir
//      defaulted) that satisfies the agent-manager parse invariants — proving the
//      "pick a repo → worktree provisioning" path still holds end-to-end.
//
// Pure functions, zod-only — imported from the built dist like the other
// common/ unit tests (run after `npm run build`).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateEnvironmentConfigInput,
  serializeEnvironmentConfig,
  parseEnvironmentConfig,
  mergeEnvironmentConfig,
  resolveEnvironmentConfig,
} from '../dist/common/environment-config.js';

// ── 1. WRITE PATH — repository-Resource-only normalisation ──────────────────

test('write: accepts a repository-Resource-only config verbatim', () => {
  const r = validateEnvironmentConfigInput({ repositories: [{ resource_id: 'res-1' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { repositories: [{ resource_id: 'res-1' }] });
});

test('write: strips legacy top-level AND per-repo keys (deploy-window compat)', () => {
  // Exactly what the OLD client bundle / a legacy MCP caller still POSTs.
  const legacy = {
    repositories: [
      {
        resource_id: 'res-1',
        url: 'https://github.com/x/y.git',
        target_dir: 'repos/y',
        branch: 'main',
        post_clone_commands: ['npm ci'],
      },
    ],
    env_vars: { NODE_ENV: 'development' },
    setup_commands: ['npm run build'],
    setup_timeout_seconds: 120,
    version: 3,
  };
  const r = validateEnvironmentConfigInput(legacy);
  assert.equal(r.ok, true, 'legacy shape is accepted, not rejected');
  assert.deepEqual(
    r.value,
    { repositories: [{ resource_id: 'res-1' }] },
    'only repositories[].resource_id survives; every legacy key is dropped',
  );
});

test('write: trims resource_id whitespace', () => {
  const r = validateEnvironmentConfigInput({ repositories: [{ resource_id: '  res-2  ' }] });
  assert.equal(r.ok, true);
  assert.equal(r.value.repositories[0].resource_id, 'res-2');
});

test('write: rejects a repository with no resource_id (url-only)', () => {
  const r = validateEnvironmentConfigInput({ repositories: [{ url: 'https://github.com/x/y.git' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /resource_id/i, 'error names the missing resource_id path');
});

test('write: rejects a whitespace-only resource_id', () => {
  const r = validateEnvironmentConfigInput({ repositories: [{ resource_id: '   ' }] });
  assert.equal(r.ok, false);
});

test('write: empty / repo-less config serializes back to null', () => {
  for (const input of [{}, { repositories: [] }, { env_vars: { A: '1' }, setup_commands: ['x'] }]) {
    const r = validateEnvironmentConfigInput(input);
    assert.equal(r.ok, true, `accepted: ${JSON.stringify(input)}`);
    assert.equal(serializeEnvironmentConfig(r.value), null, `→ null: ${JSON.stringify(input)}`);
  }
});

// ── 2. READ PATH — legacy configs keep parsing (backward compat) ────────────

test('read: a legacy full config still parses with its legacy keys retained', () => {
  const legacyStored = JSON.stringify({
    repositories: [
      {
        resource_id: 'res-1',
        url: 'https://github.com/x/y.git',
        target_dir: 'repos/y',
        branch: 'main',
        post_clone_commands: ['npm ci'],
      },
    ],
    env_vars: { A: '1' },
    setup_commands: ['make'],
    setup_timeout_seconds: 300,
    version: 2,
  });
  const parsed = parseEnvironmentConfig(legacyStored);
  assert.ok(parsed, 'legacy stored config is NOT dropped to null on read');
  assert.equal(parsed.env_vars.A, '1', 'legacy env_vars survive read → still injected at dispatch');
  assert.deepEqual(parsed.setup_commands, ['make'], 'legacy setup_commands survive read');
  assert.equal(parsed.repositories[0].url, 'https://github.com/x/y.git');
});

test('read: a url-only (resource-less) legacy repo still parses (read path unchanged)', () => {
  const parsed = parseEnvironmentConfig(
    JSON.stringify({ repositories: [{ url: 'https://github.com/x/y.git', target_dir: 'repos/y' }] }),
  );
  assert.ok(parsed, 'url-only repo is a valid stored/read shape');
  assert.equal(parsed.repositories[0].url, 'https://github.com/x/y.git');
});

// ── 3. RESOLVE — resource-only config → worktree-bootstrap repo ──────────────

const REPO_URL = 'https://github.com/parnmanas/ai-workflow-board.git';
const lookup = (id) => (id === 'res-1' ? { url: REPO_URL, default_branch: 'main' } : null);

test('resolve: a resource-only config expands to a concrete worktree-bootstrap repo', () => {
  const cfg = parseEnvironmentConfig(JSON.stringify({ repositories: [{ resource_id: 'res-1' }] }));
  const resolved = resolveEnvironmentConfig(cfg, lookup);
  assert.ok(resolved, 'resolves to an actionable config');
  const repo0 = resolved.repositories[0];
  assert.equal(repo0.resource_id, 'res-1');
  assert.equal(repo0.url, REPO_URL, 'url derived from the Resource (not entered in the UI)');
  assert.equal(repo0.branch, 'main', 'branch derived from the Resource default_branch');
  assert.equal(repo0.target_dir, 'repos/ai-workflow-board', 'target_dir defaulted server-side');
});

test('resolve output satisfies the agent-manager parse + bootstrap invariants', () => {
  // Mirror of apps/agent-manager/src/lib/event-dispatcher.ts:
  //  - parseEnvironmentConfig DROPS a repo whose url OR target_dir is empty
  //    (lines ~180-183) — a resource-only config must therefore still resolve
  //    both, or the ticket worktree bootstrap would silently lose its repo.
  //  - resolveBootstrapRepository(baseRepo=null, env) reads env.repositories[0]
  //    → { resourceId, url, branch } (line ~236-237).
  const cfg = parseEnvironmentConfig(JSON.stringify({ repositories: [{ resource_id: 'res-1' }] }));
  const resolved = resolveEnvironmentConfig(cfg, lookup);
  // Round-trip through the SSE wire (JSON) the way the dispatch path ships it.
  const wire = JSON.parse(JSON.stringify(resolved));
  const repo0 = wire.repositories[0];
  assert.ok(repo0.url && repo0.url.length > 0, 'agent-manager requires a non-empty url');
  assert.ok(repo0.target_dir && repo0.target_dir.length > 0, 'agent-manager requires a non-empty target_dir');
  const bootstrap = { resourceId: repo0.resource_id || '', url: repo0.url, branch: repo0.branch };
  assert.deepEqual(bootstrap, { resourceId: 'res-1', url: REPO_URL, branch: 'main' });
});

test('resolve: a resource_id that fails lookup and has no url is dropped (not shipped un-cloneable)', () => {
  const cfg = parseEnvironmentConfig(JSON.stringify({ repositories: [{ resource_id: 'missing' }] }));
  const resolved = resolveEnvironmentConfig(cfg, lookup); // lookup('missing') → null
  assert.equal(resolved, null, 'nothing actionable remains → null (dispatch treats as no env setup)');
});

// ── merge — simplified configs still merge key-level (board over workspace) ──

test('merge: board repositories override the workspace default', () => {
  const merged = mergeEnvironmentConfig(
    JSON.stringify({ repositories: [{ resource_id: 'ws-repo' }] }),
    JSON.stringify({ repositories: [{ resource_id: 'board-repo' }] }),
  );
  assert.deepEqual(merged.repositories, [{ resource_id: 'board-repo' }]);
});
