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
  const google = ['client_id', 'client_secret', 'refresh_token'];
  assert.equal(validateAgentEnvConfig('google_oauth', 'GOOGLE', google), null);
  assert.match(validateAgentEnvConfig('claude_api_key', 'X', ['api_key']), /CLI logins/);
  assert.match(validateAgentEnvConfig('custom', '', ['ANTHROPIC_BASE_URL']), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', ['AWB_API_KEY']), /reserved/);
  assert.match(validateAgentEnvConfig('openai', 'OPENAI', ['api_key']), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '', ['PATH']), /reserved/);
  assert.match(validateAgentEnvConfig('custom', '1BAD', ['token']), /prefix/);
  assert.match(validateAgentEnvConfig('custom', 'X', ['client-id', 'client_id']), /both become X_CLIENT_ID/);
  assert.match(validateAgentEnvConfig('custom', 'X', []), /no fields/);
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
