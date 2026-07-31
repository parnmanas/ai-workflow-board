import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { lastValueFrom, of } from 'rxjs';

import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';

const SECRET = 'sk-ant-oat-test-secret-value';
const PASSWORD = 'correct horse battery staple';
const credential = {
  id: 'credential-1',
  workspace_id: 'workspace-1',
  board_id: null,
  name: 'OAuth',
  description: '',
  provider: 'claude_oauth_token',
  encrypted_data: JSON.stringify({ oauth_token: SECRET }),
  created_at: new Date(),
  updated_at: new Date(),
};

function response() {
  return {
    statusCode: 200,
    headers: {},
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function controller({ passwordValid = true } = {}) {
  const audits = [];
  const credRepo = {
    findOne: async ({ where }) => where.id === credential.id ? credential : null,
    find: async () => [credential],
  };
  const auth = { verifyUserPassword: async (_id, password) => passwordValid && password === PASSWORD };
  const activity = {
    logActivity: async (entry) => {
      audits.push({ ...entry, created_at: new Date().toISOString() });
      return entry;
    },
  };
  return {
    instance: new CredentialsController(credRepo, {}, auth, activity),
    audits,
  };
}

test('admin with correct re-authentication reveals only provider fields and audits without secrets', async () => {
  const { instance, audits } = controller();
  const res = response();
  await instance.reveal(
    credential.id,
    { password: PASSWORD },
    { currentUser: { id: 'admin-1', name: 'Admin', role: 'admin' } },
    res,
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.credential_fields, { oauth_token: SECRET });
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'credential_revealed');
  assert.equal(audits[0].actor_id, 'admin-1');
  assert.equal(audits[0].entity_id, credential.id);
  assert.ok(audits[0].created_at);
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(SECRET));
  assert.doesNotMatch(JSON.stringify(audits), new RegExp(PASSWORD));
});

test('wrong re-authentication returns 401 and writes a secret-free denial audit', async () => {
  const { instance, audits } = controller({ passwordValid: false });
  const res = response();
  await instance.reveal(
    credential.id,
    { password: 'wrong-password' },
    { currentUser: { id: 'admin-1', name: 'Admin', role: 'admin' } },
    res,
  );

  assert.equal(res.statusCode, 401);
  assert.equal(audits[0].action, 'credential_reveal_denied');
  assert.equal(audits[0].actor_id, 'admin-1');
  assert.equal(audits[0].entity_id, credential.id);
  assert.ok(audits[0].created_at);
  assert.doesNotMatch(JSON.stringify(audits), /wrong-password|sk-ant-oat/);
});

test('non-OAuth providers cannot reveal any registered secret fields', async () => {
  const apiKeySecret = 'non-oauth-api-key-secret';
  const nonOAuthCredential = {
    ...credential,
    id: 'credential-api-key',
    provider: 'openai',
    encrypted_data: JSON.stringify({ api_key: apiKeySecret }),
  };
  const audits = [];
  const credRepo = {
    findOne: async ({ where }) => where.id === nonOAuthCredential.id ? nonOAuthCredential : null,
  };
  const auth = {
    verifyUserPassword: async () => {
      assert.fail('non-OAuth credentials must be rejected before re-authentication');
    },
  };
  const activity = { logActivity: async (entry) => audits.push(entry) };
  const instance = new CredentialsController(credRepo, {}, auth, activity);
  const res = response();

  await instance.reveal(
    nonOAuthCredential.id,
    { password: PASSWORD },
    { currentUser: { id: 'admin-1', name: 'Admin', role: 'admin' } },
    res,
  );

  assert.equal(res.statusCode, 400);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(apiKeySecret));
  assert.equal(audits.length, 0);
});

