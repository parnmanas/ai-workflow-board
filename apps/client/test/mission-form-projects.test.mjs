import { ui } from './helpers/i18n.mjs';
// Orchestration Mission 모달의 project 선택 회귀 테스트 (docs/orchestration.md → "미션 프로젝트").
//
// 팀은 여러 미션에 재사용되므로 작업 폴더가 팀 slot 에서 미션의 PROJECT 로 옮겨 갔다. 예전엔
// 미션이 저장소 하나(repo_ref)를 RepoRefPicker 로 고르고 slot 마다 working_dir 를 따로 적었다
// (그 단일 피커의 계약은 이 파일의 전신 mission-form-repo-picker.test.mjs 가 고정했다). 이제
// 미션이 project 를 여러 개 고르고, 각 멤버는 그 project 의 **자기 Host** 폴더(Projects → host
// folders)에서 일한다. 그래서 폼은 시작 전에 "누가 어느 project 를 맡을 수 있는가" 를 보여 주고,
// 맡을 수 없는 멤버가 있으면 시작을 막는다 — 서버 resolveMissionRoster 와 같은 규칙이며, 순수
// 규칙 자체는 mission-projects-logic.test.mjs 가 본다.
//
// 소스 문자열/정규식 검사가 아니라 jsdom 으로 MissionFormModal 을 실제 렌더링해 선택·입력·클릭을
// 태우고, 그 결과 화면 상태와 create/update 페이로드를 단언한다(보드 교훈: UI 동작 완료 기준은
// 렌더링 상호작용으로 검증).
//
// 고정하는 계약:
//   1. id 를 한 글자도 타이핑하지 않고 드롭다운만으로 project 를 여러 개 고른다. 첫 project 가
//      primary 이고("Make primary" 로 바꾼다), project 마다 브랜치(빈 값 = 기본 브랜치)를 둔다.
//   2. payload 는 생성·편집 모두 `projects: [{ project_id, branch? }]`(선택 순서 그대로, 빈 브랜치는
//      키째 빠짐) + `folder_scope` 이고 `repo_ref` 는 더 이상 나가지 않는다. 저장된 draft 를 다시
//      열면 projects / folder_scope / 체크아웃 옵션이 복원된다.
//   3. 멤버(orchestrator·임시 멤버 포함)마다 고른 project 의 폴더가 그 Host 에 있는지(✓ 경로 /
//      ✗ no folder) 보여 주고, "Set folder…" 는 그 project·그 Host 로 setProjectHostFolder 를 부른 뒤
//      목록을 다시 읽어 표시를 고친다.
//   4. 어느 project 에도 폴더가 없는 멤버가 있으면 "즉시 브리핑" 생성은 요청 없이 막히고 이유가
//      보인다(토스트 + 체크박스 아래 목록). draft 저장은 막지 않는다. 제외는 멤버 행 id 로 나간다.
//   5. 목록 API(GET /api/projects)는 접근 가능한 모든 계정의 project 를 합쳐 준다 — 폼은 미션
//      계정의 것만 고르게 하고, 팀을 다른 계정의 팀으로 바꾸면 그 계정에 없는 선택을 걷어낸다.
//      단 목록이 아직 오지 않았거나 조회에 실패한 동안에는 저장된 선택을 지우지 않는다.
//   6. Folders = isolated 일 때만 체크아웃 루트/모드가 보인다(Advanced 에서 옮겨 왔다).

import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, run, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { ToastProvider } from '../src/contexts/ToastContext.tsx';
import { MissionFormModal } from '../src/components/orchestration/OrchestrationPage.tsx';

const h = React.createElement;
const WS = 'ws-1';
const OTHER_WS = 'ws-2';

// rolf: orchestrator + implementer, ralf: reviewer, ragnar: 어떤 project 폴더도 없는 Host.
const ROLF = 'host-rolf';
const RALF = 'host-ralf';
const RAGNAR = 'host-ragnar';

const EPOCH = new Date(0).toISOString();

const project = (id, account_id, name, host_folders, { repo_url = `https://github.com/example/${id}.git`, default_branch = 'main' } = {}) => ({
  id, account_id, name, description: '', repo_url, default_branch, credential_id: null,
  clone_policy: null, use_pr: false, instructions: '', default_assignee: null, host_folders,
  created_at: EPOCH, updated_at: EPOCH,
});

const AWB = project('p-awb', WS, 'AWB', [
  { host_id: ROLF, path: '/srv/awb' },
  { host_id: RALF, path: '/home/ralf/awb' },
], { repo_url: 'https://github.com/parnmanas/ai-workflow-board.git' });
const DOCS = project('p-docs', WS, 'Docs', [{ host_id: RALF, path: '/home/ralf/docs' }]);
const GAME = project('p-game', WS, 'GameClient', [{ host_id: ROLF, path: '/srv/game' }], { default_branch: 'develop' });
const OPS = project('p-ops', OTHER_WS, 'Ops', [{ host_id: ROLF, path: '/srv/ops' }]);

// GET /api/projects 는 접근 가능한 **모든** 계정의 project 를 이름순으로 합쳐 준다(projects.controller
// list → accessibleAccountIds). api.listProjects(accountId) 는 그 인자를 쓰지 않는다 — 스텁도 실제
// 응답 모양을 그대로 따른다. 계정별로 잘라 주는 스텁이었다면 계약 5 를 놓친다.
const ALL_PROJECTS = [AWB, DOCS, GAME, OPS];

