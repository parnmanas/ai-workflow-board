import 'reflect-metadata';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { z } from 'zod';
import { Credential } from '../dist/entities/Credential.js';
import { RuntimeHost } from '../dist/entities/RuntimeHost.js';
import { ApiKey } from '../dist/entities/ApiKey.js';
import { encrypt } from '../dist/services/encryption.service.js';
import { registerCredentialTools } from '../dist/modules/mcp/tools/credential-tools.js';
import { installToolAuthzGate } from '../dist/modules/mcp/shared/tool-authz-gate.js';
import { sessionStore } from '../dist/modules/mcp/internal/session-store.js';

process.env.ENCRYPTION_KEY = 'credential-mcp-test-key';
let db, host, own, other, global, broken, empty;
const tools = {};
const secret = 'never-return-this-token';
before(async () => {
  db = await new DataSource({ type: 'sqljs', entities: [Credential, RuntimeHost, ApiKey], synchronize: true }).initialize();
  host = await db.getRepository(RuntimeHost).save({ name: 'Test host', hostname: 'test', account_id: 'account-a' });
  const repo = db.getRepository(Credential);
  async function seed(name, account_id, provider, encrypted_data = encrypt(JSON.stringify({ token: secret }))) {
    return repo.save(repo.create({ name, account_id, provider, encrypted_data, agent_env: true, env_prefix: 'GITHUB' }));
  }
  own = await seed('A own', 'account-a', 'github');
  other = await seed('B other', 'account-b', 'github');
  global = await seed('C global', null, 'github');
  broken = await seed('D broken', 'account-a', 'custom', 'enc:corrupt');
  empty = await seed('E empty', 'account-a', 'custom', encrypt('{}'));
  const server = { tool(name, description, schema, handler) { tools[name] = { schema: z.object(schema), handler }; } };
  installToolAuthzGate(server, db);
  registerCredentialTools(server, { dataSource: db });
});
after(async () => { if (db?.isInitialized) await db.destroy(); });

async function call(name, args = {}, overrides = {}) {
  const sessionId = randomUUID();
  const auth = { source: 'db', scope: 'read', accountId: 'account-a', agentId: host.id, ...overrides };
  sessionStore.register(sessionId, { close: async () => {} }, {}, auth);
  try {
    const result = await tools[name].handler(tools[name].schema.parse(args), { sessionId });
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes(secret));
    assert.ok(!serialized.includes(own.encrypted_data));
    assert.ok(!serialized.includes('credential_fields'));
    assert.ok(!serialized.includes('encrypted_data'));
    return { result, data: JSON.parse(result.content[0].text) };
  } finally { sessionStore.remove(sessionId); }
}

test('read-only account caller discovers own and inherited globals, never other accounts', async () => {
  const { result, data } = await call('list_credentials');
  assert.ok(!result.isError);
  assert.deepEqual(data.credentials.map(r => r.id), [own.id, global.id, broken.id, empty.id]);
  assert.equal(data.total, 4);
  assert.equal(data.limit, 50);
  assert.equal(data.offset, 0);
  assert.deepEqual(data.credentials[0].agent_env_names, ['GITHUB_TOKEN']);
  assert.equal(data.credentials[0].credential_status, 'ok');
  assert.equal(data.credentials[1].scope, 'global');
});

test('provider, scope and pagination filters agree with total', async () => {
  const { data } = await call('list_credentials', { provider: 'github', limit: 1, offset: 1 });
  assert.equal(data.total, 2);
  assert.deepEqual(data.credentials.map(r => r.id), [global.id]);
  assert.deepEqual((await call('list_credentials', { scope: 'account', provider: 'github' })).data.credentials.map(r => r.id), [own.id]);
  assert.deepEqual((await call('list_credentials', { scope: 'global' })).data.credentials.map(r => r.id), [global.id]);
  assert.equal((await call('list_credentials', { provider: 'missing' })).data.total, 0);
});

