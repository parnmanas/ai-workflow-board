// QA scenario / Security profile editors — board-less on-failure ticket section
// (docs/tickets.md → QA / Security failure tickets).
//
// Mounts the real editors in jsdom and asserts what reaches the server: a row
// written before the board removal (board_id / column / labels) opens with its
// labels as tags, and saving sends project_id / status / tags with every
// retired key gone. The Security editor additionally picks its inspection
// target from the project list (target_resource_id keeps its name — projects
// reuse the old repository Resource ids).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import QaManager from '../src/components/admin/QaManager.tsx';
import SecurityManager from '../src/components/admin/SecurityManager.tsx';

const WS = 'ws-oft';
const PROJECTS = [
  { id: 'proj-awb', account_id: WS, name: 'AWB', repo_url: 'https://example.com/awb.git', default_branch: 'main', host_folders: [] },
  { id: 'proj-game', account_id: WS, name: 'GameClient', repo_url: 'https://example.com/game.git', default_branch: 'develop', host_folders: [] },
];
const AGENTS = [{ id: 'agent-1', name: 'Programmer', manager_name: 'Rolf' }];
const TARGET_RUNTIME = { manager_agent_id: 'host-1', cli: 'codex', working_dir: '/repo', runtime_config: { strategy: 'single', permission_mode: 'approve' } };
const LEGACY_OFT = {
  enabled: true,
  board_id: 'board-legacy',
  column_id: 'col-legacy',
  column_name: 'To Do',
  assignee_id: 'agent-legacy',
  labels: ['qa-failure', 'login'],
  priority: 'high',
  dedupe: 'per_run',
  title_template: 'Fix: {{scenario.name}}',
};
const RETIRED = ['board_id', 'column_id', 'column_name', 'assignee_id', 'labels'];

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);
  assert.ok(found, `"${label}" 버튼을 찾을 수 없습니다.`);
  return found;
}

/** 공용 Input/Select 는 label 에 htmlFor 가 없어서 래퍼 div 를 거쳐 찾는다. */
function fieldByLabel(root, labelText, tag) {
  const label = [...root.querySelectorAll('label')].find((l) => l.textContent?.trim() === labelText);
  assert.ok(label, `"${labelText}" 라벨을 찾을 수 없습니다.`);
  const field = label.parentElement?.querySelector(tag);
  assert.ok(field, `"${labelText}" 라벨에 대응하는 <${tag}> 가 없습니다.`);
  return field;
}

function stubApi(t, stubs) {
  const originals = {};
  for (const key of Object.keys(stubs)) originals[key] = api[key];
  Object.assign(api, stubs);
  t.after(() => { Object.assign(api, originals); });
}

const COMMON_STUBS = {
  getAgents: async () => AGENTS,
  listProjects: async () => PROJECTS,
  listResources: async () => [],
  listRepoBranches: async () => ({ branches: [], default_branch: 'main' }),
};

