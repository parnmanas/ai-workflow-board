// NewSessionModal 회귀 테스트 — Runtime Host 목록 갱신이 열려 있는 폼을 되돌리지 않는다.
//
// 증상: 새 세션 모달에서 호스트를 고르고 cwd 를 찾는 도중 갑자기 첫 번째 호스트로 바뀌고
// DirectoryPicker 트리·cwd·제목이 초기화됐다. 원인은 hosts 가 매니저 하트비트마다
// (`agent_instance_update` → useAgentSessionsNav 재조회) 새 배열로 내려오는데, 모달의
// 초기화 effect 가 그 배열을 deps 로 잡고 있어 열려 있는 동안 30초 간격으로 다시 돌던 것.
// jsdom 으로 실제 렌더링해 select/input 값을 단언한다(소스 정규식 아님).
// 실행: node --import tsx --test apps/client/test/new-session-modal-host-refresh.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, typeInto, React, act } from './helpers/jsdom.mjs';
import NewSessionModal from '../src/components/sessions/NewSessionModal.tsx';

const h = React.createElement;

function host(managerId, name, clis) {
  return { manager_id: managerId, instance_id: `${managerId}-inst`, hostname: name, name, clis, plugin_version: '1', last_seen_at: new Date().toISOString(), cli_settings: {} };
}
// 서버는 이름순으로 정렬해 내려준다 — 첫 호스트는 ragnar.
const fleet = () => [host('m-ragnar', 'ragnar', ['claude', 'codex']), host('m-rolf', 'rolf', ['claude', 'codex'])];

/** controlled <select> 의 값을 네이티브 setter 로 바꾸고 change 를 태운다. */
function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter, 'change: 네이티브 value setter 를 찾지 못했습니다.');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

const hostSelect = () => document.querySelector('#new-session-host');
const cliSelect = () => document.querySelector('#new-session-cli');
const cwdInput = () => document.querySelector('input[placeholder="/path/to/repo"]');
const titleInput = () => document.querySelector('input[placeholder="Defaults to your first prompt"]');

function render(props) {
  return h(NewSessionModal, { open: true, onClose() {}, onCreated() {}, ...props });
}

test('a refreshed hosts array does not reset the host, CLI, cwd, or title the user already chose', () => {
  const dom = setupDom();
  try {
    const view = mount(render({ hosts: fleet() }));
    assert.equal(hostSelect().value, 'm-ragnar', 'defaults to the first host when the route names none');
    change(hostSelect(), 'm-rolf');
    change(cliSelect(), 'codex');
    typeInto(cwdInput(), '/mnt/data/repositories/game');
    typeInto(titleInput(), 'Balance pass');

    // 하트비트 → hosts 재조회: 내용은 같고 배열 identity 만 다르다 — 예전엔 여기서 폼이 초기화됐다
    view.rerender(render({ hosts: fleet() }));
    view.rerender(render({ hosts: fleet() }));
    assert.equal(hostSelect().value, 'm-rolf', 'host selection survives a hosts refresh');
    assert.equal(cliSelect().value, 'codex', 'CLI selection survives a hosts refresh');
    assert.equal(cwdInput().value, '/mnt/data/repositories/game', 'cwd survives a hosts refresh');
    assert.equal(titleInput().value, 'Balance pass', 'title survives a hosts refresh');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('hosts arriving after the modal opened fill the defaults once, then leave the choice alone', () => {
  const dom = setupDom();
  try {
    const view = mount(render({ hosts: [] }));
    assert.equal(hostSelect().value, '', 'nothing to pick yet');
    view.rerender(render({ hosts: fleet() }));
    assert.equal(hostSelect().value, 'm-ragnar', 'late hosts fill the default host');
    assert.equal(cliSelect().value, 'claude', 'and its first CLI');
    change(hostSelect(), 'm-rolf');
    view.rerender(render({ hosts: fleet() }));
    assert.equal(hostSelect().value, 'm-rolf', 'a later refresh does not fall back to the first host');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('a host that drops out of one heartbeat stays selected until it returns', () => {
  const dom = setupDom();
  try {
    const view = mount(render({ hosts: fleet(), initialManagerId: 'm-rolf', initialCli: 'codex' }));
    assert.equal(hostSelect().value, 'm-rolf');
    assert.equal(cliSelect().value, 'codex');
    typeInto(cwdInput(), '/srv/app');
    view.rerender(render({ hosts: [host('m-ragnar', 'ragnar', ['claude'])], initialManagerId: 'm-rolf', initialCli: 'codex' }));
    assert.equal(hostSelect().value, 'm-rolf', 'selection survives a TTL gap');
    assert.equal(cliSelect().value, 'codex');
    assert.equal(cwdInput().value, '/srv/app');
    view.rerender(render({ hosts: fleet(), initialManagerId: 'm-rolf', initialCli: 'codex' }));
    assert.equal(hostSelect().value, 'm-rolf');
    assert.equal(cliSelect().value, 'codex');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});

test('closing and reopening re-applies the route defaults (host, CLI, prefilled cwd)', () => {
  const dom = setupDom();
  try {
    const view = mount(render({ hosts: fleet(), initialManagerId: 'm-ragnar', initialCli: 'codex' }));
    change(hostSelect(), 'm-rolf');
    typeInto(titleInput(), 'scratch');
    view.rerender(h(NewSessionModal, { open: false, onClose() {}, onCreated() {}, hosts: fleet(), initialManagerId: 'm-ragnar', initialCli: 'codex' }));
    assert.equal(document.querySelector('[role="dialog"]'), null, 'closed');
    view.rerender(render({ hosts: fleet(), initialManagerId: 'm-ragnar', initialCli: 'codex', initialCwd: '/srv/app' }));
    assert.equal(hostSelect().value, 'm-ragnar', 'reopen starts from the route host again');
    assert.equal(cliSelect().value, 'codex');
    assert.equal(cwdInput().value, '/srv/app', '"+ New" on a cwd group prefills that cwd');
    assert.equal(titleInput().value, '', 'the previous draft title is gone');
    view.unmount();
  } finally {
    dom.cleanup();
  }
});