const runtime = (hostId, hostName, model = null) => ({
  manager_agent_id: hostId,
  manager_name: hostName,
  manager_online: true,
  cli: 'claude',
  model,
  credential_id: null,
  cli_runtime_profile: null,
  // 임시 멤버 폼이 orchestrator 런타임을 씨앗으로 쓴다 — 전략·권한이 있어야 바로 추가할 수 있다.
  runtime_config: { strategy: 'single', permission_mode: 'approve' },
});

const member = (id, agent_name, role_label, rt) => ({
  id, agent_name, agent_type: 'claude', is_online: true, role_label, capabilities: '', max_concurrent: 1, position: 0, runtime: rt,
});

function team(overrides) {
  return {
    id: 'team-1',
    account_id: WS,
    is_global: false,
    owner_account_id: WS,
    allowed_account_ids: [],
    name: 'Platform squad',
    description: '',
    orchestrator_name: 'rolf/orchestrator',
    orchestrator_online: true,
    orchestrator_runtime: runtime(ROLF, 'rolf', 'claude-opus'),
    orchestrator_prompt: '',
    max_parallel_steps: 3,
    max_open_missions: 1,
    enabled: true,
    members: [
      member('m-impl', 'rolf/implementer', 'implementer', runtime(ROLF, 'rolf')),
      member('m-review', 'ralf/reviewer', 'reviewer', runtime(RALF, 'ralf')),
    ],
    active_mission_count: 0,
    created_at: EPOCH,
    updated_at: EPOCH,
    ...overrides,
  };
}

const TEAM = team();
const OTHER_TEAM = team({
  id: 'team-ops',
  account_id: OTHER_WS,
  owner_account_id: OTHER_WS,
  name: 'Ops squad',
  members: [member('m-ops', 'rolf/operator', 'operator', runtime(ROLF, 'rolf'))],
});
const GPU_TEAM = team({
  id: 'team-gpu',
  name: 'GPU squad',
  members: [...TEAM.members, member('m-gpu', 'ragnar/tester', 'tester', runtime(RAGNAR, 'ragnar'))],
});

// 모달은 teams 참조가 바뀌면 폼을 초기화한다 — 테스트마다 고정된 배열을 넘긴다.
const TEAMS = [TEAM, OTHER_TEAM];
const GPU_TEAMS = [GPU_TEAM];

const HOSTS = [
  { manager_agent_id: ROLF, manager_name: 'rolf', hostname: 'rolf', is_online: true, instance_id: 'i-rolf', last_seen_at: EPOCH, clis: ['claude'], available_models: {}, cli_versions: {} },
  { manager_agent_id: RALF, manager_name: 'ralf', hostname: 'ralf', is_online: true, instance_id: 'i-ralf', last_seen_at: EPOCH, clis: ['claude'], available_models: {}, cli_versions: {} },
  { manager_agent_id: RAGNAR, manager_name: 'ragnar', hostname: 'ragnar', is_online: true, instance_id: 'i-ragnar', last_seen_at: EPOCH, clis: ['claude'], available_models: {}, cli_versions: {} },
];

// DirectoryPicker 가 Host 별로 처음 여는 폴더 — "Use this directory" 가 고르는 경로다.
const PICKED_DIR = { [ROLF]: '/home/parn/work', [RALF]: '/home/ralf/game', [RAGNAR]: '/home/ragnar/awb' };

function baseMission(overrides) {
  return {
    id: 'mission-1',
    account_id: WS,
    team_id: 'team-1',
    team_name: 'Platform squad',
    title: 'Ship the billing export',
    status: 'draft',
    orchestrator_agent_id: null,
    orchestrator_name: 'rolf/orchestrator',
    plan_version: 0,
    counts: { total: 0, done: 0, failed: 0, inFlight: 0, pending: 0, awaitingUser: 0 },
    started_at: null,
    finished_at: null,
    created_at: EPOCH,
    updated_at: EPOCH,
    objective: 'Ship it.',
    context: '',
    acceptance_criteria: '',
    method: '',
    completion_criteria: [],
    post_actions: [],
    excluded_member_ids: [],
    extra_members: [],
    projects: [],
    folder_scope: 'shared',
    roster: null,
    resolved_workspace_folder: '',
    workspace_folder: '',
    checkout_mode: 'reuse',
    plan_summary: '',
    result_summary: '',
    failure_reason: '',
    room_id: null,
    max_parallel_steps: 3,
    max_steps: 60,
    max_plan_versions: 6,
    step_timeout_minutes: 90,
    created_by_type: 'user',
    created_by: '',
    graph_enabled: false,
    graph_spec: null,
    total_visits: 0,
    confirm_policy: 'auto',
    user_chat_mode: 'open',
    steps: [],
    events: [],
    ...overrides,
  };
}

const flush = async () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** controlled <select> / <input> 의 값을 네이티브 setter 로 바꾸고 change 를 태운다. */
function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter, 'change: 네이티브 value setter 를 찾지 못했습니다.');
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

