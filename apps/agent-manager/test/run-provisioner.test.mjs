// QA/security run-workspace provisioning (ticket 25db3cc6 4/5; rooting moved by
// worktree 규약 ③ ticket e8ee8ee6). Covers:
//   - parseRunProvision: defensive wire parse (valid / missing fields / bad repo)
//   - provisionRunWorkspace roots the run folder at the agent's WORKING_DIR
//     (규약 ③) — `<working_dir>/.awb/qa/<leaf>` — not the manager home
//   - reuse: first run clones, second run fetch+ff-pulls into the SAME folder
//     and picks up a new upstream commit
//   - fresh: wipes the folder and re-clones (a stray file is gone afterwards)
//   - no repo: just ensures the folder exists
//   - fallback: an empty baseWorkingDir falls back to AGENT_MANAGER_HOME
//   - path traversal: a ../ workspace_folder is rejected, never rm's outside root
//   - clone failure (bad url): ok=false with an error, no exception thrown
//
// The provisioner reads AGENT_MANAGER_HOME from AWB_AGENT_MANAGER_HOME at module
// load (only used as the fallback root now), so it is dynamic-imported AFTER
// pointing that env at a temp dir. `BASE` stands in for the agent's working_dir
// that the dispatcher passes in. A local bare repo stands in for the remote so
// no network is needed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'awb-runprov-home-'));
process.env.AWB_AGENT_MANAGER_HOME = HOME;
// The agent's working_dir the dispatcher passes as baseWorkingDir (규약 ③).
const BASE = mkdtempSync(join(tmpdir(), 'awb-runprov-base-'));

const { parseRunProvision, provisionRunWorkspace } = await import('../dist/lib/run-provisioner.js');

// ── Build a local bare "remote" with one commit, return its path + a push helper.
function git(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).toString();
}

function makeRemote() {
  const root = mkdtempSync(join(tmpdir(), 'awb-runprov-remote-'));
  const bare = join(root, 'origin.git');
  git(root, ['init', '--bare', '-b', 'main', bare]);
  // Seed via a working clone.
  const seed = join(root, 'seed');
  git(root, ['clone', bare, seed]);
  writeFileSync(join(seed, 'README.md'), 'v1\n');
  git(seed, ['add', '.']);
  git(seed, ['commit', '-m', 'v1']);
  git(seed, ['push', 'origin', 'main']);
  return {
    url: bare,
    seed,
    pushFile(name, content) {
      writeFileSync(join(seed, name), content);
      git(seed, ['add', '.']);
      git(seed, ['commit', '-m', `add ${name}`]);
      git(seed, ['push', 'origin', 'main']);
    },
  };
}

test('parseRunProvision: valid object, missing fields, and bad repo', () => {
  const ok = parseRunProvision({
    kind: 'qa',
    run_id: 'r1',
    workspace_id: 'w1',
    workspace_folder: '.awb/qa/s1',
    checkout_mode: 'reuse',
    repo: { url: 'https://x/r.git', branch: 'dev' },
  });
  assert.equal(ok.kind, 'qa');
  assert.equal(ok.workspace_folder, '.awb/qa/s1');
  assert.equal(ok.checkout_mode, 'reuse');
  assert.deepEqual(ok.repo, { url: 'https://x/r.git', branch: 'dev' });

  // Defaults + coercion: unknown checkout_mode → reuse; security kind kept.
  const sec = parseRunProvision({ kind: 'security', run_id: 'r', workspace_id: 'w', workspace_folder: 'f', checkout_mode: 'weird' });
  assert.equal(sec.kind, 'security');
  assert.equal(sec.checkout_mode, 'reuse');
  assert.equal(sec.repo, null);

  // Missing required fields / wrong type → null (ordinary chat turn).
  assert.equal(parseRunProvision(null), null);
  assert.equal(parseRunProvision({}), null);
  assert.equal(parseRunProvision({ kind: 'qa', run_id: 'r', workspace_id: 'w' }), null); // no folder
  assert.equal(parseRunProvision({ kind: 'bogus', run_id: 'r', workspace_id: 'w', workspace_folder: 'f' }), null);

  // repo without a usable url → repo null.
  const noUrl = parseRunProvision({ kind: 'qa', run_id: 'r', workspace_id: 'w', workspace_folder: 'f', repo: { branch: 'x' } });
  assert.equal(noUrl.repo, null);
});

