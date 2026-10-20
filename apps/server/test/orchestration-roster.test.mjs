// 미션 runtime roster — slot × project 해소(orchestration-roster.ts)와 slot spec 정규화
// (orchestration-member-spec.ts)의 순수 로직 회귀 테스트.
//
// 고정하는 계약:
//   1. 팀 slot 은 폴더를 갖지 않는다 — 입력의 working_dir/folder_scope 는 무시되고, 실행
//      spec 은 "slot + 그 project 의 slot Host 폴더" 로만 만들어진다.
//   2. slot 은 자기 Host 에 폴더가 있는 project 마다 runtime 하나를 갖는다. 모델만 다른 두
//      slot 은 같은 폴더에서 identity 를 공유하지만 로스터에서는 따로 배정된다.
//   3. 오케스트레이터는 자기 Host 에 폴더가 있는 첫 project 에서 돈다. 어느 project 도
//      맡을 수 없는 slot 이 있으면 무엇을 고칠지 한 번에 말한다.
//   4. step 배정은 slot + project 로 해소된다: project 추론, 이름 지정, 레거시 identity
//      별칭, 맡을 수 없는 project 거부.
//   5. shared 미션끼리 같은 Host·같은 폴더의 멤버 runtime 이 겹치면 충돌이다.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ORCHESTRATOR_SLOT_ID,
  folderMatesOf,
  readRuntimeRoster,
  resolveMissionRoster,
  resolveStepAssignment,
  runtimesForSlot,
  sharedFolderConflict,
  slotDisplayName,
} from '../dist/modules/orchestration/orchestration-roster.js';
import {
  mergeTeamSlotSpec,
  normalizeTeamSlotSpec,
  parseTeamSlotSpec,
  sameTeamSlotSpec,
  slotExecutionSpec,
} from '../dist/common/orchestration-member-spec.js';
import { runtimeIdentityKey } from '../dist/common/runtime-spec.js';

const slotSpec = (host, extra = {}) => normalizeTeamSlotSpec({
  manager_agent_id: host,
  cli: 'claude',
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
  ...extra,
}, 'slot');

const slot = (slot_id, host, extra = {}, role = slot_id) => ({
  slot_id,
  kind: 'member',
  name: slotDisplayName(host, role, 'claude'),
  role_label: role,
  capabilities: '',
  max_concurrent: 1,
  spec: slotSpec(host, extra),
});

const project = (id, name, folders) => ({
  id, name, repo_url: `https://example.test/${id}.git`, branch: 'main', instructions: '',
  host_folders: new Map(Object.entries(folders)),
});

const orchestrator = { ...slot(ORCHESTRATOR_SLOT_ID, 'rolf'), kind: 'orchestrator', role_label: '' };
const APP = project('p-app', 'App', { rolf: '/srv/app', ralf: 'E:\\repo\\app' });
const SERVER = project('p-server', 'Server', { rolf: '/srv/server' });

function resolve(members, projects = [APP, SERVER], folderScope = 'shared') {
  const result = resolveMissionRoster({ orchestrator, members, projects, folderScope, hostName: (id) => `host:${id}` });
  if ('error' in result) throw new Error(result.error);
  return result.roster;
}

test('slot spec — working_dir/folder_scope 입력은 무시되고 slot 에는 폴더가 없다', () => {
  const spec = slotSpec('rolf', { working_dir: '/old/agent/home', folder_scope: 'isolated', model: 'opus' });
  assert.equal(spec.working_dir, undefined);
  assert.equal(spec.folder_scope, undefined);
  assert.equal(spec.model, 'opus');
  // 폴더를 들고 있던 이전 빌드의 저장 행도 읽힌다(키는 버려진다).
  const legacy = parseTeamSlotSpec(JSON.stringify({ ...spec, working_dir: '/x', folder_scope: 'shared' }));
  assert.deepEqual(legacy, spec);
  // 실행 spec 은 slot + 폴더로만 만든다.
  const exec = slotExecutionSpec(spec, '/srv/app', 'isolated');
  assert.equal(exec.working_dir, '/srv/app');
  assert.equal(exec.folder_scope, 'isolated');
  assert.throws(() => slotExecutionSpec(spec, 'relative/dir', 'shared'), /absolute path/);
});

