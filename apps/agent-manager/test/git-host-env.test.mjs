// Exposed git hosts (Credential provider `git_http`, e.g. a self-hosted LFS
// store) become command-scope git config in env. Pinned against REAL git:
//   - the injected helper answers for that host, and the reset entry beats a
//     helper the host already had for it (a stale `store`, Windows GCM…)
//   - other hosts are untouched
//   - indexes start after any GIT_CONFIG_* already in the inherited env
//   - provisioning git sees the hosts only inside withGitHostEnv(), per scope
//   - the spawn env from agentCredentialEnvFor() carries the same config

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, afterEach } from 'node:test';

import { gitCredentialEnv, gitProcessEnv, withGitHostEnv } from '../dist/lib/git-host-env.js';
import { agentCredentialEnvFor, agentGitEnvFor, setAgentEnvFetcherForTests } from '../dist/lib/agent-env-credentials.js';

const home = mkdtempSync(join(tmpdir(), 'awb-git-host-env-'));
after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => setAgentEnvFetcherForTests(null));

// An isolated HOME whose own config already has a (wrong) stored credential
// for the same host — the case the reset entry exists for.
const stored = join(home, 'stored-credentials');
writeFileSync(stored, 'https://stale-user:stale-token@lfs.example.test\n');
writeFileSync(join(home, '.gitconfig'), `[credential]\n\thelper = store --file=${stored.replace(/\\/g, '/')}\n`);
const isolated = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(home, 'xdg'),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
};
delete isolated.GIT_CONFIG_COUNT;

function fill(host, env) {
  const r = spawnSync('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host}\n\n`,
    env,
    encoding: 'utf8',
    timeout: 15_000,
  });
  const out = Object.fromEntries(
    String(r.stdout || '').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, ...out };
}

const LFS = { url: 'https://lfs.example.test/txiv/emberdelve.git/info/lfs', username: 'parnmanas', password: 'fresh-token' };

test('baseline: without the env the host answers with its stale stored credential', () => {
  const r = fill('lfs.example.test', isolated);
  assert.equal(r.password, 'stale-token');
});

test('the injected helper answers for that host and overrides the existing helper', () => {
  const r = fill('lfs.example.test', { ...isolated, ...gitCredentialEnv([LFS], isolated) });
  assert.equal(r.username, 'parnmanas');
  assert.equal(r.password, 'fresh-token');
});

test('other hosts are untouched', () => {
  const r = fill('other.example.test', { ...isolated, ...gitCredentialEnv([LFS], isolated) });
  assert.notEqual(r.password, 'fresh-token');
});

test('indexes continue after inherited GIT_CONFIG_* entries; secrets stay out of the helper text', () => {
  const env = gitCredentialEnv([LFS], { GIT_CONFIG_COUNT: '2' });
  assert.equal(env.GIT_CONFIG_COUNT, '4');
  assert.equal(env.GIT_CONFIG_KEY_2, 'credential.https://lfs.example.test.helper');
  assert.equal(env.GIT_CONFIG_VALUE_2, '');
  assert.equal(env.GIT_CONFIG_KEY_3, 'credential.https://lfs.example.test.helper');
  assert.ok(!env.GIT_CONFIG_VALUE_3.includes('fresh-token'));
  assert.deepEqual(gitCredentialEnv([{ url: 'not a url', username: 'u', password: 'p' }]), {});
});

test('provisioning git sees git hosts only inside its own scope', async () => {
  assert.equal(gitProcessEnv(), undefined);
  const a = withGitHostEnv({ GIT_CONFIG_COUNT: '1', X: 'a' }, async () => {
    await new Promise((r) => setTimeout(r, 20));
    return gitProcessEnv()?.X;
  });
  const b = withGitHostEnv({ GIT_CONFIG_COUNT: '1', X: 'b' }, async () => gitProcessEnv()?.X);
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.equal(gitProcessEnv(), undefined);
  assert.equal(gitProcessEnv({ GIT_TERMINAL_PROMPT: '0' })?.GIT_TERMINAL_PROMPT, '0');
});

test('spawn env and provisioning env both carry the git host from the agent-env response', async () => {
  let calls = 0;
  setAgentEnvFetcherForTests(async () => {
    calls += 1;
    return { env: { FORGEJO_TOKEN: 't' }, git_credentials: [LFS], skipped: [] };
  });
  const config = { url: 'http://127.0.0.1:0', apiKey: 'k' };
  const spawnEnv = await agentCredentialEnvFor(config, 'acc-1', [], '[t]');
  assert.equal(spawnEnv.FORGEJO_TOKEN, 't');
  assert.ok(Object.values(spawnEnv).includes('credential.https://lfs.example.test.helper'));
  const gitEnv = await agentGitEnvFor(config, 'acc-1', '[t]');
  assert.ok(gitEnv.GIT_CONFIG_COUNT);
  assert.equal(gitEnv.FORGEJO_TOKEN, undefined, 'provisioning gets git config only');
  assert.equal(calls, 1, 'one dispatch reads the account once (short cache)');
});