test('routed reveal API rejects non-admin with 403 and preserves masked/no-store contracts', async () => {
  process.env.DB_TYPE = 'sqlite';
  process.env.NODE_ENV = 'test';
  process.env.MCP_DEV_MODE = 'true';
  process.env.AGENT_DEV_MODE = 'true';
  process.env.SQLJS_DB_PATH = path.join(
    os.tmpdir(),
    `awb-credential-reveal-route-${process.pid}-${randomUUID()}.db`,
  );

  const [
    { NestFactory },
    { AppModule },
    { AuthService },
    { getDataSourceToken },
    { encrypt },
  ] = await Promise.all([
    import('@nestjs/core'),
    import('../dist/app.module.js'),
    import('../dist/services/auth.service.js'),
    import('@nestjs/typeorm'),
    import('../dist/services/encryption.service.js'),
  ]);
  const app = await NestFactory.create(AppModule, { logger: false });

  try {
    await app.listen(0, '127.0.0.1');
    const port = app.getHttpServer().address().port;
    const auth = app.get(AuthService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const workspaceRepo = dataSource.getRepository('Workspace');
    const credentialRepo = dataSource.getRepository('Credential');
    const routedSecret = `routed-${SECRET}-${randomUUID()}`;
    const adminPassword = `admin-${PASSWORD}-${randomUUID()}`;

    const admin = await userRepo.save(userRepo.create({
      name: 'Reveal Admin',
      email: `reveal-admin-${randomUUID()}@example.test`,
      role: 'admin',
      status: 'active',
      password_hash: await auth.hashPassword(adminPassword),
    }));
    const nonAdmin = await userRepo.save(userRepo.create({
      name: 'Reveal User',
      email: `reveal-user-${randomUUID()}@example.test`,
      role: 'user',
      status: 'active',
      permissions: JSON.stringify(['admin.credentials']),
      password_hash: await auth.hashPassword('user-password'),
    }));
    const workspace = await workspaceRepo.save(workspaceRepo.create({ name: 'Reveal Workspace' }));
    const routedCredential = await credentialRepo.save(credentialRepo.create({
      workspace_id: workspace.id,
      board_id: null,
      name: 'Routed OAuth',
      description: '',
      provider: 'claude_oauth_token',
      encrypted_data: encrypt(JSON.stringify({ oauth_token: routedSecret })),
    }));
    const nonOAuthSecret = `routed-api-key-${randomUUID()}`;
    const nonOAuthCredential = await credentialRepo.save(credentialRepo.create({
      workspace_id: workspace.id,
      board_id: null,
      name: 'Routed API Key',
      description: '',
      provider: 'openai',
      encrypted_data: encrypt(JSON.stringify({ api_key: nonOAuthSecret })),
    }));
    const adminToken = auth.createSession(admin.id);
    const nonAdminToken = auth.createSession(nonAdmin.id);
    const baseUrl = `http://127.0.0.1:${port}/api/credentials`;

    const denied = await fetch(`${baseUrl}/${routedCredential.id}/reveal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${nonAdminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: 'user-password' }),
    });
    const deniedBody = await denied.text();
    assert.equal(denied.status, 403);
    assert.doesNotMatch(deniedBody, new RegExp(routedSecret));

    const nonOAuthReveal = await fetch(`${baseUrl}/${nonOAuthCredential.id}/reveal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: adminPassword }),
    });
    const nonOAuthRevealBody = await nonOAuthReveal.text();
    assert.equal(nonOAuthReveal.status, 400);
    assert.doesNotMatch(nonOAuthRevealBody, new RegExp(nonOAuthSecret));

    const list = await fetch(`${baseUrl}?workspace_id=${workspace.id}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    const listBody = await list.json();
    assert.equal(list.status, 200);
    assert.doesNotMatch(JSON.stringify(listBody), new RegExp(routedSecret));
    assert.match(
      listBody.find((item) => item.id === routedCredential.id).credential_fields.oauth_token,
      /••••/,
    );

    const revealed = await fetch(`${baseUrl}/${routedCredential.id}/reveal`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${adminToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ password: adminPassword }),
    });
    const revealedBody = await revealed.json();
    assert.equal(revealed.status, 200);
    assert.match(revealed.headers.get('cache-control') || '', /no-store/);
    assert.equal(revealedBody.credential_fields.oauth_token, routedSecret);
  } finally {
    await app.close();
  }
});

test('ordinary list response remains masked and never contains the OAuth token', async () => {
  const { instance } = controller();
  const res = response();
  await instance.list('workspace-1', undefined, undefined, undefined, res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(SECRET));
  assert.match(res.body[0].credential_fields.oauth_token, /••••/);
});

test('ordinary detail/initial response remains masked and never contains the OAuth token', async () => {
  const { instance } = controller();
  const res = response();
  await instance.get(credential.id, 'workspace-1', res);
  assert.equal(res.statusCode, 200);
  assert.doesNotMatch(JSON.stringify(res.body), new RegExp(SECRET));
  assert.match(res.body.credential_fields.oauth_token, /••••/);
});

test('LOG_HTTP_BODIES=true never captures reveal request or response secrets', async () => {
  process.env.LOG_HTTP_BODIES = 'true';
  const { RequestLoggerInterceptor } = await import(
    '../dist/common/interceptors/request-logger.interceptor.js'
  );
  const { LogService } = await import('../dist/services/log.service.js');

  const { instance } = controller();
  const revealResponse = response();
  await instance.reveal(
    credential.id,
    { password: PASSWORD },
    { currentUser: { id: 'admin-1', name: 'Admin', role: 'admin' } },
    revealResponse,
  );
  assert.equal(revealResponse.statusCode, 200);
  assert.equal(revealResponse.body.credential_fields.oauth_token, SECRET);

  const logService = new LogService();
  const interceptor = new RequestLoggerInterceptor(logService);
  const req = {
    path: `/api/credentials/${credential.id}/reveal`,
    method: 'POST',
    originalUrl: `/api/credentials/${credential.id}/reveal`,
    url: `/api/credentials/${credential.id}/reveal`,
    headers: {},
    body: { password: PASSWORD },
    currentUser: { id: 'admin-1', name: 'Admin', role: 'admin' },
  };
  const httpResponse = {
    statusCode: 200,
    getHeaders: () => ({ 'cache-control': 'no-store, no-cache' }),
  };
  const context = {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => httpResponse,
    }),
  };

  await lastValueFrom(interceptor.intercept(context, { handle: () => of(revealResponse.body) }));

  const logs = logService.query({ category: 'HTTP' });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].meta.reqBody, undefined);
  assert.equal(logs[0].meta.resBody, undefined);
  const serializedLogs = JSON.stringify(logs);
  assert.doesNotMatch(serializedLogs, new RegExp(SECRET));
  assert.doesNotMatch(serializedLogs, new RegExp(PASSWORD));
});
