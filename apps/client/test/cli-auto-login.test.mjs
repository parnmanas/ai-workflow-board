import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { AuthProvider } from '../src/contexts/AuthContext.tsx';
import { BoardStreamProvider } from '../src/contexts/BoardStreamContext.tsx';
import CredentialManager from '../src/components/admin/CredentialManager.tsx';

// cli-credential-import.test.mjs / credential-reveal-ui.test.mjs와 동일한 이유로
// CredentialManager 마운트 전 pristine Node Event/CustomEvent를 붙잡아 setupDom 후
// 복원한다 — BoardStreamProvider의 pub/sub 버스가 Node 전역 EventTarget이라 jsdom
// Event를 거부한다.
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

function buttonsByText(container, label) {
  return [...container.querySelectorAll('button')].filter((button) => button.textContent?.trim() === label);
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function mountCredentialManagerForAutoLogin(t, { startCliLoginImpl } = {}) {
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
    listCliLoginInstances: api.listCliLoginInstances,
    startCliLogin: api.startCliLogin,
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
  api.listCredentials = async () => [];
  api.listCliLoginInstances = async () => [
    {
      instance_id: 'inst-1',
      hostname: 'host-1',
      workspace_id: 'workspace-1',
      codex_installed: true,
      codex_healthy: true,
      claude_installed: true,
      claude_healthy: true,
    },
  ];
  const startCliLoginCalls = [];
  api.startCliLogin = async (data) => {
    startCliLoginCalls.push(data);
    if (startCliLoginImpl) return startCliLoginImpl(data);
    return {
      id: 'session-1',
      workspace_id: data.workspace_id || '',
      is_global: data.scope === 'global',
      cli: data.cli,
      credential_name: data.credential_name,
      status: 'starting',
      verification_url: null,
      user_code: null,
      raw_output_fallback: null,
      error_detail: '',
      created_credential_id: null,
      created_at: new Date().toISOString(),
      finished_at: null,
    };
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
  return { ...view, startCliLoginCalls };
}

function selects(container) {
  // JSX order: CLI select first, then Runtime Host — see CliAutoLogin.tsx.
  return [...container.querySelectorAll('select')];
}

async function changeSelect(select, value) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('CLI auto-login modal defaults to Codex, offers Claude, and switching provider updates title/description/default name and the cli sent on start (ticket 06b2b990)', async (t) => {
  const { container, startCliLoginCalls } = await mountCredentialManagerForAutoLogin(t);

  click(buttonsByText(container, 'Log in with CLI')[0]);
  await flush();

  assert.match(container.textContent, /Codex Login/);
  assert.match(container.textContent, /codex login --device-auth/);
  const [cliSelect] = selects(container);
  assert.ok(cliSelect, 'expected a CLI provider <select>');
  const nameInput = container.querySelector('input');
  assert.equal(nameInput.value, 'Codex login');

  await changeSelect(cliSelect, 'claude');
  assert.match(container.textContent, /Claude Login/);
  assert.match(container.textContent, /claude auth login/);
  assert.equal(nameInput.value, 'Claude login', 'switching provider must refresh the untouched default name');

  await flush(); // let listCliLoginInstances' auto-select populate Runtime Host
  await act(async () => {
    click(buttonsByText(container, 'Start Login')[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  assert.equal(startCliLoginCalls.length, 1);
  assert.equal(startCliLoginCalls[0].cli, 'claude', 'the selected provider must be the cli sent to the server, not a hardcoded codex');
});

// 회귀: reset()에 fallback provider 인자(nextProvider = provider)를 추가한 뒤,
// "Try Again" 버튼이 onClick={reset}로 직접 넘겨져 있으면 React가 클릭의
// SyntheticEvent 객체를 그 인자 자리로 넘겨 기본값 로직이 깨진다(구현 중 자체
// 발견·onClick={() => reset()}로 수정한 버그 — CliAutoLogin.tsx 참고). Claude로
// 전환한 뒤 실패를 겪고 "Try Again"을 눌렀을 때 폼이 깨끗한 claude 기본 상태로
// 돌아오는지(예: "undefined Login" 같은 손상 없이) 잠근다.
test("'Try Again' after a failed claude attempt resets to a clean claude form, not a state corrupted by the click's own event object", async (t) => {
  const { container } = await mountCredentialManagerForAutoLogin(t, {
    startCliLoginImpl: async (data) => ({
      id: 'session-2',
      workspace_id: data.workspace_id || '',
      is_global: false,
      cli: data.cli,
      credential_name: data.credential_name,
      status: 'failed',
      verification_url: null,
      user_code: null,
      raw_output_fallback: null,
      error_detail: 'boom',
      created_credential_id: null,
      created_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
    }),
  });

  click(buttonsByText(container, 'Log in with CLI')[0]);
  await flush();

  const [cliSelect] = selects(container);
  await changeSelect(cliSelect, 'claude');
  await flush(); // let listCliLoginInstances' auto-select populate Runtime Host

  await act(async () => {
    click(buttonsByText(container, 'Start Login')[0]);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.match(container.textContent, /Login failed|boom/);

  await act(async () => {
    click(buttonsByText(container, 'Try Again')[0]);
  });

  // A corrupted reset() (fallback arg receiving the click's MouseEvent instead
  // of the current provider) would leave stale/garbage state instead of a
  // clean pre-session form with claude's real default name and title.
  const nameInputAfterReset = container.querySelector('input');
  assert.equal(nameInputAfterReset.value, 'Claude login');
  assert.match(container.textContent, /Claude Login/);
  assert.doesNotMatch(container.textContent, /undefined/);
});

// 티켓 a9e2b1af: 이 가드는 원래 하네스가 텍스트 input 타이핑을 시뮬레이션하지 못해
// changeProvider()의 조건문 형태만 정규식으로 잠갔었다(source-level lock). typeInto()
// 도입으로 실제 타이핑 인터랙션이 가능해져, 지금은 진짜 동작을 검증한다.
test('changeProvider 는 사용자가 직접 입력한 이름은 덮어쓰지 않고, 손대지 않은 기본값만 provider 전환 시 갱신한다', async (t) => {
  const { container } = await mountCredentialManagerForAutoLogin(t);

  click(buttonsByText(container, 'Log in with CLI')[0]);
  await flush();

  const nameInput = container.querySelector('input');
  assert.equal(nameInput.value, 'Codex login');

  typeInto(nameInput, '내가 직접 입력한 이름');
  assert.equal(nameInput.value, '내가 직접 입력한 이름');

  const [cliSelect] = selects(container);
  await changeSelect(cliSelect, 'claude');

  assert.equal(
    nameInput.value,
    '내가 직접 입력한 이름',
    '직접 입력한 이름은 provider 전환 시 새 기본값으로 덮어써지면 안 된다',
  );
});
