import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  GitCredentialResolutionError,
  resolveGitCredential,
  sanitizeGitError,
} from '../dist/modules/mcp/shared/git-branches.js';

function repoWith(row) {
  return { async findOne() { return row; } };
}

test('registered credential token is passed to Git exactly', async () => {
  const resolved = await resolveGitCredential(repoWith({
    id: 'cred-1', account_id: 'ws-1',
    encrypted_data: JSON.stringify({ token: '  github-token-value  ' }),
  }), 'cred-1', 'ws-1');
  assert.deepEqual(resolved, { username: undefined, token: 'github-token-value' });
});

test('an unreadable registered credential never falls back to anonymous Git', async () => {
  await assert.rejects(
    resolveGitCredential(repoWith({
      id: 'cred-1', account_id: 'ws-1', encrypted_data: 'enc:corrupted',
    }), 'cred-1', 'ws-1'),
    (err) => err instanceof GitCredentialResolutionError && /unreadable/.test(err.message),
  );
});

test('a registered credential with an empty token reports the real error', async () => {
  await assert.rejects(
    resolveGitCredential(repoWith({
      id: 'cred-1', account_id: 'ws-1', encrypted_data: JSON.stringify({ token: '' }),
    }), 'cred-1', 'ws-1'),
    /has no token/,
  );
});

// The Board layer is gone, so the only boundary left is the Account: a
// Global credential (account_id NULL) resolves everywhere, a Account one
// only inside its own Account.
test('a credential owned by another Account fails closed', async () => {
  await assert.rejects(
    resolveGitCredential(repoWith({
      id: 'cred-other', account_id: 'ws-2', encrypted_data: JSON.stringify({ token: 'other-token' }),
    }), 'cred-other', 'ws-1'),
    (err) => err instanceof GitCredentialResolutionError && /different workspace/.test(err.message),
  );
});

test('a Global credential resolves from any Account', async () => {
  const resolved = await resolveGitCredential(repoWith({
    id: 'cred-global', account_id: null,
    encrypted_data: JSON.stringify({ username: ' bot ', api_key: 'global-token' }),
  }), 'cred-global', 'ws-1');
  assert.deepEqual(resolved, { username: 'bot', token: 'global-token' });
});

test('no selected credential means anonymous Git; a dangling id is an error', async () => {
  assert.equal(await resolveGitCredential(repoWith(null), null, 'ws-1'), null);
  assert.equal(await resolveGitCredential(repoWith(null), '', 'ws-1'), null);
  await assert.rejects(
    resolveGitCredential(repoWith(null), 'cred-missing', 'ws-1'),
    /does not exist/,
  );
});

test('Git errors expose the cause without leaking registered credentials', () => {
  const safe = sanitizeGitError(
    "fatal: Authentication failed for 'https://x-access-token:ghp_secret_value@github.com/acme/private.git'",
    { token: 'ghp_secret_value' },
  );
  assert.match(safe, /Authentication failed/);
  assert.doesNotMatch(safe, /ghp_secret_value|x-access-token/);
  assert.match(safe, /https:\/\/\*\*\*@github\.com/);
});

// ── manager → server: a project's clone credential over HTTP ─────────────────
// Repositories are Projects now (docs/tickets.md); repository Resources were
// migrated with the SAME id, so the old `/resources/:id/git-credential` path
// is an alias that resolves a project by id. Boundary = the project's own
// workspace.
test('GET /api/agent-manager/projects/:id/git-credential (and the /resources alias) serves the project credential', async (t) => {
  const { bootApp } = await import('./helpers/boot.mjs');
  const { createAccount, createAgent, createProject, runtimeHostKeyForAgent } = await import('./helpers/fixtures.mjs');
  const { encrypt } = await import('../dist/services/encryption.service.js');

  // This route must take the REAL auth path — the boot helper defaults to
  // AGENT_DEV_MODE=true, which skips AgentAuthGuard and leaves no caller Host.
  process.env.AGENT_DEV_MODE = 'false';
  const { app, port, modules } = await bootApp({ port: 0 });
  t.after(() => { void app.close().catch(() => {}); });
  const ds = app.get(modules.getDataSourceToken());
  const base = `http://localhost:${port}`;

  const ws = await createAccount(app, modules.getDataSourceToken, 'git-cred');
  const otherWs = await createAccount(app, modules.getDataSourceToken, 'git-cred-other');
  const host = await createAgent(app, modules.getDataSourceToken, ws.id, { name: 'git-cred-host', type: 'manager' });
  const hostKey = runtimeHostKeyForAgent(host.id);
  assert.ok(hostKey, 'fixture precondition: the Runtime Host has an api key');

  const credRepo = ds.getRepository('Credential');
  const mkCred = (account_id, fields) => credRepo.save(credRepo.create({
    account_id, name: `cred-${Math.random().toString(36).slice(2, 8)}`, description: '', provider: 'github',
    encrypted_data: encrypt(JSON.stringify(fields)),
  }));
  const wsCred = await mkCred(ws.id, { token: 'ws-token' });
  const foreignCred = await mkCred(otherWs.id, { token: 'foreign-token' });

  const projectRepo = ds.getRepository('Project');
  const withCred = await createProject(app, modules.getDataSourceToken, ws.id, { name: 'with-cred' });
  await projectRepo.update({ id: withCred.id }, { credential_id: wsCred.id });
  const noCred = await createProject(app, modules.getDataSourceToken, ws.id, { name: 'no-cred' });
  const foreign = await createProject(app, modules.getDataSourceToken, ws.id, { name: 'foreign-cred' });
  await projectRepo.update({ id: foreign.id }, { credential_id: foreignCred.id });

  const get = (path) => fetch(`${base}${path}`, { headers: { 'X-Agent-Key': hostKey } });

  for (const prefix of ['projects', 'resources']) {
    const res = await get(`/api/agent-manager/${prefix}/${withCred.id}/git-credential?account_id=${ws.id}`);
    assert.equal(res.status, 200, `${prefix} route must serve the project credential`);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await res.json(), { username: 'x-access-token', token: 'ws-token' });
  }

  assert.equal((await get(`/api/agent-manager/projects/${noCred.id}/git-credential`)).status, 204,
    'a project without a credential clones anonymously');
  assert.equal((await get(`/api/agent-manager/projects/${withCred.id}/git-credential?account_id=${otherWs.id}`)).status, 404,
    'a account_id that is not the project workspace must not resolve it');
  assert.equal((await get(`/api/agent-manager/projects/00000000-0000-0000-0000-000000000000/git-credential`)).status, 404);
  assert.equal((await get(`/api/agent-manager/projects/${foreign.id}/git-credential`)).status, 403,
    'a credential from another workspace must never be served for this project');

  const anonymous = await fetch(`${base}/api/agent-manager/projects/${withCred.id}/git-credential`);
  assert.equal(anonymous.status, 401, 'a Runtime Host key is required');
});