test('detail follows same visibility and returns identical errors for hidden and absent IDs', async () => {
  for (const row of [own, global]) {
    const { result, data } = await call('get_credential', { credential_id: row.id });
    assert.ok(!result.isError);
    assert.equal(data.id, row.id);
  }
  const hidden = await call('get_credential', { credential_id: other.id });
  const absent = await call('get_credential', { credential_id: randomUUID() });
  assert.equal(hidden.result.isError, true);
  assert.deepEqual(hidden.result, absent.result);
});

test('explicit foreign account is denied even with global scope or a full-scope host-backed key', async () => {
  for (const scope of ['read', 'full']) {
    for (const args of [{ account_id: 'account-b' }, { account_id: 'account-b', scope: 'global' }]) {
      assert.equal((await call('list_credentials', args, { scope })).result.isError, true);
    }
    assert.equal((await call('get_credential', { credential_id: other.id }, { scope })).result.isError, true);
  }
});

test('unbound full-scope host aggregates accounts and can narrow to one account plus globals', async () => {
  const auth = { accountId: undefined, scope: 'full' };
  assert.equal((await call('list_credentials', {}, auth)).data.total, 5);
  assert.deepEqual((await call('list_credentials', { account_id: 'account-b' }, auth)).data.credentials.map(r => r.id), [other.id, global.id]);
  assert.equal((await call('list_credentials', { scope: 'account' }, auth)).data.total, 4);
  assert.equal((await call('get_credential', { credential_id: other.id }, auth)).data.id, other.id);
});

test('unbound read host falls back to its account and cannot aggregate others', async () => {
  assert.equal((await call('list_credentials', {}, { accountId: undefined })).data.total, 4);
  assert.equal((await call('get_credential', { credential_id: own.id }, { accountId: undefined })).data.id, own.id);
  assert.equal((await call('get_credential', { credential_id: other.id }, { accountId: undefined })).result.isError, true);
});

test('runtime key resolves a live host and keeps its account boundary', async () => {
  const runtime = 'rt-0123456789abcdef';
  const repo = db.getRepository(ApiKey);
  const key = await repo.save(repo.create({ name: `runtime:test:${runtime}`, key: 'test-runtime-key', host_id: host.id, account_id: 'account-a', scope: 'read', is_active: true }));
  const auth = { agentId: runtime, accountId: undefined };
  assert.equal((await call('list_credentials', {}, auth)).data.total, 4);
  assert.equal((await call('get_credential', { credential_id: other.id }, auth)).result.isError, true);
  await repo.update(key.id, { is_active: false });
  assert.equal((await call('list_credentials', {}, auth)).result.isError, true);
});

test('missing, env/dev, unknown identity and invalid scope fail closed', async () => {
  for (const auth of [{ source: 'env' }, { source: 'dev-mode' }, { agentId: randomUUID() }, { agentId: undefined }, { scope: undefined }]) {
    for (const [tool, args] of [['list_credentials', {}], ['get_credential', { credential_id: global.id }]]) {
      assert.equal((await call(tool, args, auth)).result.isError, true);
    }
  }
  const noSession = await tools.list_credentials.handler(tools.list_credentials.schema.parse({}), {});
  assert.equal(noSession.isError, true);
});

test('corrupt, malformed and empty stored data returns metadata without payload/error leakage', async () => {
  assert.equal((await call('get_credential', { credential_id: broken.id })).data.credential_status, 'unreadable');
  assert.equal((await call('get_credential', { credential_id: empty.id })).data.credential_status, 'empty');
  await db.getRepository(Credential).update(broken.id, { encrypted_data: encrypt(`invalid-json-${secret}`) });
  const { data } = await call('get_credential', { credential_id: broken.id });
  assert.equal(data.credential_status, 'unreadable');
  assert.deepEqual(data.agent_env_names, []);
});

test('schemas reject invalid pagination and malformed credential IDs', () => {
  for (const args of [{ limit: 0 }, { limit: 101 }, { offset: -1 }, { limit: 1.5 }]) {
    assert.equal(tools.list_credentials.schema.safeParse(args).success, false);
  }
  assert.equal(tools.get_credential.schema.safeParse({ credential_id: 'nope' }).success, false);
});
