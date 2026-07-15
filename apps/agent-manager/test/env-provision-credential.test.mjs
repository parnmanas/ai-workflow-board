// env-provision credential injection (ticket 6c107743).
//
// environment-provisioner.ts cloned `repo.url` PLAINLY — a private repo in a
// board's environment_config.repositories then failed the pre-dispatch clone
// with `could not read Username for 'https://github.com'`, blocking every
// ticket on the board before the agent started. The fix resolves the repository
// Resource credential at clone time (same token endpoint the per-ticket
// worktree clone uses) and injects `x-access-token:<token>@` into BOTH the
// fresh-clone and the existing-clone fetch/pull path, keeping the token out of
// the SSE payload / fingerprint / marker / step log.
//
// These tests are HERMETIC: a fake `git` shim on PATH records its argv and
// emulates just enough of clone/rev-parse for the provisioner's control flow,
// so we can assert the token actually reaches the clone argv (the exact line
// that was missing) without any network or real private repo. The provisioner
// reads MANAGED_AGENTS_DIR from AWB_AGENT_MANAGER_HOME at module load, so it is
// dynamic-imported AFTER pointing that env at a temp dir.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'awb-envcred-'));
process.env.AWB_AGENT_MANAGER_HOME = HOME;

// --- fake git shim -----------------------------------------------------------
// A tiny `git` that records every invocation's argv to FAKE_GIT_LOG and, for
// `clone`, creates <dest>/.git so a later pathExists(gitDir) sees the clone.
// `rev-parse --absolute-git-dir` prints <dir>/.git; every other subcommand
// (remote set-url / config / fetch / checkout / pull) succeeds silently.
const SHIM_DIR = join(HOME, 'shim');
mkdirSync(SHIM_DIR, { recursive: true });
const GIT_SHIM = `#!/usr/bin/env node
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
const argv = process.argv.slice(2);
const logFile = process.env.FAKE_GIT_LOG;
if (logFile) appendFileSync(logFile, argv.join(' ') + '\\n');
const valAfter = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined; };
try {
  if (argv[0] === 'clone') {
    mkdirSync(join(argv[argv.length - 1], '.git'), { recursive: true });
    process.exit(0);
  }
  const cmd = argv[0] === '-C' ? argv[2] : argv[0];
  if (cmd === 'rev-parse' && argv.includes('--absolute-git-dir')) {
    process.stdout.write(join(valAfter('-C'), '.git'));
    process.exit(0);
  }
  process.exit(0); // remote set-url / config / fetch / checkout / pull
} catch (e) {
  process.stderr.write(String((e && e.message) || e));
  process.exit(1);
}
`;
const shimPath = join(SHIM_DIR, 'git');
writeFileSync(shimPath, GIT_SHIM, { mode: 0o755 });

let gitLogSeq = 0;
/** Run `body` with the fake git first on PATH and a fresh FAKE_GIT_LOG; returns
 *  the recorded git argv lines. PATH/env are restored afterwards. */
async function withFakeGit(body) {
  const logFile = join(HOME, `gitlog-${gitLogSeq++}.txt`);
  writeFileSync(logFile, '');
  const savedPath = process.env.PATH;
  const savedLog = process.env.FAKE_GIT_LOG;
  process.env.PATH = `${SHIM_DIR}:${savedPath}`;
  process.env.FAKE_GIT_LOG = logFile;
  try {
    await body();
  } finally {
    process.env.PATH = savedPath;
    if (savedLog === undefined) delete process.env.FAKE_GIT_LOG;
    else process.env.FAKE_GIT_LOG = savedLog;
  }
  return readFileSync(logFile, 'utf8').split('\n').filter(Boolean);
}

const { EnvironmentProvisioner, authenticatedUrl, redactToken } = await import(
  '../dist/lib/environment-provisioner.js'
);

const PRIVATE_URL = 'https://github.com/parnmanas/txiv.gameclient.git';
const RESOURCE_ID = '3d905c97-f4c0-4c0c-840a-13082b18e4ca';
const TOKEN = 'ghs_TESTtokenSHOULDneverLEAK123';

