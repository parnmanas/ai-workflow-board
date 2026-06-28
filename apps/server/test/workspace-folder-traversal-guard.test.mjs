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

test('resolveWorkspaceFolder: a pure-traversal folder falls back to the deterministic default', () => {
  // '..' normalizes to '' → resolver uses the <kind>/<id> default, never an escape.
  assert.equal(resolveWorkspaceFolder('../../..', 'qa', 'sc-9'), 'qa/sc-9');
  assert.equal(resolveWorkspaceFolder('builds/x', 'security', 'p-1'), 'builds/x');
});