/** 글자가 정확히 `text` 인 첫 버튼(Button 은 형제 <style> 을 그리므로 버튼 자신의 글자만 본다). */
function buttonIn(root, text) {
  const found = [...root.querySelectorAll('button')].find((b) => (b.textContent || '').trim() === ui(text));
  assert.ok(found, `"${text}" 버튼을 찾을 수 없습니다.`);
  return found;
}

/** <Input label>/<Select label> 은 <div><label>라벨</label><input|select/></div> 로 그린다. */
function field(root, labelText, tag) {
  const label = [...root.querySelectorAll('label')].find((l) => (l.textContent || '').trim() === ui(labelText));
  return label?.parentElement?.querySelector(tag) ?? null;
}

function fillRequired(root) {
  const title = field(root, 'Title', 'input');
  assert.ok(title, 'Title 입력이 없습니다.');
  typeInto(title, 'Ship the export');
  // LabeledTextarea 는 <label><span>라벨</span>…<textarea/></label> — 임시 멤버 폼에도 textarea 가
  // 있으므로 순서가 아니라 라벨로 찾는다.
  const objective = [...root.querySelectorAll('label')]
    .find((l) => l.querySelector('span')?.textContent === 'Objective')
    ?.querySelector('textarea');
  assert.ok(objective, 'Objective 입력이 없습니다.');
  typeInto(objective, 'Do the thing.');
}

function startCheckbox(root) {
  const label = [...root.querySelectorAll('label')].find((l) => (l.textContent || '').trim() === 'Brief the orchestrator immediately');
  return label?.querySelector('input[type="checkbox"]') ?? null;
}

const section = (root) => root.querySelector('[data-testid="mission-projects"]');
const addSelect = (root) => root.querySelector('select[aria-label="Add a project"]');
const optionLabels = (select) => [...select.options].map((o) => o.textContent);

function addProject(root, projectId) {
  const select = addSelect(root);
  assert.ok(select, '"Add a project" 드롭다운이 없습니다.');
  change(select, projectId);
}

/** 고른 project 행 — 이름(브랜치 입력의 aria-label), 브랜치 값, primary 표시. */
function projectRows(root) {
  return [...section(root).querySelectorAll('input[aria-label^="Branch for "]')].map((input) => ({
    name: input.getAttribute('aria-label').slice('Branch for '.length),
    branch: input.value,
    primary: (input.parentElement.textContent || '').includes('· primary'),
  }));
}

function branchInput(root, name) {
  const input = section(root).querySelector(`input[aria-label="Branch for ${ui(name)}"]`);
  assert.ok(input, `${name} 의 브랜치 입력이 없습니다.`);
  return input;
}

/** project 행 안의 버튼(Make primary / Remove). */
const rowButton = (root, name, text) => buttonIn(branchInput(root, name).parentElement, text);

function foldersSelect(root) {
  const select = [...section(root).querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'isolated'));
  assert.ok(select, 'Folders 선택이 없습니다.');
  return select;
}

/**
 * 슬롯 이름(멤버 agent_name · orchestrator 이름 · 임시 멤버 role)으로 그 슬롯의 블록을 찾는다.
 * 멤버는 체크박스를 감싼 <label>, orchestrator·임시 멤버는 이름 줄의 부모 블록이다.
 */
function slotRow(root, name) {
  const head = [...root.querySelectorAll('span')].find(
    (s) => s.firstChild?.nodeType === 3 && s.firstChild.textContent === name,
  );
  assert.ok(head, `"${name}" 슬롯을 찾을 수 없습니다.`);
  return head.closest('label') || head.parentElement;
}

/** 버튼 글자("Set folder…")를 뺀 읽을 수 있는 글자. */
function readable(el) {
  const copy = el.cloneNode(true);
  for (const b of copy.querySelectorAll('button')) b.remove();
  return (copy.textContent || '').trim();
}

/** 슬롯의 ✓/✗ 줄(고른 project 순서). */
function coverageOf(root, name) {
  return [...slotRow(root, name).querySelectorAll('span')]
    .filter((s) => !s.querySelector('span'))
    .map(readable)
    .filter((text) => /^[✓✗] /.test(text));
}

const cannotWork = (root, name) =>
  (slotRow(root, name).textContent || '').includes('Cannot work on any selected project');

function setFolderButton(root, slotName, projectName) {
  const line = [...slotRow(root, slotName).querySelectorAll('span')].find(
    (s) => !s.querySelector('span') && readable(s) === `✗ ${projectName} — no folder on this host`,
  );
  const found = line && [...line.querySelectorAll('button')].find((b) => b.textContent === 'Set folder…');
  assert.ok(found, `${slotName} 의 ${projectName} 줄에 "Set folder…" 버튼이 없습니다.`);
  return found;
}

function startProblems(root) {
  const box = root.querySelector('[data-testid="mission-start-problems"]');
  return box ? [...box.children].map((d) => d.textContent) : [];
}

const toastText = (root) => root.querySelector('.awb-toasts')?.textContent || '';

const NO_PROJECT = 'Pick at least one project — members work in its folder on their own host.';
const ragnarProblem = 'ragnar/tester has no folder for any selected project on its host — set one, or leave it out.';

/**
 * 모달을 ToastProvider 안에 열고 api 를 가로챈다. 목록은 `rows` 를 돌려주며, setProjectHostFolder 는
 * 서버처럼 그 행의 host_folders 를 고친다 — 다음 목록 조회가 바뀐 폴더를 본다.
 */
