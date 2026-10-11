// Credentials are the one catalog surface where an existing row's scope is
// switchable (global ↔ Account) instead of 400-ing. The picker only appears
// on an existing credential — the owner of a new one comes from the
// page-level "Account for new item" select in AccountManagementPage — and it
// is read-only for anyone without admin.global_credentials.
//
// The gate matters twice over: AccountManagementPage used to derive it from
// admin.access, which the server never checks, so the UI and the server
// disagreed in both directions.
//
// The list aggregates every accessible Account plus Global rows
// (docs/ownership.md), so there is no "current Account" to fall back on: each
// row names its owner, writes prove ownership with the row's own owner, and a
// narrowed global credential goes to the Account chosen in the picker.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, click, typeInto, React, act, run } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

const pageSource = fs.readFileSync(
  new URL('../src/components/AccountManagementPage.tsx', import.meta.url),
  'utf8',
);

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

/** React's onChange for <select> rides the native 'change' event, not 'input'
 *  (which is what the shared typeInto helper dispatches). */
function selectOption(select, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
}

function scopeSelect(container) {
  return [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'global'));
}

function optionLabels(select) {
  return [...select.options].map((o) => o.textContent.trim());
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
    React.createElement(CredentialManager, { createAccountId: 'account-1', accounts: ACCOUNTS, ...props }),
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

test('the list is not filtered by an account and every row names its owner', async (t) => {
  const { container, listCalls } = await mountManager(t, {
    credentials: [cred({}), secondAccountCred, globalCred],
    canManageGlobal: true,
  });
  // No account_id → the server aggregates every accessible Account + Global.
  assert.equal(listCalls.length, 1);
  assert.equal(listCalls[0][0], undefined);

  const headers = [...container.querySelectorAll('th')].map((th) => th.textContent.trim());
  assert.ok(headers.includes('Owner'), `expected an Owner column, got ${headers.join(', ')}`);
  assert.equal(container.querySelector('[data-testid="credential-owner-credential-ws"]').textContent, 'Account One');
  assert.equal(container.querySelector('[data-testid="credential-owner-credential-two"]').textContent, 'Account Two');
  assert.equal(container.querySelector('[data-testid="credential-owner-credential-global"]').textContent, 'Global');
});

test('an admin can widen a Account credential to global from the Edit dialog', async (t) => {
  const { container } = await mountManager(t, { credentials: [cred({})], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return cred({}); };

  openEdit(container, 'Account PAT');
  const select = scopeSelect(container);
  assert.ok(select, 'the Edit dialog must expose a scope picker');
  assert.equal(select.disabled, false);
  assert.equal(select.value, 'account-1');
  // An Account credential can only stay or widen — never jump to another Account.
  assert.deepEqual(optionLabels(select), ['Not set (Global — every Account)', 'Account One']);

  selectOption(select, 'global');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'credential-ws');
  assert.equal(calls[0].body.scope, 'global');
  assert.equal(calls[0].body.account_id, 'account-1', 'the row’s own owner is the ownership proof');
});

test('an Account credential of another Account proves ownership with its own owner, not the page’s', async (t) => {
  const { container } = await mountManager(t, { credentials: [secondAccountCred], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return secondAccountCred; };

  openEdit(container, 'Second PAT');
  const select = scopeSelect(container);
  assert.equal(select.value, 'account-2');
  assert.deepEqual(optionLabels(select), ['Not set (Global — every Account)', 'Account Two']);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls[0].body.scope, 'account');
  assert.equal(calls[0].body.account_id, 'account-2');
});

test('an admin narrowing a global credential picks the destination Account and sends it', async (t) => {
  const { container } = await mountManager(t, { credentials: [globalCred], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return globalCred; };

  openEdit(container, 'Shared PAT');
  const select = scopeSelect(container);
  assert.equal(select.value, 'global');
  assert.deepEqual(optionLabels(select), ['Not set (Global — every Account)', 'Account One', 'Account Two']);
  selectOption(select, 'account-2');
  assert.match(container.textContent, /Readable only from Account Two\./);
  assert.match(container.textContent, /Every agent run in Account Two gets these/);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.scope, 'account');
  assert.equal(
    calls[0].body.account_id,
    'account-2',
    'a global credential has no account_id of its own — the picked Account is the destination',
  );
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
  assert.match(container.textContent, /Every agent run in every Account gets these/);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(calls[0].body.scope, 'global');
  assert.equal('account_id' in calls[0].body, false);
});

test('without global permission the picker is read-only and inherited globals stay uneditable', async (t) => {
  const { container } = await mountManager(t, {
    credentials: [cred({}), globalCred],
    canManageGlobal: false,
  });

  const globalRow = rowOf(container, 'Shared PAT');
  assert.match(globalRow.textContent, /Inherited \(read-only\)/);
  assert.equal(buttonsByText(globalRow, 'Edit').length, 0);

  openEdit(container, 'Account PAT');
  const select = scopeSelect(container);
  assert.ok(select, 'the row still states which Account owns the credential');
  assert.equal(select.disabled, true, 'only an admin may move a credential between scopes');
});

test('the New Credential dialog has no scope picker — creation scope is the page-level control', async (t) => {
  const { container } = await mountManager(t, { credentials: [], canManageGlobal: true });
  click(buttonsByText(container, '+ New Credential')[0]);
  assert.equal(scopeSelect(container), undefined);
});

test('creating sends the owner picked for new items and the env hint names it', async (t) => {
  const { container } = await mountManager(t, { credentials: [], createAccountId: 'account-2' });
  const calls = [];
  api.createCredential = async (body) => { calls.push(body); return cred({ account_id: 'account-2' }); };

  click(buttonsByText(container, '+ New Credential')[0]);
  assert.match(container.textContent, /Every agent run in Account Two gets these/);
  typeInto(container.querySelector('input[placeholder="e.g. My GitHub PAT"]'), 'New PAT');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].scope, 'account');
  assert.equal(calls[0].account_id, 'account-2');
});

test('creating with Global picked sends scope global and no account', async (t) => {
  const { container } = await mountManager(t, { credentials: [], createAccountId: null, canManageGlobal: true });
  const calls = [];
  api.createCredential = async (body) => { calls.push(body); return globalCred; };

  click(buttonsByText(container, '+ New Credential')[0]);
  assert.match(container.textContent, /Every agent run in every Account gets these/);
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

test('the page-level owner select offers Global only under admin.global_credentials for credentials', () => {
  assert.match(pageSource, /kind === 'credentials'\s*\?\s*hasPermission\('admin\.global_credentials'\)/);
  assert.match(pageSource, /createOwnerOptions\(ownerAccounts, canManageGlobalHere\)/);
  assert.match(pageSource, /resolveCreateOwner\(pickedOwner, ownerAccounts, canManageGlobalHere\)/);
  assert.match(pageSource, /canManageGlobal: canManageGlobalHere/);
  assert.doesNotMatch(
    pageSource,
    /canManageGlobal: hasPermission\('admin\.access'\)/,
    'the credentials gate must not fall back to the permission the server never checks',
  );
  // The catalog managers are no longer handed the hidden default account.
  assert.doesNotMatch(pageSource, /accountName=/);
  assert.doesNotMatch(pageSource, /api\.getAccount\(/);
});
