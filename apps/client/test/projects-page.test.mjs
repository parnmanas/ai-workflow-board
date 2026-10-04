// Projects 화면 렌더링 회귀 (docs/tickets.md → Project). jsdom 으로 실제 페이지를
// 띄워 클릭·입력을 태우고, 나가는 REST 호출과 화면 상태를 단언한다.
//
// 고정하는 계약:
//   1. 새 프로젝트: 연결 테스트가 원격 기본 브랜치를 채우고, 생성 payload 가
//      docs 의 POST body 키 그대로 나간다.
//   2. Host 폴더: Runtime Host 마다 한 행, 상대 경로는 저장을 막고, 절대 경로는
//      PUT /projects/:id/host-folders/:hostId 로 저장된다. 목록에 없는 Host 의 폴더도
//      지울 수 있다.
//   3. 삭제: 409 project_in_use 면 참조 수를 보여주고 "강제 삭제" 로 ?force=1 재시도.
import test from 'node:test';
import assert from 'node:assert/strict';
// helpers/jsdom.mjs 를 react-router-dom(→ react-dom) 보다 먼저 import 해야 한다 —
// react-dom 이 전역 window 없이 먼저 평가되면 controlled input 의 onChange 가 영구히
// 죽는다(helpers/jsdom.mjs 상단 주석).
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { api } from '../src/api.ts';
import ProjectsPage from '../src/components/projects/ProjectsPage.tsx';

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function project(overrides = {}) {
  return {
    id: 'p-1', workspace_id: 'WS', name: 'AWB', description: '', repo_url: 'https://github.com/o/awb.git',
    default_branch: 'main', credential_id: null, clone_policy: null, use_pr: false, instructions: '',
    default_assignee: null, host_folders: [], created_at: '2026-10-01T00:00:00.000Z', updated_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

function buttonByText(container, label) {
  const found = [...container.ownerDocument.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `"${label}" 버튼이 없습니다.`);
  return found;
}

function fieldByLabel(container, labelText, tag = 'input') {
  const label = [...container.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨이 없습니다.`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 의 <${tag}> 가 없습니다.`);
  return field;
}

async function renderPage(t, { wsId, projects, stubs = {} }) {
  const dom = setupDom();
  globalThis.localStorage = dom.window.localStorage;
  const calls = [];
  let rows = projects;
  const originals = {};
  const all = {
    listProjects: async () => rows,
    listCredentials: async () => [],
    listTemplateHosts: async () => [{ id: 'host-rolf', name: 'rolf' }],
    ...stubs,
  };
  for (const [key, fn] of Object.entries(all)) {
    originals[key] = api[key];
    api[key] = async (...args) => { calls.push([key, ...args]); return fn(...args); };
  }
  const view = mount(
    React.createElement(MemoryRouter, { initialEntries: [`/ws/${wsId}/projects`] },
      React.createElement(Routes, null,
        React.createElement(Route, { path: '/ws/:wsId/projects', element: React.createElement(ProjectsPage) }))),
  );
  await flush();
  await flush();
  t.after(() => { view.unmount(); Object.assign(api, originals); dom.cleanup(); });
  return { container: view.container, calls, setRows: (next) => { rows = next; } };
}

test('새 프로젝트 — 연결 테스트가 기본 브랜치를 채우고, 생성 payload 가 문서의 키로 나간다', async (t) => {
  const created = project({ id: 'p-new', name: 'Game', repo_url: 'https://github.com/o/game.git', default_branch: 'develop' });
  const { container, calls, setRows } = await renderPage(t, {
    wsId: 'ws-create',
    projects: [],
    stubs: {
      testProjectConnection: async () => ({ ok: true, branches: [{ name: 'develop', sha: 'a' }, { name: 'main', sha: 'b' }], default_branch: 'develop' }),
      createProject: async () => { setRows([created]); return created; },
    },
  });

  assert.match(container.textContent, /아직 프로젝트가 없습니다/);
  click(buttonByText(container, '+ 새 프로젝트'));
  await flush();

  typeInto(fieldByLabel(container, '이름'), 'Game');
  typeInto(fieldByLabel(container, '저장소 URL'), 'https://github.com/o/game.git');
  click(buttonByText(container, '연결 테스트'));
  await flush();

  const testCall = calls.find((c) => c[0] === 'testProjectConnection');
  assert.deepEqual(testCall[1], { repo_url: 'https://github.com/o/game.git', credential_id: null, workspace_id: 'ws-create' });
  assert.match(container.querySelector('[data-testid="project-test-success"]').textContent, /브랜치 2개/);
  assert.equal(container.querySelector('input[aria-label="기본 브랜치"]').value, 'develop', '비어 있던 기본 브랜치를 원격 기본으로 채운다');

  click(buttonByText(container, '프로젝트 만들기'));
  await flush();
  await flush();

  const createCall = calls.find((c) => c[0] === 'createProject');
  assert.ok(createCall, '생성 요청이 나간다');
  assert.equal(createCall[1], 'ws-create');
  assert.deepEqual(Object.keys(createCall[2]).sort(), [
    'clone_policy', 'credential_id', 'default_assignee', 'default_branch', 'description',
    'instructions', 'name', 'repo_url', 'use_pr',
  ]);
  assert.equal(createCall[2].default_branch, 'develop');
  assert.equal(createCall[2].default_assignee, null);
  // 만든 프로젝트가 선택되어 Host 폴더 탭이 열린다.
  assert.ok([...container.querySelectorAll('[role="tab"]')].some((b) => b.textContent === 'Host 폴더'));
});

test('Host 폴더 — 상대 경로는 막고, 절대 경로는 PUT 으로 저장, 목록에 없는 Host 폴더도 지운다', async (t) => {
  const p = project({ host_folders: [{ host_id: 'host-gone', path: '/old/awb', host_name: 'ralf' }] });
  const { container, calls } = await renderPage(t, {
    wsId: 'ws-folders',
    projects: [p],
    stubs: {
      setProjectHostFolder: async (id, hostId, path) => project({ host_folders: [...p.host_folders, { host_id: hostId, path }], updated_at: '2026-10-02T00:00:00.000Z' }),
      clearProjectHostFolder: async () => project({ host_folders: [], updated_at: '2026-10-03T00:00:00.000Z' }),
    },
  });

  click(container.querySelector('[data-testid="project-row-p-1"]'));
  await flush();
  click([...container.querySelectorAll('[role="tab"]')].find((b) => b.textContent === 'Host 폴더'));
  await flush();

  const rolf = container.querySelector('[data-testid="project-host-folder-host-rolf"]');
  const gone = container.querySelector('[data-testid="project-host-folder-host-gone"]');
  assert.ok(rolf, '연결된 Host 행');
  assert.ok(gone, '목록에 없는 Host 의 폴더도 행으로 남는다');
  assert.match(gone.textContent, /알 수 없는 Host/);

  const input = rolf.querySelector('input');
  typeInto(input, 'repos/awb');
  assert.match(rolf.textContent, /절대 경로/);
  const rowSave = () => [...rolf.querySelectorAll('button')].find((b) => b.textContent.trim() === '저장');
  assert.equal(rowSave().disabled, false, '저장을 누르면 이유를 보여줄 수 있게 버튼은 살아 있다');
  click(rowSave());
  await flush();
  assert.equal(calls.some((c) => c[0] === 'setProjectHostFolder'), false, '상대 경로는 저장 요청을 보내지 않는다');

  typeInto(input, '/srv/awb');
  click(rowSave());
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'setProjectHostFolder').slice(1), ['p-1', 'host-rolf', '/srv/awb']);

  const goneRow = container.querySelector('[data-testid="project-host-folder-host-gone"]');
  click([...goneRow.querySelectorAll('button')].find((b) => b.textContent.trim() === '지우기'));
  await flush();
  assert.deepEqual(calls.find((c) => c[0] === 'clearProjectHostFolder').slice(1), ['p-1', 'host-gone']);
});

