import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
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
  new URL('../src/components/admin/CliCredentialImport.tsx', import.meta.url),
  'utf8',
);
const credentialManagerSource = fs.readFileSync(
  new URL('../src/components/admin/CredentialManager.tsx', import.meta.url),
  'utf8',
);
const resourceManagerSource = fs.readFileSync(
  new URL('../src/components/admin/ResourceManager.tsx', import.meta.url),
  'utf8',
);

test('Credentials exposes the Codex and Claude CLI login credential importer, wired to refresh its own list', () => {
  assert.match(credentialManagerSource, /<CliCredentialImport/);
  assert.match(credentialManagerSource, /onCreated=\{loadCredentials\}/);
  assert.match(source, /codex login/);
  assert.match(source, /claude auth login/);
  assert.match(source, /~\/\.codex\/auth\.json/);
  assert.match(source, /~\/\.claude\/\.credentials\.json/);
});

test('the importer is no longer rendered on the Resources page (weak adjacency — see ticket bd1c767a)', () => {
  assert.doesNotMatch(resourceManagerSource, /<CliCredentialImport/);
  assert.doesNotMatch(resourceManagerSource, /CliCredentialImport'/);
});

test('CLI login imports use the existing encrypted subscription credential API', () => {
  assert.match(source, /provider: 'codex_subscription'/);
  assert.match(source, /field: 'auth_json'/);
  assert.match(source, /provider: 'claude_subscription'/);
  assert.match(source, /field: 'credentials_json'/);
  assert.match(source, /await api\.createCredential\(/);
  assert.match(source, /validateJsonFile\(credentialJson\)/);
});

test('Codex config is optional and credential scope follows the host page scope selection', () => {
  assert.match(source, /config_toml: configToml/);
  assert.match(source, /scope: createScope === 'global' \? 'global' : 'workspace'/);
  assert.match(source, /workspace_id: createScope === 'global' \? undefined : workspaceId/);
});

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountCredentialManagerForImport(t) {
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
    createCredential: api.createCredential,
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

  // Backend 상태를 흉내: import 전에는 목록이 비어 있고, createCredential 이
  // 성공하면 다음 listCredentials 호출부터 새 credential 이 포함된다 — 실제
  // 서버 라운드트립 없이도 "생성 즉시 같은 화면 목록에 나타난다" 를 검증한다.
  let credentialsDb = [];
  const createCredentialCalls = [];
  api.listCredentials = async () => credentialsDb.slice();
  api.createCredential = async (data) => {
    createCredentialCalls.push(data);
    const created = {
      id: 'cred-imported-1',
      workspace_id: data.workspace_id ?? null,
      board_id: null,
      scope: data.scope || 'workspace',
      name: data.name,
      description: data.description || '',
      provider: data.provider,
      credential_fields: data.credentials,
      credential_status: 'ok',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    credentialsDb = [...credentialsDb, created];
    return created;
  };

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
  await flush();

  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });
  return { ...view, createCredentialCalls };
}

test('importing a CLI login credential from the Credentials page appears in the same list immediately', async (t) => {
  const { container, createCredentialCalls } = await mountCredentialManagerForImport(t);

  assert.equal(buttonsByText(container, 'Import from File').length, 1);
  assert.doesNotMatch(container.textContent, /Codex CLI login/);

  click(buttonsByText(container, 'Import from File')[0]);

  const fileInput = container.querySelector('input[type="file"][accept*="json"]');
  assert.ok(fileInput, 'credential file input should be present once the importer is open');
  const authFile = new window.File(['{"tokens":{"access_token":"abc"}}'], 'auth.json', { type: 'application/json' });
  await act(async () => {
    Object.defineProperty(fileInput, 'files', { value: [authFile], configurable: true });
    fileInput.dispatchEvent(new window.Event('change', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // Selecting the file auto-fills the credential name — no typing needed.
  assert.match(container.textContent, /Selected: auth\.json/);

  const createButton = buttonsByText(container, 'Create Credential')[0];
  assert.ok(createButton);
  await act(async () => {
    createButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(createCredentialCalls.length, 1);
  assert.equal(createCredentialCalls[0].scope, 'workspace');
  assert.equal(createCredentialCalls[0].workspace_id, 'workspace-1');
  assert.equal(createCredentialCalls[0].provider, 'codex_subscription');

  // 모달이 닫히고(= Resources 로 이동하지 않고 같은 화면에서) 새 credential 이
  // 바로 목록에 보인다 — 티켓 bd1c767a 가 고치는 "생성됐다는데 안 보임" 버그의
  // 회귀 방지 단언.
  assert.equal(buttonsByText(container, 'Create Credential').length, 0);
  assert.match(container.textContent, /Codex CLI login/);
  assert.match(container.textContent, /1 credentials/);
});
