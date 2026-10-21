// Catalogs have no workspace/scope controls; ownership remains internal to requests.

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, click, React, act, run } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api.ts';
import AccountManagementPage from '../src/components/AccountManagementPage.tsx';
import FunctionManager from '../src/components/admin/FunctionManager.tsx';
import ResourceManager from '../src/components/admin/ResourceManager.tsx';
import { SharedMemoryPanel } from '../src/components/knowledge/KnowledgeMemoryPanels.tsx';
import { credentialsUsableBy, defaultCreateOwner } from '../src/components/admin/catalogOwner.logic.ts';

const ACCOUNTS = [
  { id: 'account-1', name: 'Account One' },
  { id: 'account-2', name: 'TXIV' },
];

// ─── pure logic ─────────────────────────────────────────

test('the default owner is Global when permitted, otherwise the first accessible account', () => {
  assert.equal(defaultCreateOwner(ACCOUNTS, true), null);
  assert.equal(defaultCreateOwner(ACCOUNTS, false), 'account-1');
  assert.equal(defaultCreateOwner([], false), null);
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

// ─── wiring ─────────────────────────────────────────────

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);
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

function assertNoOwnershipUi(container) {
  assert.doesNotMatch(container.textContent, /Account for new item|Run Global Functions in|Account One|TXIV|Scope|Owner/);
  for (const select of container.querySelectorAll('select')) {
    assert.ok([...select.options].every((option) => !['account-1', 'account-2', 'global'].includes(option.value)));
  }
}

test('Credentials page aggregates without an owner picker and creates shared credentials when permitted', async (t) => {
  const listCalls = [];
  const created = [];
  const { container } = await mountSignedIn(t, React.createElement(AccountManagementPage, { kind: 'credentials' }), {
    permissions: ['admin.credentials', 'admin.global_credentials'],
    stubs: {
      listCredentials: async (...args) => { listCalls.push(args); return []; },
      createCredential: async (body) => { created.push(body); return { id: 'c', account_id: body.account_id ?? null }; },
    },
  });

  assertNoOwnershipUi(container);
  // The list is never scoped by the page's account.
  assert.ok(listCalls.length > 0);
  assert.ok(listCalls.every(([accountId]) => accountId === undefined), JSON.stringify(listCalls));

  click(buttonsByText(container, '+ New Credential')[0]);
  assertNoOwnershipUi(container);
  const name = container.querySelector('input[placeholder="e.g. My GitHub PAT"]');
  run(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name), 'value').set.call(name, 'PAT');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(created.length, 1);
  assert.equal(created[0].scope, 'global');
  assert.equal(created[0].account_id, undefined);
});

test('Credentials page without global permission creates in the automatic account without showing a picker', async (t) => {
  const created = [];
  const { container } = await mountSignedIn(t, React.createElement(AccountManagementPage, { kind: 'credentials' }), {
    permissions: ['admin.credentials', 'admin.access'],
    stubs: {
      listCredentials: async () => [],
      createCredential: async (body) => { created.push(body); return { id: 'c' }; },
    },
  });
  assertNoOwnershipUi(container);
  click(buttonsByText(container, '+ New Credential')[0]);
  const name = container.querySelector('input[placeholder="e.g. My GitHub PAT"]');
  run(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(name), 'value').set.call(name, 'PAT');
    name.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assertNoOwnershipUi(container);
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(created[0].scope, 'account');
  assert.equal(created[0].account_id, 'account-1');
});

for (const kind of ['resources', 'functions']) {
  test(`${kind} page does not render legacy ownership controls`, async (t) => {
    const { container } = await mountSignedIn(t, React.createElement(AccountManagementPage, { kind }), {
      role: 'admin',
      stubs: {
        listResources: async () => [], listCredentials: async () => [],
        listFunctions: async () => [], listFunctionRuns: async () => [],
      },
    });
    assertNoOwnershipUi(container);
  });
}

test('Resources: no owner labels, writes and credential choices retain the row’s authorization', async (t) => {
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
    catalogMode: true, createAccountId: 'account-1', canManageGlobal: true,
  }), {
    stubs: {
      listResources: async (...args) => { listCalls.push(['resources', ...args]); return [resource('r2', 'account-2', 'Two doc'), resource('rg', null, 'Global doc')]; },
      listCredentials: async (...args) => { listCalls.push(['credentials', ...args]); return [credential('g', null), credential('one', 'account-1'), credential('two', 'account-2')]; },
      deleteResource: async (id, accountId) => { deleted.push({ id, accountId }); return { success: true, id }; },
    },
  });

  assert.ok(listCalls.every((call) => call[1] === undefined), JSON.stringify(listCalls));
  const row = container.querySelector('[data-testid="resource-row-r2"]');
  assert.match(row.textContent, /Link/);
  assertNoOwnershipUi(container);
  assert.match(container.querySelector('[data-testid="resource-row-rg"]').textContent, /Link/);

  click(row);
  assertNoOwnershipUi(container);
  click(buttonsByText(container, 'Edit')[0]);
  const credentialSelect = [...container.querySelectorAll('select')]
    .find((s) => [...s.options].some((o) => o.value === 'g'));
  assert.deepEqual([...credentialSelect.options].map((o) => o.value), ['', 'g', 'two']);
  assertNoOwnershipUi(container);
  click(buttonsByText(container, 'Cancel')[0]);

  click(buttonsByText(container, 'Delete')[0]);
  await act(async () => { click(buttonsByText(container, 'Delete Resource')[0]); });
  assert.deepEqual(deleted, [{ id: 'r2', accountId: 'account-2' }]);
});

