// GET /api/cli-catalog — 로그인한 사용자(admin 불필요)에게 서버의 CLI 카탈로그를
// 그대로 돌려 준다. 비로그인은 401.
import assert from 'node:assert/strict';
import test from 'node:test';

import { bootApp, exitAfterTests } from './helpers/boot.mjs';
import { createUser } from './helpers/fixtures.mjs';
import { CLI_CATALOG } from '../dist/common/cli-catalog.js';

process.env.PORT = process.env.CLI_CATALOG_PORT || '0';

test('GET /api/cli-catalog requires a user session and returns the catalog', async (t) => {
  const { app, port, modules } = await bootApp({ port: Number.parseInt(process.env.PORT, 10) });
  t.after(async () => { await app.close(); });
  const url = `http://127.0.0.1:${port}/api/cli-catalog`;

  const anon = await fetch(url);
  assert.equal(anon.status, 401, 'no session → 401');

  const { AuthService, getDataSourceToken } = modules;
  const viewer = await createUser(app, getDataSourceToken, { name: 'viewer', role: 'user' });
  const token = app.get(AuthService).createSession(viewer.id);

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200, 'any logged-in user (non-admin) may read it');
  const body = await res.json();
  assert.deepEqual(Object.keys(body), ['clis']);
  assert.deepEqual(
    body.clis.map((d) => d.id),
    ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'opencode', 'hermes', 'custom'],
  );
  assert.deepEqual(body, JSON.parse(JSON.stringify({ clis: CLI_CATALOG })), 'wire shape == catalog');
  // no secrets ride along — only descriptor facts
  const text = JSON.stringify(body);
  assert.equal(text.includes('encrypted'), false);
  assert.equal(text.includes('sk-'), false);
});

exitAfterTests();