test('삭제 — 409 project_in_use 면 참조 수를 보여주고 "강제 삭제" 로 force 재시도한다', async (t) => {
  const deletes = [];
  const { container } = await renderPage(t, {
    wsId: 'ws-delete',
    projects: [project()],
    stubs: {
      deleteProject: async (id, opts) => {
        deletes.push([id, opts]);
        if (!opts?.force) {
          const err = new Error('Project is in use');
          err.code = 'project_in_use';
          err.status = 409;
          err.body = { error: 'project_in_use', counts: { tickets: 4, actions: 1 } };
          throw err;
        }
        return { ok: true };
      },
    },
  });

  click(container.querySelector('[data-testid="project-row-p-1"]'));
  await flush();
  click(buttonByText(container, '삭제'));
  await flush();
  click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '삭제'));
  await flush();

  const inUse = document.querySelector('[data-testid="project-in-use"]');
  assert.ok(inUse, '참조 수 안내가 뜬다');
  assert.match(inUse.textContent, /티켓 4/);
  assert.match(inUse.textContent, /Action 1/);

  click([...document.querySelectorAll('[role="dialog"] button')].find((b) => b.textContent.trim() === '강제 삭제'));
  await flush();
  assert.deepEqual(deletes, [['p-1', undefined], ['p-1', { force: true }]]);
});