test('Functions: no owner picker or labels; automatic execution uses function or ticket ownership', async (t) => {
  const fn = (id, accountId, key) => ({
    id, account_id: accountId, scope: accountId ? 'account' : 'global', key, name: key, description: '', version: 1,
    executor_type: 'builtin', risk_level: 'read', idempotency_mode: 'none', approval_policy: 'none',
    timeout_ms: 1000, max_attempts: 1, enabled: true, builtin: false, input_schema: {}, output_schema: {}, config: {},
  });
  const calls = { list: [], runs: [], run: [], update: [] };
  let ticketAccount = 'account-2';
  const { container } = await mountSignedIn(t, React.createElement(FunctionManager, {
    catalogMode: true, createAccountId: null, canManageGlobal: true,
  }), {
    stubs: {
      listFunctions: async (...args) => { calls.list.push(args); return [fn('f2', 'account-2', 'two.fn'), fn('fg', null, 'global.fn')]; },
      listFunctionRuns: async (...args) => {
        calls.runs.push(args);
        return [{ id: 'run-1', function_key: 'two.fn', account_id: 'account-2', status: 'succeeded', created_at: new Date().toISOString() }];
      },
      getTicket: async () => ({ id: 'ticket-2', account_id: ticketAccount }),
      runFunction: async (id, body) => { calls.run.push({ id, body }); return { status: 'succeeded' }; },
      updateFunction: async (id, body) => { calls.update.push({ id, body }); return fn(id, body.account_id, body.key); },
    },
  });

  assert.equal(calls.list[0][0], null, 'no account filter on the list');
  assert.equal(calls.runs[0][0], null, 'no account filter on recent runs');
  assertNoOwnershipUi(container);
  const runButtons = buttonsByText(container, 'Run');
  await act(async () => { click(runButtons[0]); });
  await act(async () => { click(buttonsByText(container, 'Run')[1]); });
  assert.deepEqual(calls.run.map((c) => [c.id, c.body.account_id]), [['f2', 'account-2'], ['fg', 'account-1']]);

  const ticketInput = [...container.querySelectorAll('label')].find((label) => label.textContent.startsWith('Ticket ID')).querySelector('input');
  run(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(ticketInput), 'value').set.call(ticketInput, 'ticket-2');
    ticketInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => { click(buttonsByText(container, 'Run')[1]); });
  assert.equal(calls.run.at(-1).body.account_id, 'account-2');
  assert.equal(calls.run.at(-1).body.ticket_id, 'ticket-2');
  // A ticket lookup does not change an account-owned Function's execution owner.
  ticketAccount = 'account-1';
  await act(async () => { click(buttonsByText(container, 'Run')[0]); });
  assert.equal(calls.run.at(-1).body.account_id, 'account-2');

  click(buttonsByText(container, 'Edit')[0]);
  await act(async () => { click(buttonsByText(container, 'Save')[0]); });
  assert.equal(calls.update[0].id, 'f2');
  assert.equal(calls.update[0].body.account_id, 'account-2', 'an edit keeps the row’s own owner');
  assert.equal(calls.update[0].body.scope, 'account');
});

test('shared memory uses the automatic account without showing the legacy account list', async (t) => {
  const reads = [];
  const writes = [];
  const { container } = await mountSignedIn(t, React.createElement(SharedMemoryPanel), {
    stubs: {
      getAccount: async (id) => { reads.push(id); return { id, name: 'Account One', knowledge_memory: 'Original' }; },
      listSkillAssignments: async () => [],
      listMemoryHosts: async () => [],
      updateAccount: async (id, body) => { writes.push({ id, body }); return body; },
    },
  });
  assertNoOwnershipUi(container);
  assert.deepEqual(reads, ['account-1']);
  const memory = container.querySelector('textarea');
  run(() => {
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(memory), 'value').set.call(memory, 'Updated');
    memory.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await act(async () => { click(buttonsByText(container, 'Save')[0]); });
  assert.deepEqual(writes, [{ id: 'account-1', body: { knowledge_memory: 'Updated' } }]);
});