async function mountModal(t, { mission = null, teams = TEAMS, accountId = WS, listProjects } = {}) {
  const dom = setupDom();
  // ToastProvider 는 마운트 즉시 알림음 Audio 를 만든다 — jsdom 에 없으니 최소 스텁(기존 UI 테스트 관례).
  const previousAudio = globalThis.Audio;
  globalThis.Audio = class { play() { return Promise.resolve(); } pause() {} };

  const state = { rows: ALL_PROJECTS };
  const created = [];
  const updated = [];
  const folderWrites = [];
  const pickerHosts = [];
  const originals = Object.fromEntries([
    'listProjects', 'setProjectHostFolder', 'listActions', 'createOrchestrationMission', 'updateOrchestrationMission',
    'getAgentFsRoots', 'listAgentFs', 'getAgentFsDrives', 'listOrchestrationRuntimeHosts', 'listCredentials',
    'listClaudeBackendProfiles', 'listAgentTemplates', 'getHostModels', 'refreshHostModels',
  ].map((name) => [name, api[name]]));

  api.listProjects = listProjects ?? (async () => state.rows);
  api.setProjectHostFolder = async (projectId, hostId, path) => {
    folderWrites.push({ projectId, hostId, path });
    state.rows = state.rows.map((p) => (p.id === projectId
      ? { ...p, host_folders: [...p.host_folders.filter((f) => f.host_id !== hostId), { host_id: hostId, path }] }
      : p));
    return state.rows.find((p) => p.id === projectId);
  };
  api.listActions = async () => [];
  api.createOrchestrationMission = async (data) => { created.push(data); return baseMission({ ...data, id: 'mission-new' }); };
  api.updateOrchestrationMission = async (id, data) => { updated.push({ id, data }); return baseMission({ ...data, id }); };
  // "Set folder…" 가 여는 DirectoryPicker 의 fs reverse-RPC.
  api.getAgentFsRoots = async (hostId) => {
    pickerHosts.push(hostId);
    return { cwd: PICKED_DIR[hostId], roots: [PICKED_DIR[hostId]], enabled: true, platform: 'linux' };
  };
  api.listAgentFs = async (_hostId, path) => ({ path, entries: [], truncated: false });
  api.getAgentFsDrives = async () => ({ drives: [] });
  // 임시 멤버 폼(TeamSlotRuntimeFields → RuntimeSelectionFields)이 여는 피드.
  api.listOrchestrationRuntimeHosts = async () => HOSTS;
  api.listCredentials = async () => [];
  api.listClaudeBackendProfiles = async () => ({ profiles: [] });
  api.listAgentTemplates = async () => [];
  api.getHostModels = async (hostId) => ({
    manager_agent_id: hostId, manager_name: hostId, is_online: true, instance_id: 'i-1',
    refreshed_at: new Date().toISOString(), models: {},
  });
  api.refreshHostModels = api.getHostModels;

  const element = (props) => h(ToastProvider, null, h(MissionFormModal, {
    isOpen: true, accountId, teams, mission, onClose: () => {}, onSaved: () => {}, ...props,
  }));
  const view = mount(element({}));
  await flush();

  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    globalThis.Audio = previousAudio;
    dom.cleanup();
  });
  return {
    container: view.container,
    created,
    updated,
    folderWrites,
    pickerHosts,
    /** 같은 모달에 props 만 바꿔 다시 그린다(닫기/다시 열기). */
    rerender: (props) => view.rerender(element(props)),
  };
}

// ── 1. 고르기 · 브랜치 · primary · 생성 payload ────────────────────────────

