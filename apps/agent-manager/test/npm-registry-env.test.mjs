// npm registry tokens exposed to agent runs (Credential provider `npm`) are
// installed as one `npm_config_//<registry>/:_authToken` env var. Pinned
// against REAL npm: a stub registry answers `npm whoami` only for the right
// bearer token, with the user's own ~/.npmrc isolated away.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, afterEach } from 'node:test';

import { npmNerfDart, npmRegistryEnv } from '../dist/lib/npm-registry-env.js';
import { agentCredentialEnvFor, setAgentEnvFetcherForTests } from '../dist/lib/agent-env-credentials.js';

const home = mkdtempSync(join(tmpdir(), 'awb-npm-registry-env-'));
const userconfig = join(home, '.npmrc');
writeFileSync(userconfig, '');
after(() => rmSync(home, { recursive: true, force: true }));
afterEach(() => setAgentEnvFetcherForTests(null));

test('nerf dart keys a registry by host + slash-terminated path', () => {
  assert.equal(npmNerfDart('https://registry.npmjs.org/'), '//registry.npmjs.org/');
  assert.equal(npmNerfDart('https://npm.example.com/api/npm/repo'), '//npm.example.com/api/npm/repo/');
  assert.equal(npmNerfDart('http://127.0.0.1:4873/'), '//127.0.0.1:4873/');
  assert.equal(npmNerfDart('registry.npmjs.org'), null);
  assert.deepEqual(npmRegistryEnv([{ registry: 'https://registry.npmjs.org/', token: 'npm_x' }]), {
    'npm_config_//registry.npmjs.org/:_authToken': 'npm_x',
  });
});

function npmWhoami(registry, env) {
  return new Promise((resolve) => {
    const child = spawn('npm', ['whoami', '--registry', registry], {
      env,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out: out.trim() }));
  });
}

test('real npm authenticates to the registry from the env var alone', async () => {
  const server = createServer((req, res) => {
    const ok = req.url.endsWith('/-/whoami') && req.headers.authorization === 'Bearer good-token';
    res.statusCode = ok ? 200 : 401;
    res.setHeader('content-type', 'application/json');
    res.end(ok ? '{"username":"awb-agent"}' : '{"error":"unauthorized"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const registry = `http://127.0.0.1:${server.address().port}/`;
  const base = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    npm_config_userconfig: userconfig,
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
  };
  for (const k of Object.keys(base)) if (/^npm_config_\/\//i.test(k)) delete base[k];
  try {
    const without = await npmWhoami(registry, base);
    assert.notEqual(without.code, 0, 'baseline: no token, npm whoami fails');
    const withToken = await npmWhoami(registry, { ...base, ...npmRegistryEnv([{ registry, token: 'good-token' }]) });
    assert.equal(withToken.code, 0);
    assert.equal(withToken.out, 'awb-agent');
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('the spawn env carries the registry auth from the agent-env response', async () => {
  setAgentEnvFetcherForTests(async () => ({
    env: {},
    npm_registries: [{ registry: 'https://registry.npmjs.org/', token: 'npm_tok' }],
    skipped: [],
  }));
  const env = await agentCredentialEnvFor({ url: 'http://127.0.0.1:0', apiKey: 'k' }, 'acc-1', [], '[t]');
  assert.equal(env['npm_config_//registry.npmjs.org/:_authToken'], 'npm_tok');
});
