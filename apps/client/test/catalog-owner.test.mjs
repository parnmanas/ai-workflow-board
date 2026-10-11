// The Functions / Credentials / Resources pages used to be scoped to a hidden
// "current account" (AuthContext's creation default — the localStorage value or
// simply the first accessible account). Their lists showed "Global + that one
// account" and "Account for new item" offered only that account, so a user saw
// an account name appear with no way to choose it.
//
// docs/ownership.md: lists aggregate accessible accounts and a supplied
// authorized owner chooses the owner of new work. These tests pin the owner
// logic (catalogOwner.logic.ts) and the page/manager wiring around it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, React, act, run } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api.ts';
import AccountManagementPage from '../src/components/AccountManagementPage.tsx';
import FunctionManager from '../src/components/admin/FunctionManager.tsx';
import ResourceManager from '../src/components/admin/ResourceManager.tsx';
import {
  GLOBAL_OWNER_VALUE,
  agentEnvOwnerLabel,
  catalogOwnerLabel,
  createOwnerOptions,
  credentialScopeOptions,
  credentialUpdateScope,
  credentialsUsableBy,
  defaultCreateOwner,
  globalRunAccount,
  ownerToSelectValue,
  resolveCreateOwner,
  selectValueToOwner,
} from '../src/components/admin/catalogOwner.logic.ts';

const ACCOUNTS = [
  { id: 'account-1', name: 'Account One' },
  { id: 'account-2', name: 'TXIV' },
];

// ─── pure logic ─────────────────────────────────────────

test('owner labels: the account name, Global for NULL, a short id when the name is unknown', () => {
  assert.equal(catalogOwnerLabel('account-2', ACCOUNTS), 'TXIV');
  assert.equal(catalogOwnerLabel(null, ACCOUNTS), 'Global');
  assert.equal(catalogOwnerLabel(undefined, ACCOUNTS), 'Global');
  assert.equal(catalogOwnerLabel('0123456789abcdef', ACCOUNTS), 'Account 01234567');
  assert.equal(catalogOwnerLabel('account-1', [{ id: 'account-1', name: '  ' }]), 'Account account-');
});

test('select values round-trip, with Global as its own sentinel', () => {
  assert.equal(ownerToSelectValue(null), GLOBAL_OWNER_VALUE);
  assert.equal(ownerToSelectValue('account-1'), 'account-1');
  assert.equal(selectValueToOwner(GLOBAL_OWNER_VALUE), null);
  assert.equal(selectValueToOwner(''), null);
  assert.equal(selectValueToOwner('account-1'), 'account-1');
});

test('"Account for new item" offers Global only when permitted, then every accessible account by name', () => {
  assert.deepEqual(createOwnerOptions(ACCOUNTS, true), [
    { accountId: null, label: 'Not set (Global)' },
    { accountId: 'account-1', label: 'Account One' },
    { accountId: 'account-2', label: 'TXIV' },
  ]);
  assert.deepEqual(createOwnerOptions(ACCOUNTS, false).map((o) => o.accountId), ['account-1', 'account-2']);
});

test('the default owner is Global when permitted, otherwise the first accessible account', () => {
  assert.equal(defaultCreateOwner(ACCOUNTS, true), null);
  assert.equal(defaultCreateOwner(ACCOUNTS, false), 'account-1');
  assert.equal(defaultCreateOwner([], false), null);
});

test('a pick is kept only while it is still offered', () => {
  assert.equal(resolveCreateOwner(undefined, ACCOUNTS, true), null);
  assert.equal(resolveCreateOwner(undefined, ACCOUNTS, false), 'account-1');
  assert.equal(resolveCreateOwner('account-2', ACCOUNTS, true), 'account-2');
  assert.equal(resolveCreateOwner(null, ACCOUNTS, true), null);
  // Global picked, then the permission went away.
  assert.equal(resolveCreateOwner(null, ACCOUNTS, false), 'account-1');
  // An account the user can no longer access.
  assert.equal(resolveCreateOwner('account-gone', ACCOUNTS, false), 'account-1');
  assert.equal(resolveCreateOwner('account-gone', ACCOUNTS, true), null);
});

test('credential scope picker: Global → any account; an account credential → Global or its own owner only', () => {
  assert.deepEqual(credentialScopeOptions(null, ACCOUNTS).map((o) => o.accountId), [null, 'account-1', 'account-2']);
  assert.deepEqual(credentialScopeOptions('account-2', ACCOUNTS), [
    { accountId: null, label: 'Not set (Global — every Account)' },
    { accountId: 'account-2', label: 'TXIV' },
  ]);
});

test('credential PATCH scope: the row owner proves ownership, the picked account is a narrowing destination', () => {
  assert.deepEqual(credentialUpdateScope('account-2', 'account-2'), { scope: 'account', account_id: 'account-2' });
  assert.deepEqual(credentialUpdateScope('account-2', null), { scope: 'global', account_id: 'account-2' });
  assert.deepEqual(credentialUpdateScope(null, 'account-1'), { scope: 'account', account_id: 'account-1' });
  assert.deepEqual(credentialUpdateScope(null, null), { scope: 'global' });
  // Never a direct account → other account move: the proof stays the row owner.
  assert.deepEqual(credentialUpdateScope('account-2', 'account-1'), { scope: 'account', account_id: 'account-2' });
});

