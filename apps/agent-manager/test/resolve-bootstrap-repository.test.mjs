// resolveBootstrapRepository (ticket 112ea3c5) — the pure function that picks
// WHICH repo/branch feeds WorktreeManager.resolveCwd's `bootstrapRepo`, i.e.
// the seed every downstream worktree path (`.awb/wt/<resourceSlug>/…`) is
// scoped under. It mirrors the server's `pickBaseRepoResourceId`
// (base-repo-binding.ts) precedence — ticket own repo wins, else the board
// environment's first repository — but had ZERO direct tests: only the SSE
// wire shape (server `agent_trigger` flatten) was covered
// (apps/server/test/base-repo-binding.test.mjs), never this function's own
// contract. A silent drift here (e.g. picking env.repositories[1] instead of
// [0], or not trimming an empty ticket url) would misdirect the whole
// worktree tree without any existing test failing.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveBootstrapRepository } from '../dist/lib/event-dispatcher.js';

const TICKET_REPO = {
  id: 'ticket-resource',
  name: 'Ticket Repo',
  url: 'https://github.com/acme/ticket-repo.git',
  default_branch: 'develop',
};

function env(repositories) {
  return {
    repositories,
    env_vars: {},
    setup_commands: [],
    setup_timeout_seconds: 600,
    version: 0,
  };
}

const BOARD_ENV = env([
  { resource_id: 'board-resource', url: 'https://github.com/acme/board-repo.git', target_dir: 'repos/board-repo', branch: 'main', post_clone_commands: [] },
]);

test('ticket repo wins over the board environment (ticket > board priority)', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, 'feature/x', BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'ticket-resource', url: 'https://github.com/acme/ticket-repo.git', branch: 'feature/x' });
});

test('ticket repo with no explicit branch falls back to the ticket repo\'s OWN default_branch (not the board env repo\'s)', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, '', BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'ticket-resource', url: 'https://github.com/acme/ticket-repo.git', branch: 'develop' });
});

test('ticket repo with whitespace-only branch is treated as empty and falls back to the repo default_branch', () => {
  const picked = resolveBootstrapRepository(TICKET_REPO, '   ', BOARD_ENV);
  assert.equal(picked.branch, 'develop');
});

test('empty ticket repo (base_repo: null) falls back to the board environment\'s first repository', () => {
  const picked = resolveBootstrapRepository(null, null, BOARD_ENV);
  assert.deepEqual(picked, { resourceId: 'board-resource', url: 'https://github.com/acme/board-repo.git', branch: 'main' });
});

test('ticket repo object present but url is empty/whitespace is treated as no ticket repo (falls to board env)', () => {
  // Defensive: a malformed/partial ticket.base_repo (id set, url blank) must
  // never "win" with an empty url — that would hand WorktreeManager a
  // resourceId with nothing to clone.
  for (const badUrl of ['', '   ', undefined, null]) {
    const picked = resolveBootstrapRepository({ id: 'ticket-resource', url: badUrl, default_branch: 'develop' }, '', BOARD_ENV);
    assert.equal(picked.resourceId, 'board-resource', `url=${JSON.stringify(badUrl)} must fall back to board env`);
  }
});

test('no ticket repo and no environment repositories → null (nothing to bootstrap)', () => {
  assert.equal(resolveBootstrapRepository(null, null, null), null);
  assert.equal(resolveBootstrapRepository(null, null, env([])), null);
});

test('baseRepo of the wrong shape (string / number / array) is treated as absent, not thrown on', () => {
  for (const bad of ['not-an-object', 42, ['a', 'b']]) {
    assert.equal(resolveBootstrapRepository(bad, null, null), null);
    assert.deepEqual(resolveBootstrapRepository(bad, null, BOARD_ENV), {
      resourceId: 'board-resource', url: 'https://github.com/acme/board-repo.git', branch: 'main',
    });
  }
});

test('multiple environment repositories → deterministically takes [0], never a later entry', () => {
  // ticket 112ea3c5 root-cause guard: only ONE managed default per board is
  // ever intended (the write path caps environment_config.repositories at 1
  // — apps/server/src/common/environment-config.ts EnvironmentConfigInputSchema),
  // but the READ path stays permissive for legacy multi-entry rows. If this
  // function ever iterated instead of pinning [0], a stale second entry could
  // silently redirect every ticket that inherits the board default.
  const multi = env([
    { resource_id: 'first-resource', url: 'https://github.com/acme/first.git', target_dir: 'repos/first', branch: 'main', post_clone_commands: [] },
    { resource_id: 'second-resource', url: 'https://github.com/acme/second.git', target_dir: 'repos/second', branch: 'main', post_clone_commands: [] },
  ]);
  const picked = resolveBootstrapRepository(null, null, multi);
  assert.equal(picked.resourceId, 'first-resource');
  assert.notEqual(picked.resourceId, 'second-resource');
});

test('board env repository with no resource_id still resolves (agent-manager is permissive; the server-side pend guard is the strict gate)', () => {
  // Deliberate asymmetry with the server's pickBaseRepoResourceId (which
  // skips a url-only env entry because it can't resolve a push credential
  // without a resource_id — see base-repo-binding.test.mjs "url-only
  // environment repos... are NOT a valid fallback"). agent-manager can still
  // check the url out for read-only-role dispatches; this test pins that the
  // asymmetry is exactly this one field, not a wider drift.
  const urlOnly = env([{ resource_id: '', url: 'https://github.com/acme/url-only.git', target_dir: 'repos/url-only', branch: '', post_clone_commands: [] }]);
  const picked = resolveBootstrapRepository(null, null, urlOnly);
  assert.deepEqual(picked, { resourceId: '', url: 'https://github.com/acme/url-only.git', branch: '' });
});
