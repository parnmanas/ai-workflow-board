import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionWorkspaces, sessionWorkflowInstruction } from '../dist/lib/session-workspace.js';
import { sessionLaunchOptions, validateSessionLaunchOptions } from '../dist/lib/session-launch-options.js';

const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
async function fixture(t, base = 'main') {
  const root = await mkdtemp(join(tmpdir(), 'awb-session-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo');
  await mkdir(repo);
  git(repo, 'init', '-b', base);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  await writeFile(join(repo, 'tracked'), 'initial');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'initial');
  return { repo, workspaces: new SessionWorkspaces(join(root, 'state')) };
}

test('CLI modules advertise permission descriptions before any ACP session exists', () => {
  assert.match(sessionLaunchOptions('codex')[0].options.at(-1).name, /dangerously-bypass/);
  assert.match(sessionLaunchOptions('claude')[0].options.at(-1).name, /dangerously-skip/);
  assert.throws(() => validateSessionLaunchOptions('codex', { __permission_mode: 'bypassPermissions' }), /Unsupported/);
  assert.throws(() => validateSessionLaunchOptions('codex', { __git_workflow: 'shell arguments' }), /Unsupported/);
});

for (const base of ['main', 'master']) test(`default works on ${base} without creating branches or folders`, async t => {
  const { repo, workspaces } = await fixture(t, base);
  git(repo, 'switch', '-c', 'old-topic');
  const workspace = await workspaces.prepare('codex', '', repo);
  assert.equal(git(repo, 'branch', '--show-current'), base);
  assert.equal(workspace.cwd, repo);
  assert.equal(workspace.root, undefined);
  assert.equal(git(repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm).length, 1);
  assert.match(sessionWorkflowInstruction(workspace), /Do not create a branch/);
  await assert.rejects(access(join(repo, '.awb')));
});

test('default refuses to switch a dirty topic branch and preserves all files', async t => {
  const { repo, workspaces } = await fixture(t);
  git(repo, 'switch', '-c', 'unfinished');
  await writeFile(join(repo, 'untracked'), 'keep me');
  await assert.rejects(workspaces.prepare('claude', '', repo), /local changes/);
  assert.equal(git(repo, 'branch', '--show-current'), 'unfinished');
  await access(join(repo, 'untracked'));
});

test('managed worktree survives resume and unmerged/dirty close; merged close removes only owned work', async t => {
  const { repo, workspaces } = await fixture(t);
  const workspace = await workspaces.prepare('codex', '', repo, 'pr');
  assert.equal(git(repo, 'status', '--porcelain'), '', 'managed paths are excluded in the main clone');
  assert.equal(git(repo, 'branch', '--show-current'), 'main');
  await workspaces.save('codex', 'native-id', workspace);
  assert.deepEqual(await workspaces.prepare('codex', 'native-id', '/stale/path', 'main'), workspace);
  await writeFile(join(workspace.cwd, 'feature'), 'new work');
  assert.match(await workspaces.cleanup(workspace), /uncommitted/);
  git(workspace.cwd, 'add', 'feature'); git(workspace.cwd, 'commit', '-m', 'feature');
  assert.match(await workspaces.cleanup(workspace), /could not be verified/);
  git(repo, 'merge', '--ff-only', workspace.branch);
  assert.match(await workspaces.cleanup(workspace), /removed/);
  await assert.rejects(access(workspace.root));
  assert.throws(() => git(repo, 'show-ref', '--verify', `refs/heads/${workspace.branch}`));
  await workspaces.save('codex', 'native-id', workspace);
  await assert.rejects(workspaces.prepare('codex', 'native-id', repo), /Start a new session/);
  await access(join(repo, 'feature'));
});

test('squash merged worktree can be cleaned only when the base tree matches', async t => {
  const { repo, workspaces } = await fixture(t);
  const workspace = await workspaces.prepare('claude', '', repo, 'worktree');
  await writeFile(join(workspace.cwd, 'feature'), 'squashed work');
  git(workspace.cwd, 'add', 'feature'); git(workspace.cwd, 'commit', '-m', 'feature');
  git(repo, 'merge', '--squash', workspace.branch); git(repo, 'commit', '-m', 'squash');
  assert.match(await workspaces.cleanup(workspace), /removed/);
});

test('native sessions keep their working directory and unrelated branches are never cleaned', async t => {
  const { repo, workspaces } = await fixture(t);
  git(repo, 'switch', '-c', 'existing');
  assert.equal(await workspaces.prepare('codex', 'native-id', repo, 'main'), null);
  assert.equal(git(repo, 'branch', '--show-current'), 'existing');
  const workspace = await workspaces.prepare('codex', '', repo, 'worktree');
  git(workspace.cwd, 'switch', '-c', 'user-branch');
  assert.match(await workspaces.cleanup(workspace), /branch has changed/);
  await access(workspace.root);
});
