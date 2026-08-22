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

const { normalizeWorkspaceFolder, resolveWorkspaceFolder, runWorkspaceRootForKind } = await import(
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

// ── 티켓 9fd27487: 티켓이 아닌 실행 경로 (Action Run / 채팅방) ──────────────────

test('runWorkspaceRootForKind: qa/security는 .awb/qa를 공유하고, action/chat/orchestration은 각자 자기 루트를 갖는다', () => {
  assert.equal(runWorkspaceRootForKind('qa'), '.awb/qa');
  assert.equal(runWorkspaceRootForKind('security'), '.awb/qa');
  assert.equal(runWorkspaceRootForKind('action'), '.awb/act');
  assert.equal(runWorkspaceRootForKind('chat'), '.awb/chat');
  assert.equal(runWorkspaceRootForKind('orchestration'), '.awb/orch');
});

// ── 티켓 2dc3c62f: Mission 실행 계약 — orchestration step 작업공간 ──────────────

test('resolveWorkspaceFolder: orchestration step은 .awb/orch/ 아래 mission-keyed이고, traversal로 그 밖을 벗어날 수 없다', () => {
  assert.equal(resolveWorkspaceFolder('', 'orchestration', 'mission-id-1234'), '.awb/orch/mission-');
  assert.equal(resolveWorkspaceFolder(null, 'orchestration', 'abcdef1234567890'), '.awb/orch/abcdef12');
  // runner는 이미 조합된 leaf(mission8/step_key 또는
  // mission.workspace_folder/step_key)를 explicit folder로 넘겨서 step을
  // mission leaf 아래 중첩시킨다 — traversal 세그먼트는 동일하게 제거된다.
  assert.equal(resolveWorkspaceFolder('mission-i/../../etc/step', 'orchestration', 'x'), '.awb/orch/mission-i/etc/step');
  assert.equal(resolveWorkspaceFolder('../../../etc/passwd', 'orchestration', 'm-1'), '.awb/orch/etc/passwd');
});

test('resolveWorkspaceFolder: action Runs are action-keyed under .awb/act/ (not run-keyed — every Run of the same Action reuses one folder)', () => {
  assert.equal(resolveWorkspaceFolder('', 'action', 'action-id-1234'), '.awb/act/action-i');
  assert.equal(resolveWorkspaceFolder(null, 'action', 'abcdef1234567890'), '.awb/act/abcdef12');
  // workspace_folder를 명시적으로 지정해도 여전히 .awb/act/ 아래에 중첩되며, traversal은 제거된다.
  assert.equal(resolveWorkspaceFolder('deploy-scripts', 'action', 'a-1'), '.awb/act/deploy-scripts');
  assert.equal(resolveWorkspaceFolder('../../etc/passwd', 'action', 'a-1'), '.awb/act/etc/passwd');
});

test('resolveWorkspaceFolder: chat rooms are room-keyed under .awb/chat/', () => {
  assert.equal(resolveWorkspaceFolder('', 'chat', 'room-id-56789'), '.awb/chat/room-id-');
  assert.equal(resolveWorkspaceFolder(null, 'chat', 'abcdef1234567890'), '.awb/chat/abcdef12');
});