test('새 미션 — id 를 타이핑하지 않고 드롭다운만으로 project 를 여러 개 고르고 브랜치·primary 를 정해 저장한다', async (t) => {
  const { container, created } = await mountModal(t);

  // 예전 단일 저장소 피커(검색형 드롭다운 + project_id 수동 입력)는 없다.
  assert.equal(Boolean(container.querySelector(`select[aria-label="${ui("프로젝트 선택")}"]`)), false, '구 RepoRefPicker 가 남아 있으면 안 된다');
  assert.equal(Boolean(container.querySelector(`input[aria-label="${ui("project_id 직접 입력")}"]`)), false, '원시 id 를 타이핑할 자리가 없다');

  assert.match(section(container).textContent, /No project selected\./, '아무것도 고르지 않은 상태가 보인다');
  assert.deepEqual(
    optionLabels(addSelect(container)),
    [
      'Select a project',
      'AWB · https://github.com/parnmanas/ai-workflow-board.git',
      'Docs · https://github.com/example/p-docs.git',
      'GameClient · https://github.com/example/p-game.git',
    ],
    '미션 계정의 project 가 이름·URL 라벨로 나열된다',
  );

  addProject(container, 'p-awb');
  assert.deepEqual(projectRows(container), [{ name: 'AWB', branch: '', primary: true }], '첫 project 가 primary 다');
  assert.deepEqual(
    optionLabels(addSelect(container)),
    ['+ Add another project', 'Docs · https://github.com/example/p-docs.git', 'GameClient · https://github.com/example/p-game.git'],
    '고른 project 는 추가 목록에서 빠지고, 다음 선택은 "추가" 로 안내한다',
  );

  addProject(container, 'p-game');
  assert.deepEqual(projectRows(container), [
    { name: 'AWB', branch: '', primary: true },
    { name: 'GameClient', branch: '', primary: false },
  ]);
  assert.equal(branchInput(container, 'AWB').placeholder, 'branch (main)', '비워 두면 project 기본 브랜치라는 안내');
  assert.equal(branchInput(container, 'GameClient').placeholder, 'branch (develop)');
  assert.equal(
    [...branchInput(container, 'AWB').parentElement.querySelectorAll('button')].some((b) => b.textContent === 'Make primary'),
    false,
    '이미 primary 인 행에는 "Make primary" 가 없다',
  );

  typeInto(branchInput(container, 'GameClient'), '  release  ');
  click(rowButton(container, 'GameClient', 'Make primary'));
  assert.deepEqual(projectRows(container), [
    { name: 'GameClient', branch: '  release  ', primary: true },
    { name: 'AWB', branch: '', primary: false },
  ], 'Make primary 는 맨 앞으로 옮기고 브랜치는 그대로 따라간다');

  // Remove 하면 추가 목록으로 돌아가고, 다시 고르면 맨 뒤에 붙는다.
  click(rowButton(container, 'AWB', 'Remove'));
  assert.deepEqual(projectRows(container).map((r) => r.name), ['GameClient']);
  assert.ok(optionLabels(addSelect(container)).includes('AWB · https://github.com/parnmanas/ai-workflow-board.git'), '지운 project 를 다시 고를 수 있다');
  addProject(container, 'p-awb');

  fillRequired(container);
  assert.deepEqual(startProblems(container), [], '모든 슬롯이 고른 project 중 하나는 맡을 수 있다');
  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();

  assert.equal(created.length, 1, '생성이 실제로 전송된다');
  assert.deepEqual(
    created[0].projects,
    [{ project_id: 'p-game', branch: 'release' }, { project_id: 'p-awb' }],
    '선택 순서(primary 먼저) 그대로, 브랜치는 trim 해서, 빈 브랜치는 키째 빠진다',
  );
  assert.equal(created[0].folder_scope, 'shared', '기본 폴더 범위는 shared');
  assert.equal(created[0].start, true);
  assert.equal('repo_ref' in created[0], false, 'repo_ref 는 더 이상 보내지 않는다');
});

// ── 2. 멤버별 커버리지 · Set folder… ───────────────────────────────────────

test('멤버마다 고른 project 의 폴더가 그 Host 에 있는지 보여 준다 — ✓ 경로 / ✗ no folder', async (t) => {
  const { container } = await mountModal(t);

  addProject(container, 'p-awb');
  addProject(container, 'p-game');

  assert.deepEqual(coverageOf(container, 'rolf/orchestrator'), ['✓ AWB — /srv/awb', '✓ GameClient — /srv/game']);
  assert.deepEqual(coverageOf(container, 'rolf/implementer'), ['✓ AWB — /srv/awb', '✓ GameClient — /srv/game']);
  assert.deepEqual(
    coverageOf(container, 'ralf/reviewer'),
    ['✓ AWB — /home/ralf/awb', '✗ GameClient — no folder on this host'],
    '같은 project 라도 Host 마다 폴더가 다르다 — 줄은 고른 project 순서를 따른다',
  );
  assert.ok(setFolderButton(container, 'ralf/reviewer', 'GameClient'), '폴더가 없는 줄에서 바로 등록할 수 있다');
  assert.equal(cannotWork(container, 'ralf/reviewer'), false, '하나라도 맡을 수 있으면 경고하지 않는다');
  assert.deepEqual(startProblems(container), []);

  // Docs 는 ralf 에만 폴더가 있다 → rolf 의 orchestrator·implementer 가 걸리고, orchestrator 가 먼저다.
  click(rowButton(container, 'AWB', 'Remove'));
  click(rowButton(container, 'GameClient', 'Remove'));
  addProject(container, 'p-docs');
  assert.deepEqual(coverageOf(container, 'rolf/orchestrator'), ['✗ Docs — no folder on this host']);
  assert.equal(cannotWork(container, 'rolf/orchestrator'), true);
  assert.deepEqual(coverageOf(container, 'ralf/reviewer'), ['✓ Docs — /home/ralf/docs']);
  assert.deepEqual(startProblems(container), [
    'The orchestrator (rolf/orchestrator) has no folder for any selected project on its host.',
    'rolf/implementer has no folder for any selected project on its host — set one, or leave it out.',
  ]);
});

