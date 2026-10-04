// "프로젝트 폴더 사용" 헬퍼 (docs/tickets.md → Main clone folder per host).
//
// 고정하는 계약:
//   1. Host 를 고르지 않으면 컨트롤 전체가 비활성 + "먼저 Runtime Host 를 고르세요".
//   2. 그 Host 에 폴더가 없는 프로젝트는 목록에 남되 비활성 + "이 Host 에 프로젝트
//      폴더가 없습니다" — 왜 못 고르는지 보이게.
//   3. Host id 와 레거시 manager Agent uuid 별칭 둘 다로 폴더를 찾는다(팀 슬롯).
//   4. 실제 RuntimeSpecEditor(티켓·프로젝트 기본 담당자·DeclareRuntimeSection 공용)에서
//      프로젝트를 고르면 working_dir 가 그 Host 의 폴더로 채워진다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act } from './helpers/jsdom.mjs';
import {
  NO_FOLDER_HINT,
  NO_HOST_HINT,
  projectFolderHelperView,
} from '../src/projects/projectFolderHelper.logic.ts';
import { api } from '../src/api.ts';
import RuntimeSpecEditor from '../src/components/runtime/RuntimeSpecEditor.tsx';
import { emptyRuntimeSpec } from '../src/runtime/runtimeSpec.ts';

const PROJECTS = [
  { id: 'awb', name: 'AWB', host_folders: [{ host_id: 'host-rolf', path: '/srv/awb' }, { host_id: 'legacy-ragnar', path: '/data/awb' }] },
  { id: 'game', name: 'Game', host_folders: [{ host_id: 'host-ragnar', path: '/data/game' }] },
];

test('Host 미선택 — 전체 비활성 + 이유', () => {
  const v = projectFolderHelperView(PROJECTS, '');
  assert.equal(v.disabled, true);
  assert.equal(v.hint, NO_HOST_HINT);
  assert.ok(v.options.slice(1).every((o) => o.disabled && o.path === null));
});

test('폴더가 있는 프로젝트만 고를 수 있고, 없는 프로젝트는 이유와 함께 비활성', () => {
  const v = projectFolderHelperView(PROJECTS, 'host-rolf');
  assert.equal(v.disabled, false);
  assert.equal(v.hint, null);
  const [placeholder, awb, game] = v.options;
  assert.equal(placeholder.value, '');
  assert.deepEqual(awb, { value: 'awb', label: 'AWB — /srv/awb', disabled: false, path: '/srv/awb' });
  assert.equal(game.disabled, true);
  assert.equal(game.label, `Game — ${NO_FOLDER_HINT}`);
});

test('Host id + 레거시 별칭 둘 다로 찾는다, 이미 쓰는 폴더는 표시한다', () => {
  const v = projectFolderHelperView(PROJECTS, ['host-ragnar', 'legacy-ragnar'], '/data/awb');
  assert.equal(v.options[1].path, '/data/awb', '별칭으로 저장된 폴더도 찾는다');
  assert.match(v.options[1].label, /\(사용 중\)$/);
  assert.equal(v.options[2].path, '/data/game');
});

test('어느 프로젝트도 이 Host 에 폴더가 없으면 Projects 화면으로 안내한다', () => {
  const v = projectFolderHelperView(PROJECTS, 'host-unknown');
  assert.equal(v.disabled, false);
  assert.match(v.hint, /Projects 화면/);
  assert.ok(v.options.slice(1).every((o) => o.disabled));
});

// ── 실제 RuntimeSpecEditor 배선 ─────────────────────────────────────────────

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

test('RuntimeSpecEditor — 프로젝트를 고르면 선택된 Host 의 메인 클론 폴더가 working_dir 로 들어간다', async (t) => {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  const originals = { listProjects: api.listProjects, listCredentials: api.listCredentials, getHostModels: api.getHostModels };
  api.listProjects = async () => PROJECTS;
  api.listCredentials = async () => [];
  api.getHostModels = async (id) => ({ manager_agent_id: id, models: {}, refreshed_at: new Date().toISOString(), is_online: true });
  const changes = [];
  const value = { ...emptyRuntimeSpec(), manager_agent_id: 'host-rolf', cli: 'claude', working_dir: '/home/me/old' };
  const view = mount(React.createElement(RuntimeSpecEditor, {
    value,
    onChange: (next) => changes.push(next),
    hosts: [{ id: 'host-rolf', name: 'rolf' }],
    workspaceId: 'ws-helper',
  }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  t.after(() => { view.unmount(); Object.assign(api, originals); dom.cleanup(); });

  const helper = view.container.querySelector('select[aria-label="프로젝트 폴더 사용"]');
  assert.ok(helper, 'working dir 아래에 "프로젝트 폴더 사용" 헬퍼가 있다');
  const game = [...helper.options].find((o) => o.value === 'game');
  assert.equal(game.disabled, true, '이 Host 에 폴더가 없는 프로젝트는 고를 수 없다');
  assert.match(game.textContent, /이 Host 에 프로젝트 폴더가 없습니다/);

  change(helper, 'awb');
  assert.equal(changes.at(-1)?.working_dir, '/srv/awb', '명시적으로 고르면 기존 working_dir 를 덮어쓴다');
});

test('RuntimeSpecEditor — showProjectFolderHelper={false} 면 헬퍼를 숨긴다', async (t) => {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  const originals = { listProjects: api.listProjects, listCredentials: api.listCredentials };
  api.listProjects = async () => PROJECTS;
  api.listCredentials = async () => [];
  const view = mount(React.createElement(RuntimeSpecEditor, {
    value: emptyRuntimeSpec(),
    onChange: () => {},
    hosts: [],
    workspaceId: 'ws-helper-hidden',
    showProjectFolderHelper: false,
  }));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  t.after(() => { view.unmount(); Object.assign(api, originals); dom.cleanup(); });
  assert.equal(Boolean(view.container.querySelector('select[aria-label="프로젝트 폴더 사용"]')), false, '프로젝트가 없으면 helper 를 그리지 않는다');
});
