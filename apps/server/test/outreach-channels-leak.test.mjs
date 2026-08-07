// Cross-tenant leak test for the outreach-channels REST surface (ticket
// 2500fea3 step 7) — mirrors channels-leak.test.mjs's shape: boots the full
// NestJS app in-process from compiled dist/ and drives it over real HTTP, so
// wiring bugs a direct-instantiation unit test (outreach-channels-scope.test.mjs)
// can't catch — guard not applied, route not registered, a header/query
// mismatch — are caught here too.
//
// Two concerns, both against the REAL HTTP response:
//   1. Workspace isolation — a channel created in workspace A never appears
//      when listing/getting scoped to workspace B (the query-level
//      workspace_id filter, exercised through the full guard+controller
//      stack this time, not just the service directly).
//   2. Credential non-exposure — the ticket's "자격증명이... API 응답 어디에도
//      평문 노출되지 않음" completion criterion, checked against the RAW
//      response body text (not just "no credential_id key") so even an
//      accidental stray field containing the secret would be caught.

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { apiRequest, makeBaseUrl } from './test-helpers.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';
// Hermetic sql.js DB per file — see tickets-leak/channels-leak for the
// rationale (inline boot + back-to-back npm `test` chain would otherwise
// share database/data.db across files).
process.env.SQLJS_DB_PATH =
  process.env.SQLJS_DB_PATH || path.join(os.tmpdir(), `awb-leak-outreach-${Date.now()}-${process.pid}.db`);
process.env.PORT = process.env.OUTREACH_LEAK_PORT || '7795';
process.env.NODE_ENV = 'test';
process.env.MCP_DEV_MODE = 'true';
process.env.AGENT_DEV_MODE = 'true';

const BASE_URL = makeBaseUrl(parseInt(process.env.PORT, 10));

async function loadServerModules() {
  try {
    const { NestFactory } = await import('@nestjs/core');
    const { AppModule } = await import('file://' + path.join(DIST_ROOT, 'app.module.js'));
    const { AuthService } = await import('file://' + path.join(DIST_ROOT, 'services', 'auth.service.js'));
    const { getDataSourceToken } = await import('@nestjs/typeorm');
    return { NestFactory, AppModule, AuthService, getDataSourceToken };
  } catch (err) {
    throw new Error(
      'Leak test requires the server to be built first. Run `npm run --workspace=apps/server build`. Original error: ' + err.message,
    );
  }
}

