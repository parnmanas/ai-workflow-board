// Regression test — ticket 7f4a4062
// "[보안] 독립형 mcp-server.ts HTTP 모드(MCP_TRANSPORT=http) — 인증(API 키) 전무"
//
// The standalone MCP entry point's HTTP mode (`MCP_TRANSPORT=http`, the mode
// `npm run mcp:http` / README.md's documented usage runs) had NO credential
// check anywhere in startHttp() — unlike the NestJS-integrated /mcp endpoint
// (mcp.controller.ts's authenticate()), so anyone who could reach MCP_PORT
// could call all ~190 MCP tools unauthenticated. sessionStore.register() was
// also called without its 4th `auth` argument, so even the tool-name-based
// authz gate that inspects the caller identity saw `caller === undefined` for
// every standalone session.
//
// This boots the REAL compiled dist/mcp-server.js in HTTP mode (the same code
// path `npm run mcp:http` runs) against an isolated sql.js DB and drives it
// with real HTTP requests — proving the actual wire behavior, not just that
// the source calls the right function.
//
// Runs against compiled dist/ (requires `npm run build`, satisfied by the
// test script). Uses an isolated SQLJS_DB_PATH temp file so it never touches
// the shared dev database/data.db, and a dedicated high port far from both
// the live-infra-shared 770x range and the qa-flows 78xx/79xx range.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.join(__dirname, '..', 'dist');

const PORT = parseInt(process.env.MCP_STANDALONE_AUTH_TEST_PORT || '17812', 10);
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-mcp-http-auth-'));

// Must be set BEFORE importing mcp-server.js — its main() reads these at
// import time (dotenv/config does not override already-set process.env
// values, so this wins over any apps/server/.env).
process.env.DB_TYPE = 'sqlite';
process.env.SQLJS_DB_PATH = path.join(tmpDir, 'mcp-http-auth-test.db');
process.env.NODE_ENV = 'test';
process.env.MCP_TRANSPORT = 'http';
process.env.MCP_PORT = String(PORT);
delete process.env.MCP_DEV_MODE;
delete process.env.MCP_API_KEYS;

async function waitForHealth(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${PORT}/health`);
      if (res.ok) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`mcp-server.js (http mode) did not become healthy within ${timeoutMs}ms: ${lastErr}`);
}

function initializeBody() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: { experimental: { 'awb/schemaVersion': { version: 2 } } },
      clientInfo: { name: 'auth-test-client', version: '0.0.0' },
    },
  });
}

test('standalone mcp-server.js HTTP mode enforces authentication end-to-end', async (t) => {
  // Triggers main() -> preSyncPostgres (no-op on sqlite) -> initDb() ->
  // startHttp() -> app.listen(PORT). This is exactly what
  // `MCP_TRANSPORT=http npm run mcp` / `npm run mcp:http` runs in production.
  await import('file://' + path.join(DIST_ROOT, 'mcp-server.js'));
  await waitForHealth();

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  await t.test('no credentials on initialize -> 401, no session created', async () => {
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: initializeBody(),
    });
    assert.equal(res.status, 401);
    assert.equal(res.headers.get('mcp-session-id'), null);
    const body = await res.json();
    assert.equal(body.error?.code, -32001);
  });

  await t.test('bogus Bearer token -> 403', async () => {
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: 'Bearer totally-not-a-real-key',
      },
      body: initializeBody(),
    });
    assert.equal(res.status, 403);
    const body = await res.json();
    assert.equal(body.error?.code, -32002);
  });

  await t.test('DELETE without credentials is rejected too (auth gates every method, not just POST)', async () => {
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': randomUUID() },
    });
    assert.equal(res.status, 401);
  });

  // Seed a real DB-backed API key directly against the SAME AppDataSource
  // singleton mcp-server.js's initDb() already initialized — dynamic import()
  // caches by resolved file:// URL, so this is the identical module instance.
  const { AppDataSource } = await import('file://' + path.join(DIST_ROOT, 'db.js'));
  const { ApiKey } = await import('file://' + path.join(DIST_ROOT, 'entities', 'ApiKey.js'));
  const rawKey = `awb_test_${randomUUID().replace(/-/g, '')}`;
  const apiKeyRepo = AppDataSource.getRepository(ApiKey);
  await apiKeyRepo.save(apiKeyRepo.create({
    name: 'standalone-http-auth-test',
    key: createHash('sha256').update(rawKey, 'utf8').digest('hex'),
    key_prefix: rawKey.slice(0, 8) + '***',
    agent_id: null,
    scope: 'full',
    is_active: 1,
    workspace_id: '',
  }));

  let sessionId;
  await t.test('valid DB-backed key -> session created with auth attached', async () => {
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKey}`,
      },
      body: initializeBody(),
    });
    assert.equal(res.status, 200);
    sessionId = res.headers.get('mcp-session-id');
    assert.ok(sessionId, 'a successful initialize must return a session id');

    // Core bug this ticket fixes: sessionStore.register() used to be called
    // without the 4th `auth` arg in the standalone path, so entry.auth was
    // always undefined even for a fully valid key.
    const { sessionStore } = await import(
      'file://' + path.join(DIST_ROOT, 'modules', 'mcp', 'internal', 'session-store.js')
    );
    const auth = sessionStore.getAuth(sessionId);
    assert.ok(auth, 'session must carry an auth context, not be undefined');
    assert.equal(auth.source, 'db');
    assert.equal(auth.scope, 'full');
  });

  await t.test('reusing a valid session id without credentials is still rejected', async () => {
    // Auth is checked on EVERY request, not just initialize — a follow-up
    // call that reuses a live session id but drops the Authorization header
    // must be rejected before the session lookup ever runs.
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });
    assert.equal(res.status, 401);
  });

  await t.test('reusing the valid session id WITH credentials still works', async () => {
    const res = await fetch(`http://localhost:${PORT}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${rawKey}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list' }),
    });
    assert.equal(res.status, 200);
  });
});

// mcp-server.js's app.listen(PORT) is a non-unref'd http.Server (correct for
// production — it must keep the process alive), so this suite is launched
// with --test-force-exit like every other dist-booting test here.
