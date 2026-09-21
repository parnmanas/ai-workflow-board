// CLI 설정 패널의 기본 설정(approval 모드·모델) — jsdom 실렌더 단언.
//
// 어댑터 프로세스는 매번 자기 기본값으로 시작하므로, 여기 정해 둔 값을 세션이 열릴 때마다 다시 건다.
// 선택지는 어댑터가 알려 준 것뿐이라 세션을 한 번도 연 적 없는 호스트에서는 안내 문구만 나온다.
// 실행: node --import tsx --test apps/client/test/cli-settings-defaults.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter } from 'react-router-dom';
import { api } from '../src/api.ts';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import CliSettingsPanel from '../src/components/sessions/CliSettingsPanel.tsx';

const h = React.createElement;
const flush = async () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter, 'change: 네이티브 value setter 를 찾지 못했습니다.');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const OPTIONS = [
  { config_id: 'mode', name: 'Mode', category: 'mode', type: 'select', current_value: 'agent', options: [{ value: 'read-only', name: 'Ask for approval' }, { value: 'agent', name: 'Approve for me' }] },
  { config_id: 'model', name: 'Model', category: 'model', type: 'select', current_value: 'gpt-a', options: [{ value: 'gpt-a', name: 'A' }, { value: 'gpt-b', name: 'B' }] },
  { config_id: 'fast_mode', name: 'Fast mode', category: 'model_config', type: 'boolean', current_value: false, options: [] },
];

function settings(over = {}) {
  return {
    manager_id: 'm-rolf', cli: 'codex', supports_credential: true, credential: null, candidates: [],
    default_config: {}, known_config_options: OPTIONS, updated_at: null, ...over,
  };
}

/** ToastProvider 는 마운트 즉시 알림음 Audio 를 만든다 — jsdom 에 없으니 최소 스텁(기존 UI 테스트 관례). */
function stubAudio(t) {
  const previous = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} load() {} };
  t.after(() => { globalThis.Audio = previous; });
}

function stubApi(t, initial) {
  const calls = [];
  const original = { get: api.getHostCliSettings, put: api.setHostCliSettings };
  let current = initial;
  api.getHostCliSettings = async () => current;
  api.setHostCliSettings = async (managerId, cli, credentialId, defaultConfig) => {
    calls.push({ credentialId, defaultConfig });
    const merged = { ...current.default_config };
    for (const [k, v] of Object.entries(defaultConfig ?? {})) { if (v === null) delete merged[k]; else merged[k] = v; }
    current = { ...current, credential: null, default_config: merged };
    return current;
  };
  t.after(() => { api.getHostCliSettings = original.get; api.setHostCliSettings = original.put; });
  return calls;
}

// 패널은 useNavigate("Manage credentials") 와 useToast 를 쓴다 — 라우터·토스트 컨텍스트가 필요하다.
const panel = (props) => h(
  MemoryRouter,
  { initialEntries: ['/ws/ws-1/sessions/m-rolf'] },
  h(ToastProvider, null, h(CliSettingsPanel, { wsId: 'ws-1', managerId: 'm-rolf', cli: 'codex', hostName: 'rolf', ...props })),
);
const saveButton = () => [...document.querySelectorAll('button')].find((b) => b.textContent === 'Save');

test('the panel offers a default approval mode and model, seeded from what is saved', async (t) => {
  const dom = setupDom();
  try {
    stubAudio(t);
    stubApi(t, settings({ default_config: { mode: 'read-only' } }));
    const view = mount(panel({}));
    await flush();
    const mode = document.querySelector('select[data-default-config-id="mode"]');
    const model = document.querySelector('select[data-default-config-id="model"]');
    assert.ok(mode, 'approval mode default is offered');
    assert.ok(model, 'model default is offered');
    assert.equal(Boolean(document.querySelector('select[data-default-config-id="fast_mode"]')), false, 'boolean settings stay in the session header');
    assert.equal(mode.value, 'read-only', 'seeded from the saved value');
    assert.equal(model.value, '', 'nothing saved → the CLI default');
    assert.deepEqual([...mode.options].map((o) => o.textContent), ['Codex default', 'Ask for approval', 'Approve for me']);
    assert.equal(saveButton().disabled, true, 'nothing changed yet');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('saving sends only what changed, and clearing a default sends null', async (t) => {
  const dom = setupDom();
  try {
    stubAudio(t);
    const calls = stubApi(t, settings({ default_config: { mode: 'read-only' } }));
    const view = mount(panel({}));
    await flush();

    change(document.querySelector('select[data-default-config-id="model"]'), 'gpt-b');
    assert.equal(saveButton().disabled, false, 'changing a default enables Save');
    click(saveButton());
    await flush();
    assert.deepEqual(calls.at(-1).defaultConfig, { model: 'gpt-b' }, 'the untouched approval mode is not resent');

    change(document.querySelector('select[data-default-config-id="mode"]'), '');
    click(saveButton());
    await flush();
    assert.deepEqual(calls.at(-1).defaultConfig, { mode: null }, 'back to the CLI default clears the key');
    assert.equal(document.querySelector('select[data-default-config-id="mode"]').value, '');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('a host that has never run this CLI explains why there are no defaults yet', async (t) => {
  const dom = setupDom();
  try {
    stubAudio(t);
    stubApi(t, settings({ known_config_options: [] }));
    const view = mount(panel({}));
    await flush();
    assert.equal(Boolean(document.querySelector('select[data-default-config-id]')), false);
    assert.match(document.querySelector('[data-cli-settings]').textContent, /appear here once a Codex session has run on rolf/);
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('a CLI that cannot take an AWB credential can still save its defaults', async (t) => {
  const dom = setupDom();
  try {
    stubAudio(t);
    const calls = stubApi(t, settings({ supports_credential: false }));
    const view = mount(panel({ cli: 'hermes' }));
    await flush();
    assert.equal(Boolean(document.querySelector('select[aria-label="Session credential"]')), false, 'no credential picker for this CLI');
    assert.ok(saveButton(), 'but Save is still there');
    change(document.querySelector('select[data-default-config-id="mode"]'), 'read-only');
    click(saveButton());
    await flush();
    assert.deepEqual(calls.at(-1).defaultConfig, { mode: 'read-only' });
    view.unmount();
  } finally {
    dom.cleanup();
  }
});