test('slot spec — 부분 patch 와 CLI 변경 시 runtime_config 이월, 동일 slot 판정', () => {
  const base = slotSpec('rolf', { model: 'opus', credential_id: 'cred-1' });
  const patched = mergeTeamSlotSpec(base, { model: 'sonnet' }, 'slot');
  assert.equal(patched.model, 'sonnet');
  assert.equal(patched.credential_id, 'cred-1', 'patch 에 없는 필드는 유지된다');
  const recli = mergeTeamSlotSpec(base, { cli: 'codex' }, 'slot');
  assert.equal(recli.runtime_config.strategy, 'single');
  assert.equal(recli.runtime_config.permission_mode, 'strict', '권한 단계는 CLI 를 바꿔도 지킨다');
  assert.ok(sameTeamSlotSpec(base, slotSpec('rolf', { model: 'opus', credential_id: 'cred-1' })));
  assert.ok(!sameTeamSlotSpec(base, patched));
});

test('roster — slot 마다 Host 에 폴더가 있는 project 수만큼 runtime 이 생긴다', () => {
  const roster = resolve([slot('builder', 'rolf'), slot('windows', 'ralf')]);
  assert.deepEqual(
    runtimesForSlot(roster, 'builder').map((r) => [r.project_id, r.spec.working_dir]),
    [['p-app', '/srv/app'], ['p-server', '/srv/server']],
  );
  assert.deepEqual(runtimesForSlot(roster, 'windows').map((r) => r.project_id), ['p-app'],
    'ralf 에는 Server 폴더가 없으므로 App 만 맡는다');
  const orch = roster.runtimes.find((r) => r.slot_id === ORCHESTRATOR_SLOT_ID);
  assert.equal(orch.project_id, 'p-app', '오케스트레이터는 자기 Host 에 폴더가 있는 첫 project 에서 돈다');
  assert.equal(orch.agent_id, runtimeIdentityKey(orch.spec));
});

test('roster — 오케스트레이터 Host 에 primary 가 없으면 폴더가 있는 다음 project 에서 돈다', () => {
  const roster = resolve([slot('builder', 'rolf')], [project('p-docs', 'Docs', { ralf: 'E:\\docs' }), SERVER]);
  assert.equal(roster.runtimes.find((r) => r.slot_id === ORCHESTRATOR_SLOT_ID).project_id, 'p-server');
});

test('roster — 미션을 만든 오케스트레이터 identity 가 미션 project 폴더에서 돌면 그 자리를 지킨다', () => {
  // create_orchestration_mission 은 만든 agent 의 identity 를 draft 에 찍어 둔다. 그 agent 가
  // 미션 project 중 하나의 폴더에서 돌고 있으면, 첫 project 대신 그 폴더에 오케스트레이터를
  // 둬야 "만든 쪽이 계속 지휘한다" — 아니면 다른 세션이 브리핑받는다.
  const creatorInServer = runtimeIdentityKey(slotExecutionSpec(orchestrator.spec, '/srv/server', 'shared'));
  const kept = resolveMissionRoster({
    orchestrator, members: [slot('builder', 'rolf')], projects: [APP, SERVER], folderScope: 'shared',
    hostName: String, preferOrchestratorIdentity: creatorInServer,
  });
  const orch = kept.roster.runtimes.find((r) => r.slot_id === ORCHESTRATOR_SLOT_ID);
  assert.equal(orch.project_id, 'p-server');
  assert.equal(orch.agent_id, creatorInServer);

  const elsewhere = resolveMissionRoster({
    orchestrator, members: [slot('builder', 'rolf')], projects: [APP, SERVER], folderScope: 'shared',
    hostName: String, preferOrchestratorIdentity: 'rt-0000000000000000',
  });
  assert.equal(elsewhere.roster.runtimes.find((r) => r.slot_id === ORCHESTRATOR_SLOT_ID).project_id, 'p-app',
    '미션 폴더 밖의 identity 면 기본 규칙(첫 project)대로 둔다');
});

