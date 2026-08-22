import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, mount, click, run, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

// CredentialManager가 이제 CliAutoLogin(티켓 b2e79108)을 무조건 렌더링하고, 이 컴포넌트는
// useBoardStreamEvent로 BoardStreamProvider를 요구한다. BoardStreamProvider의 내부 pub/sub
// 버스는 Node 전역 EventTarget이라 setupDom이 덮어쓰는 jsdom Event/CustomEvent를 거부하므로
// (smoke-artifact-close-on-navigate.test.mjs와 동일 처리), 마운트 전 pristine Node 생성자를
// 붙잡아 setupDom 후 복원한다 — 이 파일은 DOM 이벤트를 전부 window.Event로 디스패치해 안전하다.
const NodeEvent = globalThis.Event;
const NodeCustomEvent =
  globalThis.CustomEvent ||
  class CustomEvent extends NodeEvent {
    constructor(type, opts = {}) {
      super(type, opts);
      this.detail = opts.detail ?? null;
    }
  };

class FakeEventSource {
  static CLOSED = 2;
  constructor() {
    this.readyState = 1;
    this.onopen = null;
    this.onerror = null;
  }
  addEventListener() {}
  removeEventListener() {}
  close() {
    this.readyState = 2;
  }
}

const source = fs.readFileSync(
  new URL('../src/components/admin/CredentialManager.tsx', import.meta.url),
  'utf8',
);
const apiSource = fs.readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8');

test('Reveal is rendered only for admin users and requires explicit confirmation', () => {
  assert.match(source, /user\?\.role === 'admin' && c\.provider === 'claude_oauth_token'/);
  assert.match(source, /Confirm and Reveal/);
  assert.match(source, /type="password"/);
  assert.match(source, /api\.revealCredential\(targetId, revealPassword\)/);
});