test('"Set folder…" 는 그 project·그 멤버의 Host 로 setProjectHostFolder 를 부르고, 표시를 다시 읽는다', async (t) => {
  const { container, folderWrites, pickerHosts } = await mountModal(t);

  addProject(container, 'p-game');
  assert.deepEqual(coverageOf(container, 'ralf/reviewer'), ['✗ GameClient — no folder on this host']);
  assert.equal(cannotWork(container, 'ralf/reviewer'), true, '어느 project 도 맡을 수 없으면 행에서 경고한다');
  assert.deepEqual(startProblems(container), [
    'ralf/reviewer has no folder for any selected project on its host — set one, or leave it out.',
  ]);

  click(setFolderButton(container, 'ralf/reviewer', 'GameClient'));
  await flush();
  assert.deepEqual(pickerHosts, [RALF], '폴더 선택기는 그 멤버의 Host 파일시스템을 연다');
  assert.equal(
    slotRow(container, 'ralf/reviewer').querySelector('input[type="checkbox"]').checked,
    true,
    '멤버 행(<label>) 안의 버튼을 눌러도 그 멤버가 제외되지 않는다',
  );

  click(buttonIn(container, 'Use this directory'));
  await flush();
  await flush();

  assert.deepEqual(
    folderWrites,
    [{ projectId: 'p-game', hostId: RALF, path: '/home/ralf/game' }],
    'Projects 화면과 같은 API 로 "그 Host 의 그 project 폴더" 를 등록한다',
  );
  assert.deepEqual(
    coverageOf(container, 'ralf/reviewer'),
    ['✓ GameClient — /home/ralf/game'],
    '등록 뒤 목록을 다시 읽어 ✓ 로 바뀐다(notifyProjectsChanged)',
  );
  assert.equal(cannotWork(container, 'ralf/reviewer'), false);
  assert.deepEqual(startProblems(container), [], '그 멤버 때문에 막혔던 시작이 풀린다');
  assert.match(toastText(container), /GameClient: folder set on this host/);
});

test('임시 멤버도 커버리지를 보여 주고 시작을 막는다 — "Set folder…" 는 그 임시 멤버의 Host 로 등록한다', async (t) => {
  const { container, created, folderWrites, pickerHosts } = await mountModal(t);

  fillRequired(container);
  addProject(container, 'p-awb');

  // orchestrator 런타임을 씨앗으로 열린 폼에서 Host 만 ragnar 로 바꿔 얹는다.
  click(buttonIn(container, '+ Add ad-hoc member for this mission'));
  await flush();
  await flush();
  typeInto(field(container, 'Role label', 'input'), 'gpu-tester');
  const hostSelect = field(container, 'Runtime Host', 'select');
  assert.ok(hostSelect, '임시 멤버 폼에 Runtime Host 선택이 있다');
  change(hostSelect, RAGNAR);
  await flush();
  click(buttonIn(container, 'Add to this mission'));
  await flush();

  assert.deepEqual(coverageOf(container, 'gpu-tester'), ['✗ AWB — no folder on this host']);
  assert.equal(cannotWork(container, 'gpu-tester'), true);
  assert.deepEqual(startProblems(container), [
    'gpu-tester has no folder for any selected project on its host — set one, or leave it out.',
  ]);

  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 0, '임시 멤버가 일할 곳이 없으면 요청을 보내지 않는다');

  click(setFolderButton(container, 'gpu-tester', 'AWB'));
  await flush();
  click(buttonIn(container, 'Use this directory'));
  await flush();
  await flush();
  assert.deepEqual(pickerHosts, [RAGNAR]);
  assert.deepEqual(folderWrites, [{ projectId: 'p-awb', hostId: RAGNAR, path: '/home/ragnar/awb' }]);
  assert.deepEqual(coverageOf(container, 'gpu-tester'), ['✓ AWB — /home/ragnar/awb']);

  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 1, '폴더를 등록하면 시작할 수 있다');
  assert.equal(created[0].extra_members.length, 1);
  assert.equal(created[0].extra_members[0].role_label, 'gpu-tester');
  assert.equal(created[0].extra_members[0].runtime.manager_agent_id, RAGNAR);
  assert.equal('working_dir' in created[0].extra_members[0].runtime, false, '슬롯은 폴더를 모른다');
});

// ── 3. 시작 차단 · draft 저장 · 제외 ───────────────────────────────────────

test('project 를 고르지 않은 draft 저장은 된다 — 막히는 것은 "즉시 브리핑" 생성뿐이다', async (t) => {
  const { container, created } = await mountModal(t);
  fillRequired(container);

  assert.deepEqual(startProblems(container), [NO_PROJECT], '즉시 브리핑이 켜져 있으면 막히는 이유가 체크박스 아래에 보인다');

  run(() => startCheckbox(container).click());
  assert.deepEqual(startProblems(container), [], 'draft 로 저장할 때는 시작 문제를 늘어놓지 않는다');
  click(buttonIn(container, 'Save draft'));
  await flush();

  assert.equal(created.length, 1, 'draft 저장은 project 없이도 전송된다');
  assert.equal(created[0].start, false);
  assert.deepEqual(created[0].projects, []);
});

test('어느 project 에도 폴더가 없는 멤버가 있으면 즉시 브리핑 생성은 요청 없이 막히고, draft 저장은 된다', async (t) => {
  const { container, created } = await mountModal(t, { teams: GPU_TEAMS });
  fillRequired(container);

  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 0, 'project 가 없으면 보내지 않는다');
  assert.match(toastText(container), /Pick at least one project/, '왜 막혔는지 토스트로도 말한다');

  addProject(container, 'p-awb');
  assert.deepEqual(coverageOf(container, 'ragnar/tester'), ['✗ AWB — no folder on this host']);
  assert.deepEqual(startProblems(container), [ragnarProblem], '남은 문제는 ragnar 멤버 하나뿐이다');

  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 0, '일할 곳이 없는 멤버가 있으면 서버의 409 대신 폼에서 막는다');
  assert.match(toastText(container), /ragnar\/tester has no folder for any selected project/);

  run(() => startCheckbox(container).click());
  assert.equal(Boolean(container.querySelector('[data-testid="mission-start-problems"]')), false);
  click(buttonIn(container, 'Save draft'));
  await flush();
  assert.equal(created.length, 1, 'draft 는 폴더가 갖춰지기 전에도 저장할 수 있다');
  assert.equal(created[0].start, false);
  assert.deepEqual(created[0].projects, [{ project_id: 'p-awb' }]);
});

