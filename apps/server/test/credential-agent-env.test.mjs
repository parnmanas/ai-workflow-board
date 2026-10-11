// Credentials exposed to agent runs as env vars (Credential.agent_env).
//
// A Google OAuth client needs two secrets at once (client_id + client_secret,
// usually a refresh_token too) and the agent has to see them as process env.
// Pinned here:
//   - the field → env name rule (`GOOGLE` + `client_id` → GOOGLE_CLIENT_ID)
//   - write-time refusals: CLI login providers, AWB / CLI auth names, two
//     fields collapsing onto one name — each with a reason, never a silent drop
//   - account credentials shadow global ones for the same name; same-scope
//     collisions are reported in `skipped`
//   - the manager-facing route: Host key required, a runtime key only gets its
//     own account, values come back decrypted and only for opted-in rows
//   - PATCH remove_fields deletes a Custom key (blank still means "keep")

import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it, test } from 'node:test';
import { DataSource } from 'typeorm';

import {
  agentEnvName,
  npmRegistryUrl,
  resolveAgentEnv,
  validateAgentEnvConfig,
} from '../dist/common/credential-agent-env.js';
import { Credential } from '../dist/entities/Credential.js';
import { Resource } from '../dist/entities/Resource.js';
import { Project } from '../dist/entities/Project.js';
import { AgentSessionExecution } from '../dist/entities/AgentSessionExecution.js';
import { AgentSessionCliSetting } from '../dist/entities/AgentSessionCliSetting.js';
import { OutreachChannel } from '../dist/entities/OutreachChannel.js';
import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';
import { CredentialsAgentEnvController } from '../dist/modules/credentials/credentials-agent-env.controller.js';

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'credential-agent-env-test-key';

test('field names become <PREFIX>_<FIELD>, upper-cased', () => {
  assert.equal(agentEnvName('GOOGLE', 'client_id'), 'GOOGLE_CLIENT_ID');
  assert.equal(agentEnvName('GOOGLE', 'refresh_token'), 'GOOGLE_REFRESH_TOKEN');
  assert.equal(agentEnvName('', 'REDDIT_CLIENT_ID'), 'REDDIT_CLIENT_ID');
  assert.equal(agentEnvName('X', 'client-id'), 'X_CLIENT_ID');
});

