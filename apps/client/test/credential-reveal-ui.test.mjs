import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { setupDom, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { installFakeEventSource, mountWithBoardStream } from './helpers/boardStream.mjs';
import { api } from '../src/api.ts';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

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
  const { uninstall } = installFakeEventSource();
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

  const view = mountWithBoardStream(
    React.createElement(CredentialManager, { workspaceId: 'workspace-1' }),
  );
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

  t.after(() => {
    view.unmount();
    uninstall();
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
  typeInto(input, password);
}

test('Reveal is not offered for non-OAuth credential providers', async (t) => {
  const { container } = await mountCredentialManager(t);
  assert.equal(buttonsByText(container, 'Reveal').length, 2);
  const nonOAuthRow = [...container.querySelectorAll('tr')]
    .find((row) => row.textContent?.includes('Non OAuth API Key'));
  assert.ok(nonOAuthRow);
  assert.equal(buttonsByText(nonOAuthRow, 'Reveal').length, 0);
});

// 티켓 a9e2b1af: enterRevealPassword() 는 기존에 React onChange 를 태우지 못하는 하네스
// 결함이 있어, 아래 두 테스트를 포함한 이 파일의 인터랙션 테스트들이 "Confirm and Reveal"
// 클릭 시 revealPassword state 가 빈 문자열이라 api.revealCredential 자체가 호출되지 않는
// 채로도(CredentialManager.tsx 의 `if (!revealTarget || !revealPassword) return;` 가드에
// 막혀) 통과해왔다. 타이핑한 값이 실제로 API 호출 인자까지 도달하는지 여기서 직접 잠근다.
test('타이핑한 reveal 비밀번호가 그대로 api.revealCredential 에 전달된다(하네스 타이핑 결함 회귀 가드)', async (t) => {
  const { container } = await mountCredentialManager(t);
  const revealCalls = [];
  api.revealCredential = (id, password) => {
    revealCalls.push({ id, password });
    return new Promise(() => {}); // 이 테스트는 호출 인자만 검증한다 — resolve 는 불필요.
  };

  click(buttonsByText(container, 'Reveal')[0]);
  enterRevealPassword(container, 'typed-secret-password');
  click(buttonsByText(container, 'Confirm and Reveal')[0]);

  assert.deepEqual(
    revealCalls,
    [{ id: 'credential-a', password: 'typed-secret-password' }],
    'enterRevealPassword 로 타이핑한 값이 실제 React state 를 거쳐 API 호출 인자로 전달되어야 한다',
  );
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