test('agent env hint names the account that will get the variables', () => {
  assert.equal(agentEnvOwnerLabel(null, ACCOUNTS), 'every Account');
  assert.equal(agentEnvOwnerLabel('account-2', ACCOUNTS), 'TXIV');
});

test('a Resource binds Global credentials and its own account’s only', () => {
  const creds = [
    { id: 'g', account_id: null },
    { id: 'one', account_id: 'account-1' },
    { id: 'two', account_id: 'account-2' },
  ];
  assert.deepEqual(credentialsUsableBy(creds, 'account-2').map((c) => c.id), ['g', 'two']);
  assert.deepEqual(credentialsUsableBy(creds, null).map((c) => c.id), ['g']);
});

test('Global Functions run in the picked account, else the owner for new items, else the first account', () => {
  assert.equal(globalRunAccount('account-2', 'account-1', ACCOUNTS), 'account-2');
  assert.equal(globalRunAccount(null, 'account-2', ACCOUNTS), 'account-2');
  assert.equal(globalRunAccount(null, null, ACCOUNTS), 'account-1');
  assert.equal(globalRunAccount('account-gone', null, ACCOUNTS), 'account-1');
  assert.equal(globalRunAccount(null, null, []), null);
});

// ─── wiring ─────────────────────────────────────────────

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
}

function selectOption(select, value) {
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(select), 'value')?.set;
    setter.call(select, value);
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function flush() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

/** Mounts `element` signed in as a user holding `permissions` with ACCOUNTS. */
async function mountSignedIn(t, element, { permissions = [], role = 'user', stubs = {} } = {}) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  const { uninstall } = installFakeEventSource();
  localStorage.setItem('auth_token', 'session');

  const originals = { getMe: api.getMe, getSetupStatus: api.getSetupStatus };
  for (const key of Object.keys(stubs)) originals[key] = api[key];
  api.getMe = async () => ({
    id: 'user-1', name: 'User', email: 'user@example.test', role, status: 'active',
    permissions, resolved_permissions: permissions,
    accounts: ACCOUNTS.map((a) => ({ ...a, slug: null, relations: ['member'] })),
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  Object.assign(api, stubs);

  const view = mountWithBoardStream(element, {
    wrap: (tree) => React.createElement(MemoryRouter, null, tree),
  });
  await flush();
  await flush();

  t.after(() => { view.unmount(); uninstall(); Object.assign(api, originals); dom.cleanup(); });
  return view;
}

function ownerSelect(container) {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent.startsWith('Account for new item'));
  assert.ok(label, 'the page must render the "Account for new item" control');
  return label.querySelector('select');
}

test('Credentials page: Global + every accessible account, Global by default, and the pick reaches creation', async (t) => {
  const listCalls = [];
  const created = [];
  const { container } = await mountSignedIn(t, React.createElement(AccountManagementPage, { kind: 'credentials' }), {
    permissions: ['admin.credentials', 'admin.global_credentials'],
    stubs: {
      listCredentials: async (...args) => { listCalls.push(args); return []; },
      createCredential: async (body) => { created.push(body); return { id: 'c', account_id: body.account_id ?? null }; },
    },
  });

  const select = ownerSelect(container);
  assert.deepEqual([...select.options].map((o) => o.textContent.trim()), ['Not set (Global)', 'Account One', 'TXIV']);
  assert.equal(select.value, 'global');
  // The list is never scoped by the page's account.
  assert.ok(listCalls.length > 0);
  assert.ok(listCalls.every(([accountId]) => accountId === undefined), JSON.stringify(listCalls));

  selectOption(select, 'account-2');
  click(buttonsByText(container, '+ New Credential')[0]);
  assert.match(container.textContent, /Every agent run in TXIV gets these/);
  const name = container.querySelector('input[placeholder="e.g. My GitHub PAT"]');
  run(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name), 'value').set.call(name, 'PAT');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(created.length, 1);
  assert.equal(created[0].scope, 'account');
  assert.equal(created[0].account_id, 'account-2');
});

test('Credentials page without admin.global_credentials: no Global option, first account by default', async (t) => {
  const { container } = await mountSignedIn(t, React.createElement(AccountManagementPage, { kind: 'credentials' }), {
    permissions: ['admin.credentials', 'admin.access'],
    stubs: { listCredentials: async () => [] },
  });
  const select = ownerSelect(container);
  assert.deepEqual([...select.options].map((o) => o.value), ['account-1', 'account-2']);
  assert.equal(select.value, 'account-1');
});