test('reuse: rooted at working_dir; first clones, second fetch+ff-pulls the same folder', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'r1', workspace_id: 'w1', workspace_folder: '.awb/qa/reuse-s', checkout_mode: 'reuse', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);
  // 규약 ③: the run folder is rooted at the agent working_dir, NOT the manager home.
  assert.equal(first.dir, join(BASE, '.awb/qa/reuse-s'));
  assert.ok(!first.dir.startsWith(HOME), 'not rooted under the manager home');
  assert.ok(existsSync(join(first.dir, '.git')), 'cloned');
  assert.ok(first.steps.some((s) => s.startsWith('clone')), 'first run clones');
  assert.equal(readFileSync(join(first.dir, 'README.md'), 'utf8'), 'v1\n');

  // New upstream commit, then a second reuse run must pull it in (same folder).
  remote.pushFile('NEW.txt', 'hello\n');
  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true);
  assert.equal(second.dir, first.dir, 'same folder reused');
  assert.ok(second.steps.some((s) => s.startsWith('fetch')), 'second run fetches');
  assert.ok(second.steps.some((s) => s.startsWith('pull --ff-only')), 'second run ff-pulls');
  assert.ok(existsSync(join(second.dir, 'NEW.txt')), 'pulled the new upstream commit');
});

test('fresh: wipes the folder and re-clones (a stray file is gone)', async () => {
  const remote = makeRemote();
  const base = { kind: 'qa', run_id: 'r2', workspace_id: 'w1', workspace_folder: '.awb/qa/fresh-s', checkout_mode: 'fresh', repo: { url: remote.url } };

  const first = await provisionRunWorkspace(base, BASE);
  assert.equal(first.ok, true);
  // Drop a stray file the next fresh run must wipe.
  writeFileSync(join(first.dir, 'STRAY.txt'), 'x');
  assert.ok(existsSync(join(first.dir, 'STRAY.txt')));

  const second = await provisionRunWorkspace(base, BASE);
  assert.equal(second.ok, true);
  assert.ok(second.steps.some((s) => s.startsWith('wipe')), 'fresh wipes first');
  assert.ok(second.steps.some((s) => s.startsWith('clone')), 'fresh re-clones');
  assert.ok(!existsSync(join(second.dir, 'STRAY.txt')), 'stray file gone after wipe');
  assert.ok(existsSync(join(second.dir, '.git')), 're-cloned');
});

test('no repo: ensures the folder exists without cloning', async () => {
  const r = await provisionRunWorkspace({ kind: 'security', run_id: 'r3', workspace_id: 'w1', workspace_folder: '.awb/qa/p1', checkout_mode: 'reuse', repo: null }, BASE);
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(BASE, '.awb/qa/p1'), 'rooted at working_dir');
  assert.ok(existsSync(r.dir), 'folder created');
  assert.ok(!existsSync(join(r.dir, '.git')), 'nothing cloned');
  assert.ok(r.steps.some((s) => s.includes('no repo to clone')));
});

test('fallback: an empty baseWorkingDir roots at AGENT_MANAGER_HOME (degenerate dispatch)', async () => {
  const r = await provisionRunWorkspace({ kind: 'qa', run_id: 'r6', workspace_id: 'w1', workspace_folder: '.awb/qa/fallback-s', checkout_mode: 'reuse', repo: null }, '');
  assert.equal(r.ok, true);
  assert.equal(r.dir, join(HOME, '.awb/qa/fallback-s'), 'falls back to the manager home when no working_dir');
  assert.ok(existsSync(r.dir), 'folder created');
});

test('path traversal: a ../ workspace_folder is rejected and does NOT rm outside the working_dir', async () => {
  // Stand up a victim dir OUTSIDE the working_dir; a fresh checkout (rm -rf) must
  // never wipe it. The workspace_folder climbs out of BASE via ../ then targets
  // the victim — enough `..` to escape any depth of BASE under /tmp.
  const victimRoot = mkdtempSync(join(tmpdir(), 'awb-runprov-victim-'));
  const victim = join(victimRoot, 'precious');
  writeFileSync(victim, 'do not delete\n');
  assert.ok(existsSync(victim));

  const r = await provisionRunWorkspace({
    kind: 'qa',
    run_id: 'r5',
    workspace_id: 'w1',
    workspace_folder: `../../../../../../../../../..${victimRoot}`,
    checkout_mode: 'fresh',
    repo: null,
  }, BASE);
  assert.equal(r.ok, false, 'traversal rejected');
  assert.ok(/traversal/i.test(r.error || ''), 'error names the traversal');
  assert.ok(existsSync(victim), 'victim file untouched — no rm outside the working_dir');
});

test('clone failure (bad url): ok=false with an error, no throw', async () => {
  const r = await provisionRunWorkspace({
    kind: 'qa',
    run_id: 'r4',
    workspace_id: 'w1',
    workspace_folder: '.awb/qa/badurl-s',
    checkout_mode: 'reuse',
    repo: { url: join(tmpdir(), 'definitely-not-a-repo-xyz.git') },
  }, BASE);
  assert.equal(r.ok, false);
  assert.ok(r.error && r.error.length > 0, 'error captured');
  assert.ok(r.steps.some((s) => s.includes('FAIL')), 'failure recorded in steps');
});
