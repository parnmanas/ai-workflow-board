// Unit test — `normalizeWorkspaceFolder` path-traversal guard (ticket 25db3cc6).
// This is the server-side source of truth for a QA/security scenario's
// `workspace_folder`. The agent-manager run provisioner (ticket 4) runs
// `rm -rf` on the resolved folder for a `fresh` checkout, so a `../` segment in
// a mis-typed scenario/profile config could wipe a directory OUTSIDE the agent
// home. The guard drops every '.'/'..'/empty segment so the value can never
// climb out of the home root. The provisioner re-asserts containment as
// defense-in-depth; this locks the normalize contract at the write surface.

import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { normalizeWorkspaceFolder, resolveWorkspaceFolder } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'workspace-folder-options.js')
);

test('normalizeWorkspaceFolder: clean relative paths pass through', () => {
  assert.equal(normalizeWorkspaceFolder('qa/scenario-1'), 'qa/scenario-1');
  assert.equal(normalizeWorkspaceFolder('  builds/game  '), 'builds/game');
  assert.equal(normalizeWorkspaceFolder('a\\b\\c'), 'a/b/c'); // backslashes normalized
  assert.equal(normalizeWorkspaceFolder(null), '');
  assert.equal(normalizeWorkspaceFolder(undefined), '');
});

test('normalizeWorkspaceFolder: strips leading slashes (never absolute)', () => {
  assert.equal(normalizeWorkspaceFolder('/etc/passwd'), 'etc/passwd');
  assert.equal(normalizeWorkspaceFolder('///x/y'), 'x/y');
});

test('normalizeWorkspaceFolder: drops .. / . segments (no traversal escape)', () => {
  assert.equal(normalizeWorkspaceFolder('../../../tmp/victim'), 'tmp/victim');
  assert.equal(normalizeWorkspaceFolder('qa/../../../../root'), 'qa/root');
  assert.equal(normalizeWorkspaceFolder('./qa/./s'), 'qa/s');
  assert.equal(normalizeWorkspaceFolder('..'), '');
  assert.equal(normalizeWorkspaceFolder('../..'), '');
  assert.equal(normalizeWorkspaceFolder('..\\..\\win'), 'win');
});

test('resolveWorkspaceFolder: every folder is rooted under .awb/qa/ (worktree 규약 ③)', () => {
  // worktree 규약 ③: QA/security run folders live at `<working_dir>/.awb/qa/<leaf>`
  // (symmetric with the worktree `.awb/wt/` root). The default leaf is the
  // scenario/profile id's first 8 chars; an explicit workspace_folder becomes the
  // leaf but stays nested under .awb/qa/ (never escaping the .awb/ sandbox).

  // Unset / pure-traversal explicit → id-8 default leaf, under .awb/qa/.
  assert.equal(resolveWorkspaceFolder('../../..', 'qa', 'sc-9'), '.awb/qa/sc-9');
  assert.equal(resolveWorkspaceFolder('', 'qa', 'abcdef1234567890'), '.awb/qa/abcdef12'); // id truncated to 8
  assert.equal(resolveWorkspaceFolder(null, 'security', 'p1234567890'), '.awb/qa/p1234567'); // both kinds share .awb/qa/

  // Explicit folder → the leaf, still under .awb/qa/.
  assert.equal(resolveWorkspaceFolder('builds/x', 'security', 'p-1'), '.awb/qa/builds/x');
  // A traversal segment in an explicit folder is stripped, so it cannot climb
  // out of .awb/qa/ — the normalize guard + the fixed root both hold.
  assert.equal(resolveWorkspaceFolder('../../etc/passwd', 'qa', 'x'), '.awb/qa/etc/passwd');
});
