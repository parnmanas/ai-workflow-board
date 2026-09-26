// Credentials are the one catalog surface where an existing row's scope is
// switchable (global ↔ Workspace) instead of 400-ing. The picker only appears
// on an existing credential — creation scope comes from the page-level
// "Workspace for new item" select in WorkspaceManagementPage — and it is
// read-only for anyone without admin.global_credentials.
//
// The gate matters twice over: WorkspaceManagementPage used to derive it from
// admin.access, which the server never checks, so the UI and the server
// disagreed in both directions.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, click, React, act, run } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

const pageSource = fs.readFileSync(
  new URL('../src/components/WorkspaceManagementPage.tsx', import.meta.url),
  'utf8',
);

function cred(overrides) {
  return {
    id: 'credential-ws',
    workspace_id: 'workspace-1',
    board_id: null,
    scope: 'workspace',
    name: 'Workspace PAT',
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
  workspace_id: null,
  scope: 'global',
  name: 'Shared PAT',
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

async function mountManager(t, { credentials, ...props }) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  const { uninstall } = installFakeEventSource();
  localStorage.setItem('auth_token', 'admin-session');

  const originals = { getMe: api.getMe, getSetupStatus: api.getSetupStatus, listCredentials: api.listCredentials, updateCredential: api.updateCredential };
  api.getMe = async () => ({
    id: 'admin-1', name: 'Admin', email: 'admin@example.test', role: 'admin', status: 'active',
    permissions: [], workspaces: [{ id: 'workspace-1', name: 'Workspace One', slug: null, relations: [] }],
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.listCredentials = async () => credentials;

  const view = mountWithBoardStream(
    React.createElement(CredentialManager, { workspaceId: 'workspace-1', workspaceName: 'Workspace One', ...props }),
  );
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

  t.after(() => { view.unmount(); uninstall(); Object.assign(api, originals); dom.cleanup(); });
  return view;
}

function openEdit(container, rowText) {
  const row = [...container.querySelectorAll('tr')].find((r) => r.textContent?.includes(rowText));
  assert.ok(row, `row "${rowText}" must be rendered`);
  const edit = buttonsByText(row, 'Edit');
  assert.equal(edit.length, 1, `row "${rowText}" must offer Edit`);
  click(edit[0]);
}

test('an admin can widen a Workspace credential to global from the Edit dialog', async (t) => {
  const { container } = await mountManager(t, { credentials: [cred({})], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return cred({}); };

  openEdit(container, 'Workspace PAT');
  const select = scopeSelect(container);
  assert.ok(select, 'the Edit dialog must expose a scope picker');
  assert.equal(select.disabled, false);
  assert.equal(select.value, 'workspace');
  // The destination Workspace is named, not called "Current Workspace".
  assert.ok([...select.options].some((o) => o.textContent.includes('Workspace One')));

  selectOption(select, 'global');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'credential-ws');
  assert.equal(calls[0].body.scope, 'global');
  assert.equal(calls[0].body.workspace_id, 'workspace-1');
});

test('an admin narrowing a global credential sends the viewed Workspace as the destination', async (t) => {
  const { container } = await mountManager(t, { credentials: [globalCred], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return globalCred; };

  openEdit(container, 'Shared PAT');
  const select = scopeSelect(container);
  assert.equal(select.value, 'global');
  selectOption(select, 'workspace');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.scope, 'workspace');
  assert.equal(
    calls[0].body.workspace_id,
    'workspace-1',
    'a global credential has no workspace_id of its own — the viewed Workspace is the destination',
  );
});

test('a scope-unchanged save keeps sending the credential’s own scope', async (t) => {
  const { container } = await mountManager(t, { credentials: [cred({})], canManageGlobal: true });
  const calls = [];
  api.updateCredential = async (id, body) => { calls.push({ id, body }); return cred({}); };

  openEdit(container, 'Workspace PAT');
  await act(async () => { click(buttonsByText(container, 'Save Credential')[0]); });
  assert.equal(calls[0].body.scope, 'workspace');
  assert.equal(calls[0].body.workspace_id, 'workspace-1');
});

test('without global permission the picker is read-only and inherited globals stay uneditable', async (t) => {
  const { container } = await mountManager(t, {
    credentials: [cred({}), globalCred],
    canManageGlobal: false,
  });

  const globalRow = [...container.querySelectorAll('tr')].find((r) => r.textContent?.includes('Shared PAT'));
  assert.match(globalRow.textContent, /Inherited \(read-only\)/);
  assert.equal(buttonsByText(globalRow, 'Edit').length, 0);

  openEdit(container, 'Workspace PAT');
  const select = scopeSelect(container);
  assert.ok(select, 'the row still states which Workspace owns the credential');
  assert.equal(select.disabled, true, 'only an admin may move a credential between scopes');
});

test('the New Credential dialog has no scope picker — creation scope is the page-level control', async (t) => {
  const { container } = await mountManager(t, { credentials: [], canManageGlobal: true });
  click(buttonsByText(container, '+ New Credential')[0]);
  assert.equal(scopeSelect(container), undefined);
});

test('the page-level global option is gated on admin.global_credentials for credentials', () => {
  assert.match(pageSource, /kind === 'credentials'\s*\?\s*hasPermission\('admin\.global_credentials'\)/);
  assert.match(pageSource, /\{canManageGlobalHere && <option value="global">/);
  assert.match(pageSource, /canManageGlobal: canManageGlobalHere/);
  assert.doesNotMatch(
    pageSource,
    /canManageGlobal: hasPermission\('admin\.access'\)/,
    'the credentials gate must not fall back to the permission the server never checks',
  );
});