test('일할 곳이 없는 멤버를 이번 미션에서 빼면 시작할 수 있다 — 제외는 멤버 행 id 로 나간다', async (t) => {
  const { container, created } = await mountModal(t, { teams: GPU_TEAMS });
  fillRequired(container);
  addProject(container, 'p-awb');
  assert.deepEqual(startProblems(container), [ragnarProblem]);

  run(() => slotRow(container, 'ragnar/tester').querySelector('input[type="checkbox"]').click());
  assert.deepEqual(coverageOf(container, 'ragnar/tester'), [], '제외한 멤버의 폴더는 따지지 않는다');
  assert.deepEqual(startProblems(container), []);

  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 1);
  assert.equal(created[0].start, true);
  assert.deepEqual(created[0].excluded_member_ids, ['m-gpu'], '멤버에는 agent_id 가 없다 — 행 id 로 뺀다');
  assert.deepEqual(created[0].projects, [{ project_id: 'p-awb' }]);
});

// ── 4. 편집 · 복원 ─────────────────────────────────────────────────────────

test('저장된 draft 를 다시 열면 projects·브랜치·folder_scope·체크아웃 옵션이 복원되고, 저장은 projects 로 나간다', async (t) => {
  const mission = baseMission({
    projects: [
      { project_id: 'p-game', branch: 'develop', name: 'GameClient' },
      { project_id: 'p-awb', branch: '', name: 'AWB' },
    ],
    folder_scope: 'isolated',
    workspace_folder: '.awb/billing',
    checkout_mode: 'fresh',
  });
  const { container, updated, rerender } = await mountModal(t, { mission });

  const expectRestored = (when) => {
    assert.deepEqual(projectRows(container), [
      { name: 'GameClient', branch: 'develop', primary: true },
      { name: 'AWB', branch: '', primary: false },
    ], `${when}: 순서(primary)·브랜치가 복원된다`);
    assert.equal(foldersSelect(container).value, 'isolated', `${when}: folder_scope 가 복원된다`);
    assert.equal(field(container, 'Checkout root (optional)', 'input')?.value, '.awb/billing', `${when}: 체크아웃 루트`);
    assert.equal(field(container, 'Checkout mode', 'select')?.value, 'fresh', `${when}: 체크아웃 모드`);
  };
  expectRestored('처음 열 때');
  assert.equal(Boolean(startCheckbox(container)), false, '편집에는 즉시 브리핑 체크박스가 없다');

  // 저장하지 않은 수정은 닫았다 다시 열면 버려지고, 저장된 값으로 돌아간다.
  typeInto(branchInput(container, 'AWB'), 'hotfix');
  click(rowButton(container, 'GameClient', 'Remove'));
  change(foldersSelect(container), 'shared');
  rerender({ isOpen: false });
  rerender({ isOpen: true });
  await flush();
  expectRestored('다시 열 때');

  click(buttonIn(container, 'Save'));
  await flush();
  assert.equal(updated.length, 1, '편집 저장이 실제로 전송된다');
  const data = updated[0].data;
  assert.deepEqual(data.projects, [{ project_id: 'p-game', branch: 'develop' }, { project_id: 'p-awb' }]);
  assert.equal(data.folder_scope, 'isolated');
  assert.equal(data.workspace_folder, '.awb/billing');
  assert.equal(data.checkout_mode, 'fresh');
  assert.equal('repo_ref' in data, false, '편집 경로도 repo_ref 를 보내지 않는다');
});

// ── 5. 미션 계정의 project 만 · 목록이 없는 동안의 보존 ─────────────────────

test('목록 API 가 모든 계정의 project 를 합쳐 줘도 미션 계정의 것만 고르고, 다른 계정의 팀으로 바꾸면 그 선택을 걷어낸다', async (t) => {
  const { container, created } = await mountModal(t);

  assert.equal(
    optionLabels(addSelect(container)).some((label) => label.startsWith('Ops')),
    false,
    '다른 계정(ws-2)의 project 는 고를 수 없다 — 서버가 "project(s) not found in this mission\'s account" 로 거부한다',
  );
  addProject(container, 'p-awb');
  assert.deepEqual(projectRows(container).map((r) => r.name), ['AWB']);

  const teamSelect = [...container.querySelectorAll('select')].find((s) => [...s.options].some((o) => o.value === 'team-ops'));
  assert.ok(teamSelect, 'Team 선택이 있다');
  change(teamSelect, 'team-ops');
  await flush();

  assert.deepEqual(projectRows(container), [], 'ws-2 팀으로 바꾸면 ws-1 의 AWB 는 걷어낸다');
  assert.match(section(container).textContent, /No project selected\./);
  assert.deepEqual(optionLabels(addSelect(container)), ['Select a project', 'Ops · https://github.com/example/p-ops.git']);

  addProject(container, 'p-ops');
  change(teamSelect, 'team-1');
  await flush();
  assert.deepEqual(projectRows(container), [], '돌아오면 ws-2 의 Ops 를 걷어낸다');

  addProject(container, 'p-awb');
  fillRequired(container);
  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();
  assert.equal(created.length, 1);
  assert.deepEqual(created[0].projects, [{ project_id: 'p-awb' }], '팀 계정의 project 만 나간다');
});