describe('outreach-channels-leak: cross-workspace isolation + credential non-exposure', async () => {
  let app;
  let adminToken;
  let wsA;
  let wsB;
  let credA;
  let channelA;

  const ADMIN_EMAIL = `outreach-leak-admin-${randomUUID()}@awb.local`;
  const RAW_SECRET_TOKEN = `super-secret-outreach-token-${randomUUID()}`;

  before(async () => {
    const { NestFactory, AppModule, AuthService, getDataSourceToken } = await loadServerModules();

    app = await NestFactory.create(AppModule, { logger: false });
    await app.listen(parseInt(process.env.PORT, 10), '0.0.0.0');

    const authService = app.get(AuthService);
    const dataSource = app.get(getDataSourceToken());
    const userRepo = dataSource.getRepository('User');
    const wsRepo = dataSource.getRepository('Workspace');
    const credRepo = dataSource.getRepository('Credential');

    const adminUser = await userRepo.save(userRepo.create({
      name: 'outreach-leak-admin', email: ADMIN_EMAIL, role: 'admin', status: 'active',
    }));
    adminToken = authService.createSession(adminUser.id);

    wsA = await wsRepo.save(wsRepo.create({ name: 'Leak WS A (outreach)', description: 'Leak test' }));
    wsB = await wsRepo.save(wsRepo.create({ name: 'Leak WS B (outreach)', description: 'Leak test' }));

    // A real Credential row carrying a RECOGNIZABLE raw-secret substring,
    // scoped to workspace A. Nothing in the CRUD path ever decrypts this
    // (only outreach-credential.ts's resolveOutreachCredential does, and only
    // from the polling sweep) — the plain marker is enough to prove the value
    // never round-trips into an HTTP response regardless.
    credA = await credRepo.save(credRepo.create({
      workspace_id: wsA.id, name: 'outreach-cred-a', provider: 'github',
      encrypted_data: `enc:${RAW_SECRET_TOKEN}`,
    }));

    const createRes = await apiRequest(BASE_URL, '/outreach-channels', {
      token: adminToken,
      method: 'POST',
      body: {
        workspace_id: wsA.id,
        kind: 'github',
        name: `Leak Channel WS-A ${randomUUID()}`,
        credential_id: credA.id,
      },
    });
    assert.equal(createRes.status, 201, `Failed to create channel: ${JSON.stringify(createRes.data)}`);
    channelA = createRes.data;
  });

  after(async () => {
    if (app) {
      try { await app.close(); } catch { /* ignore */ }
    }
    // No process.exit here — the suite runs with --test-force-exit, which
    // tears down NestJS's unreffed intervals / TypeORM handles and exits
    // with the real code node:test computed (a stray exit here would mask a
    // failed assertion, same rationale as channels-leak.test.mjs).
  });

  it('admin can create a channel with a credential attached (control)', () => {
    assert.ok(channelA?.id, 'Channel should have been created with an ID');
    assert.equal(channelA.has_credential, true, 'has_credential reflects the attached credential');
  });

  it('the credential_id and the raw token never appear anywhere in the create response', () => {
    const raw = JSON.stringify(channelA);
    assert.equal(channelA.credential_id, undefined, 'credential_id key must not be present');
    assert.doesNotMatch(raw, /credential_id/, 'no credential_id key anywhere in the response');
    assert.doesNotMatch(raw, new RegExp(RAW_SECRET_TOKEN), 'the raw secret token never appears in the response');
  });

  it('admin listing workspace A sees the created channel', async () => {
    const res = await apiRequest(BASE_URL, `/outreach-channels?workspace_id=${wsA.id}`, { token: adminToken });
    assert.equal(res.status, 200);
    const rows = Array.isArray(res.data) ? res.data : [];
    assert.ok(rows.some((c) => c.id === channelA.id), 'workspace A listing includes channel A');
    const raw = JSON.stringify(rows);
    assert.doesNotMatch(raw, /credential_id/, 'list response never carries credential_id');
    assert.doesNotMatch(raw, new RegExp(RAW_SECRET_TOKEN), 'list response never carries the raw token');
  });

  it('admin listing workspace B never sees workspace A\'s channel', async () => {
    const res = await apiRequest(BASE_URL, `/outreach-channels?workspace_id=${wsB.id}`, { token: adminToken });
    assert.equal(res.status, 200);
    const rows = Array.isArray(res.data) ? res.data : [];
    assert.equal(rows.filter((c) => c.id === channelA.id).length, 0, 'channel A must not leak into workspace B\'s listing');
  });

  it('get(:id) scoped to workspace B 404s for a channel that belongs to workspace A', async () => {
    const res = await apiRequest(BASE_URL, `/outreach-channels/${channelA.id}?workspace_id=${wsB.id}`, { token: adminToken });
    assert.equal(res.status, 404, 'cross-workspace get must not resolve');
  });

  it('get(:id) scoped to the correct workspace resolves without leaking the secret', async () => {
    const res = await apiRequest(BASE_URL, `/outreach-channels/${channelA.id}?workspace_id=${wsA.id}`, { token: adminToken });
    assert.equal(res.status, 200);
    assert.equal(res.data.id, channelA.id);
    const raw = JSON.stringify(res.data);
    assert.doesNotMatch(raw, /credential_id/);
    assert.doesNotMatch(raw, new RegExp(RAW_SECRET_TOKEN));
  });

  it('the status endpoint never leaks the secret either', async () => {
    const res = await apiRequest(BASE_URL, `/outreach-channels/${channelA.id}/status?workspace_id=${wsA.id}`, { token: adminToken });
    assert.equal(res.status, 200);
    const raw = JSON.stringify(res.data);
    assert.doesNotMatch(raw, /credential_id/);
    assert.doesNotMatch(raw, new RegExp(RAW_SECRET_TOKEN));
  });
});