test('QA: legacy board row opens with labels as tags and saves project/status/tags without board keys', async (t) => {
  const dom = setupDom();
  const updated = [];
  const scenario = {
    id: 'qa-1', account_id: WS, name: '로그인', description: '',
    target_agent_id: 'rt-1', target_runtime: TARGET_RUNTIME, qa_driver: 'browser', qa_driver_config: {}, steps: [], tags: [],
    enabled: true, target_environment: '', on_failure_ticket: LEGACY_OFT, qa_phases: null,
    workspace_folder: '', repo_ref: null, checkout_mode: 'reuse', build_mode: 'cold_then_warm', last_built_commit: null,
    last_run_at: null, last_run_status: null, run_count: 0,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
  stubApi(t, {
    ...COMMON_STUBS,
    listQaScenarios: async () => [scenario],
    listQaSchedules: async () => [],
    listDeployments: async () => [],
    updateQaScenario: async (id, payload) => { updated.push({ id, payload }); return { ...scenario, ...payload }; },
  });
  const view = mount(React.createElement(QaManager, { accountId: WS }));
  await flush();
  t.after(() => { view.unmount(); dom.cleanup(); });

  click(button(view.container, 'Edit'));
  await flush();
  const modal = document.body;

  // No board / column inputs survive anywhere in the editor.
  const labels = [...modal.querySelectorAll('label')].map((l) => l.textContent || '');
  assert.equal(labels.some((l) => /board|컬럼/i.test(l)), false, `board/column field still rendered: ${labels.join(' | ')}`);
  assert.equal(modal.textContent.includes('board 기본값'), false, 'QA phases must not mention board inheritance');

  // Tags use the shared <TagInput>: legacy labels show up as chips.
  const tagLabel = [...modal.querySelectorAll('label')].find((l) => l.textContent?.trim() === '티켓 태그');
  assert.ok(tagLabel, 'on-failure tag input missing');
  const tagInput = document.getElementById(tagLabel.htmlFor);
  const chips = () => [...modal.querySelectorAll('button[aria-label^="태그 "]')].map((b) => b.getAttribute('aria-label'));
  assert.deepEqual(chips(), ['태그 qa-failure 제거', '태그 login 제거'], 'legacy labels are read as tags');

  const projectSelect = fieldByLabel(modal, '프로젝트 (선택)', 'select');
  assert.deepEqual([...projectSelect.options].map((o) => o.value), ['', 'proj-awb', 'proj-game']);
  change(projectSelect, 'proj-game');
  change(fieldByLabel(modal, '생성 상태 (status)', 'select'), 'backlog');
  // Comma commits a chip (TagInput); remove one legacy chip, add a new one.
  typeInto(tagInput, 'regression,');
  await flush();
  click(modal.querySelector('button[aria-label="태그 login 제거"]'));
  await flush();
  assert.deepEqual(chips(), ['태그 qa-failure 제거', '태그 regression 제거']);

  click(button(view.container, 'Save'));
  await flush();

  assert.equal(updated.length, 1);
  const oft = updated[0].payload.on_failure_ticket;
  for (const key of RETIRED) assert.equal(key in oft, false, `${key} must not be sent`);
  assert.equal(oft.enabled, true);
  assert.equal(oft.project_id, 'proj-game');
  assert.equal(oft.status, 'backlog');
  assert.deepEqual(oft.tags, ['qa-failure', 'regression']);
  assert.equal(oft.title_template, 'Fix: {{scenario.name}}', 'keys the editor does not show are kept');
});

test('Security: target picks a project (or self) and on-failure ticket drops board keys', async (t) => {
  const dom = setupDom();
  const updated = [];
  const profile = {
    id: 'sec-1', account_id: WS, name: '감사', description: '',
    target_agent_id: 'rt-1', target_runtime: TARGET_RUNTIME, target_resource_id: null, scan_driver: 'code-review',
    scan_driver_config: {}, scope_mode: 'incremental', checklist: [], tags: [],
    enabled: true, max_runs: 20, on_failure_ticket: { ...LEGACY_OFT, min_severity: 'medium' },
    workspace_folder: '', repo_ref: null, checkout_mode: 'reuse', build_mode: 'cold_then_warm', last_built_commit: null,
    last_run_at: null, last_run_status: null, last_scope_used: null, run_count: 0,
    created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  };
  stubApi(t, {
    ...COMMON_STUBS,
    listSecurityProfiles: async () => [profile],
    listSecuritySchedules: async () => [],
    listSecurityRuns: async () => [],
    updateSecurityProfile: async (id, payload) => { updated.push({ id, payload }); return { ...profile, ...payload }; },
  });
  const view = mount(React.createElement(SecurityManager, { accountId: WS }));
  await flush();
  t.after(() => { view.unmount(); dom.cleanup(); });

  click(button(view.container, 'Edit'));
  await flush();
  const modal = document.body;

  const target = fieldByLabel(modal, '점검 대상 (Target)', 'select');
  assert.equal(target.value, '', 'null target = AWB itself');
  assert.deepEqual([...target.options].map((o) => o.value), ['', 'proj-awb', 'proj-game']);
  change(target, 'proj-awb');

  change(fieldByLabel(modal, '프로젝트 (선택)', 'select'), 'proj-awb');
  await flush();

  click(button(view.container, 'Save'));
  await flush();

  assert.equal(updated.length, 1);
  const { payload } = updated[0];
  assert.equal(payload.target_resource_id, 'proj-awb');
  const oft = payload.on_failure_ticket;
  for (const key of RETIRED) assert.equal(key in oft, false, `${key} must not be sent`);
  assert.equal(oft.project_id, 'proj-awb');
  assert.equal(oft.status, 'todo');
  assert.equal(oft.min_severity, 'medium');
  assert.deepEqual(oft.tags, ['qa-failure', 'login']);
});