test('roster — 모델만 다른 두 slot 은 한 폴더에서 identity 를 공유하지만 따로 배정된다', () => {
  const roster = resolve([slot('opus', 'rolf', { model: 'opus' }), slot('sonnet', 'rolf', { model: 'sonnet' })], [APP]);
  const [a] = runtimesForSlot(roster, 'opus');
  const [b] = runtimesForSlot(roster, 'sonnet');
  assert.equal(a.agent_id, b.agent_id, '같은 CLI·폴더·credential 은 같은 identity');
  assert.equal(a.spec.model, 'opus');
  assert.equal(b.spec.model, 'sonnet', '모델은 runtime 마다 그대로 실린다');
  const picked = resolveStepAssignment(roster, [{ id: 'p-app', name: 'App' }], { slot: 'sonnet' });
  assert.equal(picked.slot.slot_id, 'sonnet');
  assert.equal(picked.runtime.spec.model, 'sonnet');
  assert.deepEqual(folderMatesOf(roster, a).map((m) => m.slot_id), ['sonnet']);
});

test('roster — 어느 project 도 맡을 수 없는 멤버와 오케스트레이터를 한 번에 알린다', () => {
  const result = resolveMissionRoster({
    orchestrator: { ...orchestrator, spec: slotSpec('ragnar') },
    members: [slot('builder', 'rolf'), slot('gpu', 'ragnar', {}, 'gpu')],
    projects: [SERVER],
    folderScope: 'shared',
    hostName: (id) => `host:${id}`,
  });
  assert.ok('error' in result);
  assert.match(result.error, /orchestrator runs on host:ragnar, which has no folder registered for any of this mission's projects \(Server\)/);
  assert.match(result.error, /ragnar\/gpu runs on host:ragnar, which has no folder registered/);
  assert.doesNotMatch(result.error, /builder/, '맡을 수 있는 멤버는 말하지 않는다');
  const empty = resolveMissionRoster({ orchestrator, members: [], projects: [], folderScope: 'shared', hostName: String });
  assert.match(empty.error, /names no project/);
});

test('step 배정 — project 추론, 이름 지정, 거부 사유', () => {
  const roster = resolve([slot('builder', 'rolf'), slot('windows', 'ralf')]);
  const projects = [{ id: 'p-app', name: 'App' }, { id: 'p-server', name: 'Server' }];

  const inferred = resolveStepAssignment(roster, projects, { slot: 'windows' });
  assert.equal(inferred.runtime.project_id, 'p-app', '맡을 수 있는 project 가 하나면 생략해도 된다');
  assert.equal(inferred.runtime.spec.working_dir, 'E:\\repo\\app');

  const ambiguous = resolveStepAssignment(roster, projects, { slot: 'builder' });
  assert.match(ambiguous.error, /more than one of this mission's projects — name the step's project: App \(p-app\), Server \(p-server\)/);

  const byName = resolveStepAssignment(roster, projects, { slot: 'builder', project: 'server' });
  assert.equal(byName.runtime.project_id, 'p-server', '정확한 이름(대소문자 무시)도 받는다');

  const lacking = resolveStepAssignment(roster, projects, { slot: 'windows', project: 'p-server' });
  assert.match(lacking.error, /cannot work on Server: its host has no folder registered for that project\. .* can work on: App \(p-app\)/);

  const unknownProject = resolveStepAssignment(roster, projects, { slot: 'builder', project: 'nope' });
  assert.match(unknownProject.error, /"nope" is not one of this mission's projects/);

  const unknownSlot = resolveStepAssignment(roster, projects, { slot: 'ghost' });
  assert.match(unknownSlot.error, /not a member of this mission's roster.*builder/);

  const orchestratorAsAssignee = resolveStepAssignment(roster, projects, { slot: ORCHESTRATOR_SLOT_ID });
  assert.ok('error' in orchestratorAsAssignee, '오케스트레이터 slot 자체는 배정 대상이 아니다');
});

test('step 배정 — 레거시 identity 별칭은 slot 하나에만 대응할 때만 받는다', () => {
  const roster = resolve([slot('builder', 'rolf'), slot('windows', 'ralf')]);
  const projects = [{ id: 'p-app', name: 'App' }, { id: 'p-server', name: 'Server' }];
  const serverRuntime = runtimesForSlot(roster, 'builder').find((r) => r.project_id === 'p-server');
  const viaIdentity = resolveStepAssignment(roster, projects, { slot: serverRuntime.agent_id });
  assert.equal(viaIdentity.slot.slot_id, 'builder');
  assert.equal(viaIdentity.runtime.project_id, 'p-server', 'identity 가 project 까지 정한다');

  const twins = resolve([slot('opus', 'rolf', { model: 'opus' }), slot('sonnet', 'rolf', { model: 'sonnet' })], [APP]);
  const shared = runtimesForSlot(twins, 'opus')[0].agent_id;
  assert.ok('error' in resolveStepAssignment(twins, [{ id: 'p-app', name: 'App' }], { slot: shared }),
    '두 slot 이 공유하는 identity 는 어느 slot 인지 모호하므로 거부한다');
});

test('shared 충돌 — 같은 Host·같은 폴더의 멤버 runtime 이 겹칠 때만, isolated 는 제외', () => {
  const mine = resolve([slot('builder', 'rolf')], [APP]);
  const other = (folderScope, members, projects = [APP]) => resolve(members, projects, folderScope);

  const hit = sharedFolderConflict(mine, [
    { id: 'm-2', title: 'Other', status: 'running', roster: other('shared', [slot('x', 'rolf')]) },
  ]);
  assert.deepEqual(hit && { id: hit.mission.id, host: hit.host, folder: hit.folder },
    { id: 'm-2', host: 'rolf', folder: '/srv/app' });

  assert.equal(sharedFolderConflict(mine, [
    { id: 'm-3', title: 'Iso', status: 'running', roster: other('isolated', [slot('x', 'rolf')]) },
  ]), null, '상대가 isolated 면 충돌이 아니다');
  assert.equal(sharedFolderConflict(mine, [
    { id: 'm-4', title: 'Elsewhere', status: 'running', roster: other('shared', [slot('x', 'ralf')]) },
  ]), null, '같은 project 라도 다른 Host 면 다른 체크아웃이다');
  assert.equal(sharedFolderConflict(resolve([slot('builder', 'rolf')], [APP], 'isolated'), [
    { id: 'm-5', title: 'Shared', status: 'running', roster: other('shared', [slot('x', 'rolf')]) },
  ]), null, '내가 isolated 면 겹치지 않는다');
  // 오케스트레이터만 같은 폴더에 있는 미션은 쓰는 쪽이 아니다.
  assert.equal(sharedFolderConflict(mine, [
    { id: 'm-6', title: 'Planner only', status: 'running', roster: other('shared', [slot('x', 'ralf')], [APP]) },
  ]), null);
});

test('저장된 로스터 읽기 — 왕복은 같고, 깨진 값은 null 로 떨어진다', () => {
  const roster = resolve([slot('builder', 'rolf'), slot('windows', 'ralf')]);
  const back = readRuntimeRoster(JSON.parse(JSON.stringify(roster)));
  assert.deepEqual(back, roster);
  assert.deepEqual(readRuntimeRoster(JSON.stringify(roster)), roster, 'JSON 문자열로 저장된 행도 읽힌다');
  assert.equal(readRuntimeRoster(null), null);
  assert.equal(readRuntimeRoster({ version: 2 }), null);
  assert.equal(readRuntimeRoster('{broken'), null);
});