test('Resources: owner per row, delete with the row’s owner, credentials narrowed to the row owner', async (t) => {
  const resource = (id, accountId, name) => ({
    id, account_id: accountId, scope: accountId ? 'account' : 'global', name, description: '', type: 'link',
    url: '', content: '', file_data: '', file_name: '', file_mimetype: '', tags: [], credential_id: null,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  });
  const credential = (id, accountId) => ({
    id, account_id: accountId, scope: accountId ? 'account' : 'global', name: `cred ${id}`, provider: 'github',
    description: '', credential_fields: {}, credential_status: 'ok', created_at: '', updated_at: '',
  });
  const listCalls = [];
  const deleted = [];
  const { container } = await mountSignedIn(t, React.createElement(ResourceManager, {
    catalogMode: true, createAccountId: 'account-1', accounts: ACCOUNTS, canManageGlobal: true,
  }), {
    stubs: {
      listResources: async (...args) => { listCalls.push(['resources', ...args]); return [resource('r2', 'account-2', 'Two doc'), resource('rg', null, 'Global doc')]; },
      listCredentials: async (...args) => { listCalls.push(['credentials', ...args]); return [credential('g', null), credential('one', 'account-1'), credential('two', 'account-2')]; },
      deleteResource: async (id, accountId) => { deleted.push({ id, accountId }); return { success: true, id }; },
    },
  });

  assert.ok(listCalls.every((call) => call[1] === undefined), JSON.stringify(listCalls));
  const row = container.querySelector('[data-testid="resource-row-r2"]');
  assert.match(row.textContent, /TXIV · Link/);
  assert.match(container.querySelector('[data-testid="resource-row-rg"]').textContent, /Global · Link/);

  click(row);
  assert.match(container.textContent, /Owner\s*TXIV/);
  click(buttonsByText(container, 'Edit')[0]);
  const credentialSelect = [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'g'));
  assert.deepEqual([...credentialSelect.options].map((o) => o.value), ['', 'g', 'two']);
  click(buttonsByText(container, 'Cancel')[0]);

  click(buttonsByText(container, 'Delete')[0]);
  await act(async () => { click(buttonsByText(container, 'Delete Resource')[0]); });
  assert.deepEqual(deleted, [{ id: 'r2', accountId: 'account-2' }]);
});

test('Functions: aggregated list and runs, owner per row, Account Functions run in their owner', async (t) => {
  const fn = (id, accountId, key) => ({
    id, account_id: accountId, scope: accountId ? 'account' : 'global', key, name: key, description: '', version: 1,
    executor_type: 'builtin', risk_level: 'read', idempotency_mode: 'none', approval_policy: 'none',
    timeout_ms: 1000, max_attempts: 1, enabled: true, builtin: false, input_schema: {}, output_schema: {}, config: {},
  });
  const calls = { list: [], runs: [], run: [], update: [] };
  const { container } = await mountSignedIn(t, React.createElement(FunctionManager, {
    catalogMode: true, createAccountId: null, accounts: ACCOUNTS, canManageGlobal: true,
  }), {
    stubs: {
      listFunctions: async (...args) => { calls.list.push(args); return [fn('f2', 'account-2', 'two.fn'), fn('fg', null, 'global.fn')]; },
      listFunctionRuns: async (...args) => {
        calls.runs.push(args);
        return [{ id: 'run-1', function_key: 'two.fn', account_id: 'account-2', status: 'succeeded', created_at: new Date().toISOString() }];
      },
      runFunction: async (id, body) => { calls.run.push({ id, body }); return { status: 'succeeded' }; },
      updateFunction: async (id, body) => { calls.update.push({ id, body }); return fn(id, body.account_id, body.key); },
    },
  });

  assert.equal(calls.list[0][0], null, 'no account filter on the list');
  assert.equal(calls.runs[0][0], null, 'no account filter on recent runs');
  assert.equal(container.querySelector('[data-testid="function-owner-f2"]').textContent, 'TXIV');
  assert.equal(container.querySelector('[data-testid="function-owner-fg"]').textContent, 'Global');
  assert.match(container.textContent, /two\.fnTXIVsucceeded/);

  const runButtons = buttonsByText(container, 'Run');
  await act(async () => { click(runButtons[0]); });
  // Global picked for new items → a Global Function runs in the first account until one is picked.
  const runSelect = [...container.querySelectorAll('label')]
    .find((l) => l.textContent.startsWith('Run Global Functions in')).querySelector('select');
  assert.equal(runSelect.value, 'account-1');
  selectOption(runSelect, 'account-2');
  await act(async () => { click(buttonsByText(container, 'Run')[1]); });
  assert.deepEqual(calls.run.map((c) => [c.id, c.body.account_id]), [['f2', 'account-2'], ['fg', 'account-2']]);

  click(buttonsByText(container, 'Edit')[0]);
  await act(async () => { click(buttonsByText(container, 'Save')[0]); });
  assert.equal(calls.update[0].id, 'f2');
  assert.equal(calls.update[0].body.account_id, 'account-2', 'an edit keeps the row’s own owner');
  assert.equal(calls.update[0].body.scope, 'account');
});