test('revealed secret auto-clears after 30 seconds and modal close/unmount clear state', () => {
  assert.match(source, /CREDENTIAL_REVEAL_TTL_MS = 30_000/);
  assert.match(source, /setTimeout\(clearRevealedSecret, CREDENTIAL_REVEAL_TTL_MS\)/);
  assert.match(source, /useEffect\(\(\) => \(\) => \{\s*revealRequestGeneration\.current \+= 1;\s*clearRevealedSecret\(\)/);
  assert.match(source, /const closeReveal = \(\) => \{\s*invalidateRevealRequest\(\);\s*clearRevealedSecret\(\)/);
  assert.match(source, /setRevealedFields\(\{\}\)/);
  assert.match(source, /setRevealPassword\(''\)/);
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

const credentials = [
  {
    id: 'credential-a',
    workspace_id: 'workspace-1',
    board_id: null,
    scope: 'workspace',
    name: 'Credential A',
    description: '',
    provider: 'claude_oauth_token',
    credential_fields: { oauth_token: 'sk-a••••tail' },
    credential_status: 'ok',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'credential-b',
    workspace_id: 'workspace-1',
    board_id: null,
    scope: 'workspace',
    name: 'Credential B',
    description: '',
    provider: 'claude_oauth_token',
    credential_fields: { oauth_token: 'sk-b••••tail' },
    credential_status: 'ok',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: 'credential-api-key',
    workspace_id: 'workspace-1',
    board_id: null,
    scope: 'workspace',
    name: 'Non OAuth API Key',
    description: '',
    provider: 'openai',
    credential_fields: { api_key: 'sk-p••••tail' },
    credential_status: 'ok',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

async function mountCredentialManager(t) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  globalThis.sessionStorage = dom.window.sessionStorage;
  dom.window.HTMLElement.prototype.attachEvent = () => {};
  dom.window.HTMLElement.prototype.detachEvent = () => {};
  globalThis.Event = NodeEvent;
  globalThis.CustomEvent = NodeCustomEvent;
  globalThis.EventSource = FakeEventSource;
  localStorage.setItem('auth_token', 'admin-session');

  const originals = {
    getMe: api.getMe,
    getSetupStatus: api.getSetupStatus,
    listCredentials: api.listCredentials,
    revealCredential: api.revealCredential,
  };
  api.getMe = async () => ({
    id: 'admin-1',
    name: 'Admin',
    email: 'admin@example.test',
    role: 'admin',
    status: 'active',
    permissions: [],
    workspaces: [{ id: 'workspace-1', name: 'Workspace', slug: null, relations: [] }],
  });
  api.getSetupStatus = async () => ({ needs_setup: false });
  api.listCredentials = async () => credentials;

  const view = mount(
    React.createElement(
      AuthProvider,
      null,
      React.createElement(
        BoardStreamProvider,
        null,
        React.createElement(CredentialManager, { workspaceId: 'workspace-1' }),
      ),
    ),
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });
  return view;
}

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}

function enterRevealPassword(container, password = 'admin-password') {
  const input = container.querySelector('input[autocomplete="current-password"]');
  assert.ok(input);
  run(() => {
    const setter = Object.getOwnPropertyDescriptor(domWindowInputPrototype(input), 'value')?.set;
    setter?.call(input, password);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
}

function domWindowInputPrototype(input) {
  return Object.getPrototypeOf(input);
}

test('Reveal is not offered for non-OAuth credential providers', async (t) => {
  const { container } = await mountCredentialManager(t);
  assert.equal(buttonsByText(container, 'Reveal').length, 2);
  const nonOAuthRow = [...container.querySelectorAll('tr')]
    .find((row) => row.textContent?.includes('Non OAuth API Key'));
  assert.ok(nonOAuthRow);
  assert.equal(buttonsByText(nonOAuthRow, 'Reveal').length, 0);
});

test('closing while reveal is pending prevents the stale secret from returning', async (t) => {
  const pending = deferred();
  const { container } = await mountCredentialManager(t);
  api.revealCredential = () => pending.promise;

  click(buttonsByText(container, 'Reveal')[0]);
  enterRevealPassword(container);
  click(buttonsByText(container, 'Confirm and Reveal')[0]);
  click(buttonsByText(container, 'Close')[0]);

  await act(async () => {
    pending.resolve({ credential_fields: { oauth_token: 'secret-from-a' } });
    await pending.promise;
  });
  assert.doesNotMatch(container.textContent, /secret-from-a/);
  assert.equal(container.querySelector('input[autocomplete="current-password"]'), null);
});

test('an A response cannot populate B reveal modal after target changes', async (t) => {
  const pendingA = deferred();
  const pendingB = deferred();
  const { container } = await mountCredentialManager(t);
  api.revealCredential = (id) => id === 'credential-a' ? pendingA.promise : pendingB.promise;

  click(buttonsByText(container, 'Reveal')[0]);
  enterRevealPassword(container);
  click(buttonsByText(container, 'Confirm and Reveal')[0]);
  click(buttonsByText(container, 'Close')[0]);
  click(buttonsByText(container, 'Reveal')[1]);

  await act(async () => {
    pendingA.resolve({ credential_fields: { oauth_token: 'secret-from-a' } });
    await pendingA.promise;
  });
  assert.match(container.textContent, /Credential B/);
  assert.doesNotMatch(container.textContent, /secret-from-a/);
  assert.ok(container.querySelector('input[autocomplete="current-password"]'));
});

test('clipboard copy has feedback and secrets are not persisted or placed in URLs', () => {
  assert.match(source, /navigator\.clipboard\.writeText\(value\)/);
  assert.match(source, /Copied to clipboard/);
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.setItem\([^)]*(?:revealedFields|value)/);
  assert.match(apiSource, /method: 'POST',\s*cache: 'no-store'/);
  assert.match(apiSource, /body: JSON\.stringify\(\{ password \}\)/);
  assert.doesNotMatch(apiSource, /reveal\?.*password/);
});
