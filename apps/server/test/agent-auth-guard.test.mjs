import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentAuthGuard } from '../dist/common/guards/agent-auth.guard.js';
import { AllExceptionsFilter } from '../dist/common/filters/http-exception.filter.js';

function authenticate(result, key = 'presented-key') {
  const request = { headers: key ? { 'x-agent-key': key } : {} };
  const guard = new AgentAuthGuard({
    async validateApiKey(rawKey) {
      assert.equal(rawKey, key);
      if (result instanceof Error) throw result;
      return result;
    },
  });
  return { request, run: () => guard.canActivate({ switchToHttp: () => ({ getRequest: () => request }) }) };
}

function withEnv(t, values = {}) {
  for (const [key, value] of Object.entries({ NODE_ENV: 'production', AGENT_DEV_MODE: 'false', AGENT_API_KEY: '', AGENT_ACCOUNT_ID: '', ...values })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

async function rejectsStatus(auth, status) {
  await assert.rejects(auth.run, error => {
    assert.equal(error.getStatus(), status);
    return true;
  });
  assert.equal(auth.request.currentAccountId, undefined);
}

test('DB validation outage reaches the HTTP filter as 503 without database details', async t => {
  withEnv(t);
  const auth = authenticate(new Error('database connection secret details'));
  await assert.rejects(auth.run, error => {
    let status;
    let body;
    const filter = new AllExceptionsFilter();
    filter.setLogService({ log() {} });
    filter.catch(error, { switchToHttp: () => ({
      getRequest: () => auth.request,
      getResponse: () => ({ status(value) { status = value; return this; }, json(value) { body = value; } }),
    }) });
    assert.equal(status, 503);
    assert.deepEqual(body, { error: 'API key validation temporarily unavailable' });
    return true;
  });
  assert.equal(auth.request.currentAccountId, undefined);
});

test('missing, unknown and explicitly rejected DB keys remain 401', async t => {
  withEnv(t);
  await rejectsStatus(authenticate(new Error('must not validate'), ''), 401);
  for (const reason of ['Key not found', 'Key is revoked', 'Key is expired', 'Key has no owning account', 'Key does not belong to an active host in its account']) {
    await rejectsStatus(authenticate({ valid: false, reason }), 401);
  }
});

test('valid DB keys retain account, host and runtime identity and precede ENV', async t => {
  withEnv(t, { AGENT_API_KEY: 'presented-key', AGENT_ACCOUNT_ID: 'env-account' });
  for (const [name, runtimeKey] of [['manager', null], ['runtime:test:rt-0123456789abcdef', 'rt-0123456789abcdef']]) {
    const apiKey = { account_id: 'db-account', host_id: 'host', name };
    const auth = authenticate({ valid: true, apiKey });
    assert.equal(await auth.run(), true);
    assert.equal(auth.request.apiKey, apiKey);
    assert.equal(auth.request.currentAccountId, 'db-account');
    assert.equal(auth.request.currentHostId, 'host');
    assert.equal(auth.request.currentRuntimeKey, runtimeKey);
    assert.equal(auth.request.currentAgentId, runtimeKey || 'host');
  }
});

test('explicit owned ENV key works for unknown DB key and DB outage', async t => {
  withEnv(t, { AGENT_API_KEY: 'presented-key', AGENT_ACCOUNT_ID: ' env-account ' });
  for (const result of [{ valid: false, reason: 'Key not found' }, new Error('DB unavailable')]) {
    const auth = authenticate(result);
    assert.equal(await auth.run(), true);
    assert.equal(auth.request.currentAccountId, 'env-account');
    assert.equal(auth.request.apiKey, undefined);
  }
  await rejectsStatus(authenticate(new Error('DB unavailable'), 'wrong-key'), 503);
  await rejectsStatus(authenticate({ valid: false, reason: 'Key not found' }, 'wrong-key'), 401);
});

test('ENV cannot override explicit DB rejection or missing DB ownership', async t => {
  withEnv(t, { AGENT_API_KEY: 'presented-key', AGENT_ACCOUNT_ID: 'env-account' });
  for (const reason of ['Key is revoked', 'Key is expired', 'Key has no owning account', 'Key does not belong to an active host in its account']) {
    await rejectsStatus(authenticate({ valid: false, reason }), 401);
  }
  await rejectsStatus(authenticate({ valid: true, apiKey: {} }), 401);
});

test('ENV key without an explicit Account cannot authenticate even during a DB outage', async t => {
  withEnv(t, { AGENT_API_KEY: 'presented-key', AGENT_ACCOUNT_ID: ' ' });
  await rejectsStatus(authenticate(new Error('DB unavailable')), 503);
  await rejectsStatus(authenticate({ valid: false, reason: 'Key not found' }), 401);
});