test('목록을 불러오는 동안에는 저장된 projects 를 지우지 않는다', async (t) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const mission = baseMission({ projects: [{ project_id: 'p-awb', branch: 'release', name: 'AWB' }] });
  const { container, updated } = await mountModal(t, { mission, listProjects: () => pending });

  assert.match(section(container).textContent, /p-awb/, '이름을 모르는 동안에도 저장된 선택이 행으로 남는다');
  assert.equal(projectRows(container).length, 1);
  assert.equal(projectRows(container)[0].branch, 'release');

  await act(async () => { release(ALL_PROJECTS); await pending; });
  await flush();
  assert.deepEqual(projectRows(container), [{ name: 'AWB', branch: 'release', primary: true }], '목록이 오면 같은 선택이 이름으로 보인다');

  click(buttonIn(container, 'Save'));
  await flush();
  assert.deepEqual(updated[0].data.projects, [{ project_id: 'p-awb', branch: 'release' }]);
});

test('목록 조회가 실패해도 편집 중인 draft 의 projects 를 지우지 않는다 — 다른 필드만 고쳐 저장해도 보존된다', async (t) => {
  // 실패한 목록은 "도착한 목록" 이 아니다. 빈 목록으로 보고 걷어내면 제목만 고쳐 저장했는데
  // 미션의 projects 가 [] 로 덮인다 — 사용자가 지운 적 없는 설정이 사라진다.
  const mission = baseMission({
    projects: [
      { project_id: 'p-awb', branch: 'release', name: 'AWB' },
      { project_id: 'p-game', branch: '', name: 'GameClient' },
    ],
  });
  const { container, updated } = await mountModal(t, {
    mission,
    listProjects: async () => { throw new Error('Forbidden'); },
  });
  await flush();

  assert.equal(projectRows(container).length, 2, '조회 실패 뒤에도 저장된 선택이 남아 있다');
  typeInto(field(container, 'Title', 'input'), 'Retitled mission');
  click(buttonIn(container, 'Save'));
  await flush();

  assert.equal(updated.length, 1);
  assert.deepEqual(
    updated[0].data.projects,
    [{ project_id: 'p-awb', branch: 'release' }, { project_id: 'p-game' }],
    '목록을 못 받은 동안 저장해도 projects 가 그대로 되돌아간다',
  );
});

// ── 6. 폴더 범위 ───────────────────────────────────────────────────────────

test('Folders = isolated 일 때만 체크아웃 루트/모드가 보이고, 고른 값이 payload 에 실린다 (Advanced 에서 옮겨 옴)', async (t) => {
  const { container, created } = await mountModal(t);

  const folders = foldersSelect(container);
  assert.equal(folders.value, 'shared', '기본은 shared — project 폴더 자체에서 돈다');
  assert.deepEqual([...folders.options].map((o) => o.value), ['shared', 'isolated'], '서버 MemberFolderScope 와 같은 어휘');
  assert.equal(Boolean(field(container, 'Checkout root (optional)', 'input')), false, 'shared 에는 체크아웃할 것이 없다');
  assert.equal(Boolean(field(container, 'Checkout mode', 'select')), false);

  // Advanced 에 있던 구 입력("Account folder root", 저장소 피커)은 사라졌다.
  click(buttonIn(container, '▸ Advanced — execution contract'));
  assert.match(container.textContent, /Post-completion actions/, 'Advanced 가 펼쳐졌다');
  assert.doesNotMatch(container.textContent, /Account folder root/);
  assert.doesNotMatch(container.textContent, /repo_ref/);
  assert.equal(Boolean(field(container, 'Checkout mode', 'select')), false, 'Advanced 에도 체크아웃 모드가 없다');

  change(foldersSelect(container), 'isolated');
  const root = field(container, 'Checkout root (optional)', 'input');
  const mode = field(container, 'Checkout mode', 'select');
  assert.ok(root, 'isolated 를 고르면 체크아웃 루트가 나타난다');
  assert.ok(mode, 'isolated 를 고르면 체크아웃 모드가 나타난다');
  assert.equal(root.placeholder, '.awb/orch/<mission id> (default)');
  assert.equal(mode.value, 'reuse', '기본 체크아웃 모드는 reuse');

  change(foldersSelect(container), 'shared');
  assert.equal(Boolean(field(container, 'Checkout root (optional)', 'input')), false, 'shared 로 돌리면 다시 숨는다');
  change(foldersSelect(container), 'isolated');

  typeInto(field(container, 'Checkout root (optional)', 'input'), '.awb/billing');
  change(field(container, 'Checkout mode', 'select'), 'fresh');
  addProject(container, 'p-awb');
  fillRequired(container);
  click(buttonIn(container, 'Create & brief orchestrator'));
  await flush();

  assert.equal(created.length, 1);
  assert.equal(created[0].folder_scope, 'isolated');
  assert.equal(created[0].workspace_folder, '.awb/billing');
  assert.equal(created[0].checkout_mode, 'fresh');
});