test('write-time validation refuses what would break or hijack a run', () => {
  const google = { client_id: 'i', client_secret: 's', refresh_token: 'r' };
  assert.equal(validateAgentEnvConfig('google_oauth', 'GOOGLE', google), null);
  assert.match(validateAgentEnvConfig('claude_api_key', 'X', { api_key: 'k' }), /CLI logins/);
  assert.match(validateAgentEnvConfig('custom', '', { ANTHROPIC_BASE_URL: 'u' }), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', { AWB_API_KEY: 'k' }), /reserved/);
  assert.match(validateAgentEnvConfig('openai', 'OPENAI', { api_key: 'k' }), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', { PATH: 'p' }), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', { USERNAME: 'u' }), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', { GIT_CONFIG_COUNT: '1' }), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '1BAD', { token: 't' }), /prefix/);
  assert.match(validateAgentEnvConfig('custom', 'X', { 'client-id': 'a', client_id: 'b' }), /both become X_CLIENT_ID/);
  assert.match(validateAgentEnvConfig('custom', 'X', {}), /no fields/);
});

test('a git host needs a real URL plus username and token; env vars only with a prefix', () => {
  const lfs = { url: 'https://lfs.parnmanas.com', username: 'parnmanas', token: 't' };
  assert.equal(validateAgentEnvConfig('git_http', '', lfs), null, 'no prefix → git credential only, nothing to name-check');
  assert.equal(validateAgentEnvConfig('git_http', 'FORGEJO', lfs), null);
  assert.match(validateAgentEnvConfig('git_http', '', { ...lfs, url: 'lfs.parnmanas.com' }), /http\(s\) URL/);
  assert.match(validateAgentEnvConfig('git_http', '', { ...lfs, username: '' }), /username and token/);
  assert.match(validateAgentEnvConfig('git_http', '', { url: lfs.url, username: 'u' }), /username and token/);
});

test('an npm registry needs a token; registry defaults to the public one and is slash-terminated', () => {
  assert.equal(validateAgentEnvConfig('npm', '', { token: 'npm_x' }), null, 'no prefix → npm auth only');
  assert.equal(validateAgentEnvConfig('npm', 'NPM', { token: 'npm_x' }), null);
  assert.match(validateAgentEnvConfig('npm', '', { registry: 'https://registry.npmjs.org/' }), /no fields|needs a token/);
  assert.match(validateAgentEnvConfig('npm', '', { token: 't', registry: 'registry.npmjs.org' }), /http\(s\) URL/);
  assert.equal(npmRegistryUrl(''), 'https://registry.npmjs.org/');
  assert.equal(npmRegistryUrl('https://npm.pkg.github.com'), 'https://npm.pkg.github.com/');
  assert.equal(npmRegistryUrl('https://x.example/api/npm/repo?a=1'), 'https://x.example/api/npm/repo/');
});

test('npm registries resolve per registry; env vars only with a prefix', () => {
  const resolved = resolveAgentEnv([
    { id: 'n', name: 'npm publish', provider: 'npm', account_id: null, env_prefix: '', fields: { token: 'npm_global' } },
    { id: 'p', name: 'npm with env', provider: 'npm', account_id: null, env_prefix: 'NPM', fields: { token: 'npm_other', registry: 'https://npm.pkg.github.com' } },
  ]);
  assert.deepEqual(resolved.npm_registries.map((r) => [r.credential_id, r.registry, r.token]), [
    ['n', 'https://registry.npmjs.org/', 'npm_global'],
    ['p', 'https://npm.pkg.github.com/', 'npm_other'],
  ]);
  assert.deepEqual(resolved.env, { NPM_TOKEN: 'npm_other', NPM_REGISTRY: 'https://npm.pkg.github.com' });
});

test('git hosts resolve to origins; account shadows global per origin', () => {
  const resolved = resolveAgentEnv([
    { id: 'g', name: 'global lfs', provider: 'git_http', account_id: null, env_prefix: '', fields: { url: 'https://lfs.parnmanas.com/txiv/emberdelve.git/info/lfs', username: 'g', token: 'gt' } },
    { id: 'a', name: 'account lfs', provider: 'git_http', account_id: 'acc-1', env_prefix: 'FORGEJO', fields: { url: 'https://lfs.parnmanas.com', username: 'parnmanas', token: 'at' } },
    { id: 'b', name: 'broken', provider: 'git_http', account_id: 'acc-1', env_prefix: '', fields: { url: 'not a url', username: 'u', token: 't' } },
  ]);
  assert.deepEqual(resolved.git_credentials.map((c) => [c.credential_id, c.url, c.username, c.password]), [
    ['a', 'https://lfs.parnmanas.com', 'parnmanas', 'at'],
  ]);
  assert.deepEqual(resolved.env, { FORGEJO_URL: 'https://lfs.parnmanas.com', FORGEJO_USERNAME: 'parnmanas', FORGEJO_TOKEN: 'at' });
  assert.deepEqual(resolved.skipped.map((s) => s.credential_id), ['b']);
  assert.equal(resolved.sources.find((s) => s.credential_id === 'a').git_host, 'https://lfs.parnmanas.com');
  assert.equal(resolved.sources.some((s) => s.credential_id === 'g'), false, 'global loses to the account row for the same origin');
});

test('account credentials shadow globals; same-scope collisions are reported', () => {
  const resolved = resolveAgentEnv([
    { id: 'g', name: 'global google', provider: 'google_oauth', account_id: null, env_prefix: 'GOOGLE', fields: { client_id: 'global-id', client_secret: 'global-secret' } },
    { id: 'a', name: 'account google', provider: 'google_oauth', account_id: 'acc-1', env_prefix: 'GOOGLE', fields: { client_id: 'acc-id', refresh_token: '' } },
    { id: 'b', name: 'b dup', provider: 'custom', account_id: 'acc-1', env_prefix: 'GOOGLE', fields: { client_id: 'dup' } },
  ]);
  assert.deepEqual(resolved.env, { GOOGLE_CLIENT_ID: 'acc-id', GOOGLE_CLIENT_SECRET: 'global-secret' });
  assert.deepEqual(resolved.skipped.map((s) => [s.credential_id, s.reason]), [['b', 'GOOGLE_CLIENT_ID is already set by account google']]);
  assert.deepEqual(resolved.sources.map((s) => [s.credential_id, s.scope, s.env_names]), [
    ['a', 'account', ['GOOGLE_CLIENT_ID']],
    ['g', 'global', ['GOOGLE_CLIENT_SECRET']],
  ]);
});

function response() {
  return {
    statusCode: 200,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(k, v) { this.headers[k] = v; },
  };
}

const adminReq = { currentUser: { id: 'u-admin', name: 'Admin', role: 'admin', permissions: [] } };
const ENTITIES = [Credential, Resource, Project, AgentSessionCliSetting, AgentSessionExecution, OutreachChannel];

describe('credential agent env — REST', () => {
  let dataSource;
  let controller;
  let envController;
  let warnings;

  before(async () => {
    dataSource = new DataSource({ type: 'sqljs', entities: ENTITIES, synchronize: true, logging: false });
    await dataSource.initialize();
    const credRepo = dataSource.getRepository(Credential);
    controller = new CredentialsController(credRepo, dataSource, {}, { logActivity: async (p) => p }, {}, {});
    warnings = [];
    envController = new CredentialsAgentEnvController(credRepo, { warn: (...args) => warnings.push(args) });
  });

  after(async () => {
    if (dataSource?.isInitialized) await dataSource.destroy();
  });

  beforeEach(async () => {
    warnings.length = 0;
    for (const entity of ENTITIES) await dataSource.getRepository(entity).clear();
  });

  async function create(body) {
    const res = response();
    await controller.create(body, adminReq, res);
    return res;
  }

  async function fetchEnv(req, accountId) {
    const res = response();
    await envController.getAgentEnv(accountId, req, res);
    return res;
  }

  const hostReq = { currentHostId: 'host-1', currentRuntimeKey: null, apiKey: { host_id: 'host-1', account_id: null } };

  it('stores the Google client and hands it to a Host as env', async () => {
    const created = await create({
      account_id: 'acc-1',
      name: 'Google API',
      provider: 'google_oauth',
      credentials: { client_id: '123.apps.googleusercontent.com', client_secret: 'GOCSPX-abc', refresh_token: '1//rt' },
      agent_env: true,
      env_prefix: 'google',
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.env_prefix, 'GOOGLE');
    assert.deepEqual(created.body.agent_env_names, ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN']);
    assert.ok(!JSON.stringify(created.body).includes('GOCSPX-abc'), 'list/create responses stay masked');

    // Not opted in → not delivered.
    await create({ account_id: 'acc-1', name: 'quiet', provider: 'custom', credentials: { QUIET: 'x' } });

    const res = await fetchEnv(hostReq, 'acc-1');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['Cache-Control'], 'no-store');
    assert.deepEqual(res.body.env, {
      GOOGLE_CLIENT_ID: '123.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'GOCSPX-abc',
      GOOGLE_REFRESH_TOKEN: '1//rt',
    });
    assert.deepEqual(res.body.skipped, []);
    assert.deepEqual(res.body.git_credentials, []);
    assert.deepEqual(res.body.npm_registries, []);
  });

  it('an exposed npm token comes back as an npm registry and the list shows which', async () => {
    const created = await create({
      scope: 'global',
      name: 'npm publish',
      provider: 'npm',
      credentials: { token: 'npm_abcdefghijklmnop' },
      agent_env: true,
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.agent_npm_registry, 'https://registry.npmjs.org/');
    assert.deepEqual(created.body.agent_env_names, []);
    const res = await fetchEnv(hostReq, 'acc-1');
    assert.deepEqual(res.body.npm_registries.map((r) => [r.registry, r.token]), [['https://registry.npmjs.org/', 'npm_abcdefghijklmnop']]);
    assert.deepEqual(res.body.env, {});
  });

  it('an exposed git host comes back as a git credential (origin) and the list shows where', async () => {
    const created = await create({
      account_id: 'acc-1',
      name: 'Forgejo LFS',
      provider: 'git_http',
      credentials: { url: 'https://lfs.parnmanas.com/txiv/emberdelve.git/info/lfs', username: 'parnmanas', token: 'tok-123456789' },
      agent_env: true,
    });
    assert.equal(created.statusCode, 201, JSON.stringify(created.body));
    assert.equal(created.body.agent_git_host, 'https://lfs.parnmanas.com');
    assert.deepEqual(created.body.agent_env_names, [], 'no prefix → no env vars');
    const res = await fetchEnv(hostReq, 'acc-1');
    assert.deepEqual(res.body.env, {});
    assert.deepEqual(res.body.git_credentials.map((c) => [c.url, c.username, c.password]), [
      ['https://lfs.parnmanas.com', 'parnmanas', 'tok-123456789'],
    ]);
  });

  it('a global exposed credential reaches every account; another account never sees account-owned ones', async () => {
    await create({ scope: 'global', name: 'Global key', provider: 'custom', credentials: { SHARED_TOKEN: 's' }, agent_env: true });
    await create({ account_id: 'acc-1', name: 'Mine', provider: 'custom', credentials: { MINE: 'm' }, agent_env: true });
    const other = await fetchEnv(hostReq, 'acc-2');
    assert.deepEqual(other.body.env, { SHARED_TOKEN: 's' });
  });

  it('refuses a CLI login credential and a reserved name, with the reason', async () => {
    const cli = await create({ account_id: 'acc-1', name: 'claude', provider: 'claude_api_key', credentials: { api_key: 'sk-ant-x' }, agent_env: true });
    assert.equal(cli.statusCode, 400);
    assert.match(cli.body.error, /CLI logins/);
    const reserved = await create({ account_id: 'acc-1', name: 'bad', provider: 'custom', credentials: { AWB_API_KEY: 'x' }, agent_env: true });
    assert.equal(reserved.statusCode, 400);
    assert.match(reserved.body.error, /reserved/);
  });

  it('route auth: Host key required; a runtime key only reads its own account', async () => {
    await create({ account_id: 'acc-1', name: 'Mine', provider: 'custom', credentials: { MINE: 'm' }, agent_env: true });
    assert.equal((await fetchEnv({ currentHostId: null }, 'acc-1')).statusCode, 403);
    assert.equal((await fetchEnv(hostReq, '')).statusCode, 400);
    const runtimeReq = { currentHostId: 'host-1', currentRuntimeKey: 'rt-0123456789abcdef', apiKey: { host_id: 'host-1', account_id: 'acc-1' } };
    assert.equal((await fetchEnv(runtimeReq, 'acc-2')).statusCode, 403);
    const own = await fetchEnv(runtimeReq, undefined);
    assert.equal(own.statusCode, 200);
    assert.deepEqual(own.body.env, { MINE: 'm' });
  });

  it('an undecryptable row is reported, not silently dropped', async () => {
    const repo = dataSource.getRepository(Credential);
    await repo.save(repo.create({ account_id: 'acc-1', name: 'broken', provider: 'custom', encrypted_data: 'enc:v1:garbage', agent_env: true, env_prefix: '' }));
    const res = await fetchEnv(hostReq, 'acc-1');
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.body.env, {});
    assert.equal(res.body.skipped.length, 1);
    assert.match(res.body.skipped[0].reason, /could not be decrypted/);
    assert.equal(warnings.length, 1);
  });

  it('PATCH remove_fields deletes a Custom key; blank values still keep', async () => {
    const created = await create({ account_id: 'acc-1', name: 'reddit', provider: 'custom', credentials: { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec', OLD: 'o' }, agent_env: true });
    const res = response();
    await controller.update(created.body.id, {
      account_id: 'acc-1',
      credentials: { REDDIT_CLIENT_ID: '', REDDIT_CLIENT_SECRET: 'sec2' },
      remove_fields: ['OLD'],
    }, adminReq, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.agent_env_names, ['REDDIT_CLIENT_ID', 'REDDIT_CLIENT_SECRET']);
    const env = await fetchEnv(hostReq, 'acc-1');
    assert.deepEqual(env.body.env, { REDDIT_CLIENT_ID: 'id', REDDIT_CLIENT_SECRET: 'sec2' });
  });

  it('turning exposure off always succeeds and stops delivery', async () => {
    const created = await create({ account_id: 'acc-1', name: 'g', provider: 'google_oauth', credentials: { client_id: 'i', client_secret: 's' }, agent_env: true, env_prefix: 'GOOGLE' });
    const res = response();
    await controller.update(created.body.id, { account_id: 'acc-1', agent_env: false }, adminReq, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.agent_env, false);
    assert.deepEqual((await fetchEnv(hostReq, 'acc-1')).body.env, {});
  });
});