function baseConfig(overrides = {}) {
  return {
    repositories: [
      { resource_id: RESOURCE_ID, url: PRIVATE_URL, target_dir: 'repos/gameclient', branch: '', post_clone_commands: [] },
    ],
    env_vars: {},
    setup_commands: [],
    setup_timeout_seconds: 30,
    version: 0,
    ...overrides,
  };
}

// --- pure helpers ------------------------------------------------------------

test('authenticatedUrl: injects x-access-token userinfo for https, no-op otherwise', () => {
  assert.equal(
    authenticatedUrl(PRIVATE_URL, { token: TOKEN }),
    `https://x-access-token:${TOKEN}@github.com/parnmanas/txiv.gameclient.git`,
  );
  // custom username honoured
  assert.equal(
    authenticatedUrl('https://example.test/r.git', { username: 'bot', token: 't' }),
    'https://bot:t@example.test/r.git',
  );
  // public repo (no token) → unchanged
  assert.equal(authenticatedUrl(PRIVATE_URL, null), PRIVATE_URL);
  assert.equal(authenticatedUrl(PRIVATE_URL, { token: '' }), PRIVATE_URL);
  // non-http(s) url (ssh/git/file) → userinfo meaningless → unchanged
  assert.equal(authenticatedUrl('git@github.com:o/r.git', { token: TOKEN }), 'git@github.com:o/r.git');
  assert.equal(authenticatedUrl('/local/path/r', { token: TOKEN }), '/local/path/r');
});

test('redactToken: masks every occurrence, no-op without a token', () => {
  const withTok = `clone https://x-access-token:${TOKEN}@github.com/o/r.git failed; retry ${TOKEN}`;
  const red = redactToken(withTok, TOKEN);
  assert.ok(!red.includes(TOKEN), 'token fully masked');
  assert.equal((red.match(/\*\*\*/g) || []).length, 2, 'both occurrences masked');
  assert.equal(redactToken('plain text', undefined), 'plain text');
});

// --- fresh clone of a private repo ------------------------------------------

test('provision: fresh private clone injects the token, scrubs origin, installs a 0600 cred store, leaks nothing', async () => {
  const prov = new EnvironmentProvisioner();
  const agentId = 'agent-fresh01';
  const calls = [];
  const resolveCredential = async (resourceId, credAgentId) => {
    calls.push([resourceId, credAgentId]);
    return { username: 'x-access-token', token: TOKEN };
  };

  let result;
  const gitLog = await withFakeGit(async () => {
    result = await prov.provision({ agentId, config: baseConfig(), ticketId: 't-fresh', resolveCredential });
  });

  assert.equal(result.ok, true, 'provision succeeded');
  assert.deepEqual(calls, [[RESOURCE_ID, agentId]], 'resolver called once with (resource_id, agentId)');

  // The clone argv actually carried the authenticated URL — the exact wiring the
  // bug was missing.
  const cloneLine = gitLog.find((l) => l.startsWith('clone'));
  assert.ok(cloneLine, 'a git clone ran');
  assert.ok(cloneLine.includes(`x-access-token:${TOKEN}@github.com`), 'clone URL carries the token');

  // origin scrubbed back to the clean URL; credential helper configured.
  const setUrl = gitLog.find((l) => l.includes('remote set-url origin'));
  assert.ok(setUrl, 'origin was reset');
  assert.ok(setUrl.includes(PRIVATE_URL) && !setUrl.includes(TOKEN), 'origin reset to the CLEAN url');
  assert.ok(gitLog.some((l) => l.includes('config credential.helper') && l.includes('awb-credentials')), 'cred helper configured');

  // The persisted credential store holds the token, 0600, inside the clone .git.
  const credFile = join(HOME, 'agents', agentId, 'repos/gameclient', '.git', 'awb-credentials');
  assert.ok(existsSync(credFile), 'credential store written');
  const credBody = readFileSync(credFile, 'utf8');
  assert.ok(credBody.includes(`x-access-token:${TOKEN}@github.com`), 'cred store carries the token');
  assert.equal(statSync(credFile).mode & 0o777, 0o600, 'credential store is 0600');

  // The token must NOT appear in the human-visible steps nor the on-disk marker.
  assert.ok(result.steps.length > 0, 'steps recorded');
  assert.ok(!JSON.stringify(result.steps).includes(TOKEN), 'token absent from steps');
  const cloneStep = result.steps.find((s) => s.startsWith('clone '));
  assert.ok(cloneStep.includes(PRIVATE_URL), 'clone step shows the clean url');
  const markerFile = join(HOME, 'agents', agentId, 'env', `${result.fingerprint}.json`);
  assert.ok(!readFileSync(markerFile, 'utf8').includes(TOKEN), 'token absent from success marker');
});

