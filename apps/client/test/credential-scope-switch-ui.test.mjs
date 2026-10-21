// Credential forms never expose legacy ownership scopes. Updates preserve each row’s owner.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

const ACCOUNTS = [
  { id: 'account-1', name: 'Account One' },
  { id: 'account-2', name: 'Account Two' },
];

function cred(overrides) {
  return {
    id: 'credential-ws',
    account_id: 'account-1',
    board_id: null,
    scope: 'account',
    name: 'Account PAT',
    description: '',
    provider: 'github',
    credential_fields: { token: 'ghp••••tail' },
    credential_status: 'ok',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

const globalCred = cred({
  id: 'credential-global',
  account_id: null,
  scope: 'global',
  name: 'Shared PAT',
});

const secondAccountCred = cred({
  id: 'credential-two',
  account_id: 'account-2',
  name: 'Second PAT',
});

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
}

function scopeSelect(container) {
  return [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'global'));
}

async function mountManager(t, { credentials, ...props }) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  const { uninstall } = installFakeEventSource();
  localStorage.setItem('auth_token', 'admin-session');

  const originals = {
    getMe: api.getMe,
    getSetupStatus: api.getSetupStatus,
    listCredentials: api.listCredentials,
    updateCredential: api.updateCredential,
    createCredential: api.createCredential,
    deleteCredential: api.deleteCredential,
  };
  api.getMe = async () => ({
    id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'active',
    permissions: [], accounts: ACCOUNTS.map((a) => ({ ...a, slug: null, relations: [] })),
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  const listCalls = [];
  api.listCredentials = async (...args) => { listCalls.push(args); return credentials; };

  const view = mountWithBoardStream(
    React.createElement(CredentialManager, { createAccountId: 'account-1', ...props }),
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  t.after(() => { view.unmount(); uninstall(); Object.assign(api, originals); dom.cleanup(); });
  return { ...view, listCalls };
}

function rowOf(container, rowText) {
  const row = [...container.querySelectorAll('tr')].find((r) => r.textContent?.includes(rowText));
  assert.ok(row, `row "${rowText}" must be rendered`);
  return row;
}

function openEdit(container, rowText) {
  const edit = buttonsByText(rowOf(container, rowText), 'Edit');
  assert.equal(edit.length, 1, `row "${rowText}" must offer Edit`);
  click(edit[0]);
}

test('the list aggregates accessible credentials without exposing owner names', async (t) => {
  const { container, listCalls } = await mountManager(t, {
    credentials: [cred({}), secondAccountCred, globalCred],
    canManageGlobal: true,
  });
  // No account_id → the server aggregates every accessible Account + Global.
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0][0], undefined);

  const headers = [...container.querySelectorAll('th')].map((th) => th.textContent.trim());
  assert.ok(!headers.includes('Owner'));
  assert.doesNotMatch(container.textContent, /Account One|Account Two/);
  for (const name of ['Account PAT', 'Second PAT', 'Shared PAT']) rowOf(container, name);

});

test('an Account credential of another Account proves ownership with its own owner, not the page’s', async (t) => {
  const { container } = await mountManager(t, { credentials: [secondAccountCred], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return secondAccountCred; };

  openEdit(container, 'Second PAT');
  assert.equal(scopeSelect(container), undefined);
  assert.doesNotMatch(container.textContent, /Account One|Account Two/);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls[0].body.scope, 'account');
  assert.equal(calls[0].body.account_id, 'account-2');
});

test('a scope-unchanged save keeps sending the credential’s own scope', async (t) => {
  const { container } = await mountManager(t, { credentials: [cred({})], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return cred({}); };

  openEdit(container, 'Account PAT');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(calls[0].body.scope, 'account');
  assert.equal(calls[0].body.account_id, 'account-1');
});

test('a global credential saved as global sends no account of the page', async (t) => {
  const { container } = await mountManager(t, { credentials: [globalCred], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return globalCred; };

  openEdit(container, 'Shared PAT');
  assert.equal(scopeSelect(container), undefined);
  assert.match(container.textContent, /Agent runs with access to this credential/);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(calls[0].body.scope, 'global');
  assert.equal('account_id' in calls[0].body, false);
});

test('without global permission shared credentials stay read-only and owned rows have no scope picker', async (t) => {
  const { container } = await mountManager(t, {
    credentials: [cred({}), globalCred],
    canManageGlobal: false,
  });

  const globalRow = rowOf(container, 'Shared PAT');
  assert.match(globalRow.textContent, /Read-only/);
  assert.equal(buttonsByText(globalRow, 'Edit').length, 0);

  openEdit(container, 'Account PAT');
  assert.equal(scopeSelect(container), undefined);
});

test('the New Credential dialog has no scope picker', async (t) => {
  const { container } = await mountManager(t, { credentials: [], canManageGlobal: true });
  click(buttonsByText(container, '+ New Credential')[0]);
  assert.equal(scopeSelect(container), undefined);
});

test('creating uses its automatic owner without naming old workspaces', async (t) => {
  const { container } = await mountManager(t, { credentials: [], createAccountId: 'account-2' });
  const calls = [];
  api.createCredential = async (body) => { calls.push(body); return cred({ account_id: 'account-2' }); };

  click(buttonsByText(container, '+ New Credential')[0]);
  assert.doesNotMatch(container.textContent, /Account One|Account Two/);
  typeInto(container.querySelector('input[placeholder="e.g. My GitHub PAT"]'), 'New PAT');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'account');
  assert.equal(calls[0].account_id, 'account-2');
});

test('shared creation sends scope global and no account', async (t) => {
  const { container } = await mountManager(t, { credentials: [], createAccountId: null, canManageGlobal: true });
  const calls = [];
  api.createCredential = async (body) => { calls.push(body); return globalCred; };

  click(buttonsByText(container, '+ New Credential')[0]);
  assert.equal(scopeSelect(container), undefined);
  assert.match(container.textContent, /Agent runs with access to this credential/);
  typeInto(container.querySelector('input[placeholder="e.g. My GitHub PAT"]'), 'Shared');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls[0].scope, 'global');
  assert.equal(calls[0].account_id, undefined);
});

test('Delete sends the row’s own owner, not the owner picked for new items', async (t) => {
  const { container } = await mountManager(t, {
    credentials: [secondAccountCred, globalCred],
    createAccountId: 'account-1',
    canManageGlobal: true,
  });
  const calls = [];
  api.deleteCredential = async (id, accountId) => { calls.push({ id, accountId }); return { success: true, id }; };

  click(buttonsByText(rowOf(container, 'Second PAT'), 'Delete')[0]);
  await act(async () => { click(buttonsByText(container, 'Delete Credential')[0]); });
  click(buttonsByText(rowOf(container, 'Shared PAT'), 'Delete')[0]);
  await act(async () => { click(buttonsByText(container, 'Delete Credential')[0]); });

  assert.deepEqual(calls, [
    { id: 'credential-two', accountId: 'account-2' },
    { id: 'credential-global', accountId: undefined },
  ]);
});
