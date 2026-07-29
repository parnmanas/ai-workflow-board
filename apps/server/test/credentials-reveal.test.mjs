import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { lastValueFrom, of } from 'rxjs';

import { CredentialsController } from '../dist/modules/credentials/credentials.controller.js';
import { AdminGuard } from '../dist/common/guards/admin.guard.js';

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

test('non-admin direct API access is rejected by AdminGuard with 403', async () => {
  const guard = new AdminGuard({
    canActivate: async (context) => {
      context.switchToHttp().getRequest().currentUser = { id: 'user-1', role: 'user' };
      return true;
    },
  });
  const context = {
    switchToHttp: () => ({ getRequest: () => ({}) }),
  };
  await assert.rejects(() => guard.canActivate(context), (error) => error.getStatus() === 403);
});

test('ordinary list response remains masked and never contains the OAuth token', async () => {
  const { instance } = controller();
  const res = response();
  await instance.list('workspace-1', undefined, undefined, undefined, undefined, res);
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