// --- existing clone (fetch/pull path) ---------------------------------------

test('provision: existing private clone installs the cred store before fetch/pull', async () => {
  const prov = new EnvironmentProvisioner();
  const agentId = 'agent-exist01';
  // Pre-create a clone dir with a .git so the existing-clone branch is taken.
  const dest = join(HOME, 'agents', agentId, 'repos/gameclient');
  mkdirSync(join(dest, '.git'), { recursive: true });

  const calls = [];
  const resolveCredential = async (resourceId, credAgentId) => {
    calls.push([resourceId, credAgentId]);
    return { token: TOKEN };
  };

  let result;
  const gitLog = await withFakeGit(async () => {
    result = await prov.provision({
      agentId,
      config: baseConfig({ version: 1 }),
      ticketId: 't-exist',
      resolveCredential,
    });
  });

  assert.equal(result.ok, true, 'provision succeeded');
  assert.deepEqual(calls, [[RESOURCE_ID, agentId]], 'resolver called for the existing-clone path too');
  assert.ok(gitLog.some((l) => l.includes('fetch --all --prune')), 'fetch ran (existing-clone branch)');
  assert.ok(!gitLog.some((l) => l.startsWith('clone')), 'no fresh clone — existing clone reused');
  // Credential helper installed BEFORE fetch so a private fetch/pull authenticates.
  assert.ok(existsSync(join(dest, '.git', 'awb-credentials')), 'cred store written for existing clone');
  assert.ok(!JSON.stringify(result.steps).includes(TOKEN), 'token absent from steps');
});

// --- public repo regression --------------------------------------------------

test('provision: public repo (resolver → null) clones plainly, no token machinery', async () => {
  const prov = new EnvironmentProvisioner();
  const agentId = 'agent-public1';
  let called = 0;
  const resolveCredential = async () => {
    called++;
    return null; // public repo / no credential
  };

  let result;
  const gitLog = await withFakeGit(async () => {
    result = await prov.provision({ agentId, config: baseConfig(), ticketId: 't-pub', resolveCredential });
  });

  assert.equal(result.ok, true);
  assert.equal(called, 1, 'resolver consulted (repo has a resource_id)');
  const cloneLine = gitLog.find((l) => l.startsWith('clone'));
  assert.ok(cloneLine.includes(PRIVATE_URL) && !cloneLine.includes('x-access-token'), 'clone uses the plain url');
  assert.ok(!gitLog.some((l) => l.includes('remote set-url origin')), 'no origin scrub when there is no token');
  assert.ok(!existsSync(join(HOME, 'agents', agentId, 'repos/gameclient', '.git', 'awb-credentials')), 'no cred store for a public repo');
});

// A url-only repo (no resource_id) must not even consult the resolver.
test('provision: url-only repo never calls the credential resolver', async () => {
  const prov = new EnvironmentProvisioner();
  const agentId = 'agent-urlonly';
  let called = 0;
  const resolveCredential = async () => { called++; return { token: TOKEN }; };
  const config = baseConfig({
    repositories: [{ resource_id: '', url: PRIVATE_URL, target_dir: 'repos/gameclient', branch: '', post_clone_commands: [] }],
  });

  let result;
  await withFakeGit(async () => {
    result = await prov.provision({ agentId, config, ticketId: 't-urlonly', resolveCredential });
  });
  assert.equal(result.ok, true);
  assert.equal(called, 0, 'no resource_id → resolver not consulted');
});
