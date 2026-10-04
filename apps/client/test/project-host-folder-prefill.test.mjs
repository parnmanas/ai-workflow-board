// 프로젝트 Host 별 메인 클론 폴더 → RuntimeSpec working_dir 채우기 (docs/tickets.md).
//
// 티켓 폼·티켓 패널 담당자·프로젝트 기본 담당자·팀 슬롯이 공유하는 순수 로직:
//   1. 프로젝트의 폴더는 Host 단위로 찾는다(Host id + legacy alias 목록도 받는다)
//   2. 비어 있는 working_dir 만 채운다 — 사람이 적은 경로는 force 없이는 덮지 않는다
//   3. 새 티켓에서 프로젝트를 고르면 기본 담당자(default_assignee)로 채우되, 사람이 이미
//      담당자를 손댔으면 그 담당자를 유지한다(폴더만 채움)
//   4. "프로젝트 폴더 사용" 선택지는 이 Host 에 폴더가 없는 프로젝트를 path:null 로 표시한다
//
// 실행: node --import tsx --test test/project-host-folder-prefill.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyProjectFolder,
  prefillAssigneeForProject,
  projectFolderChoices,
  projectFolderForHost,
} from '../src/projects/projectFolders.ts';
import { emptyRuntimeSpec } from '../src/runtime/runtimeSpec.ts';

const project = {
  id: 'p1',
  name: 'awb',
  host_folders: [
    { host_id: 'h-rolf', path: '/home/parn/awb' },
    { host_id: 'h-ralf', path: 'E:\\work\\awb' },
    { host_id: 'h-blank', path: '   ' },
  ],
  default_assignee: null,
};

const spec = (patch = {}) => ({ ...emptyRuntimeSpec(), cli: 'claude', ...patch });

test('projectFolderForHost: Host 별 폴더, 없거나 공백이면 null', () => {
  assert.equal(projectFolderForHost(project, 'h-rolf'), '/home/parn/awb');
  assert.equal(projectFolderForHost(project, 'h-ralf'), 'E:\\work\\awb');
  assert.equal(projectFolderForHost(project, 'h-blank'), null);
  assert.equal(projectFolderForHost(project, 'h-none'), null);
  assert.equal(projectFolderForHost(project, ''), null);
  assert.equal(projectFolderForHost(null, 'h-rolf'), null);
  assert.equal(projectFolderForHost({ id: 'x' }, 'h-rolf'), null, 'host_folders 없음');
});

test('projectFolderForHost: Host id 와 legacy alias 목록 중 하나라도 맞으면 찾는다', () => {
  assert.equal(projectFolderForHost(project, ['legacy-uuid', 'h-rolf']), '/home/parn/awb');
  assert.equal(projectFolderForHost(project, [null, undefined, 'nope']), null);
});

test('applyProjectFolder: 빈 working_dir 만 채우고, 같은 객체를 돌려주면 변경 없음', () => {
  const empty = spec({ manager_agent_id: 'h-rolf' });
  assert.equal(applyProjectFolder(empty, project).working_dir, '/home/parn/awb');

  const typed = spec({ manager_agent_id: 'h-rolf', working_dir: '/srv/other' });
  assert.equal(applyProjectFolder(typed, project), typed, '사람이 적은 경로는 그대로');
  assert.equal(applyProjectFolder(typed, project, { force: true }).working_dir, '/home/parn/awb');

  const noFolder = spec({ manager_agent_id: 'h-none' });
  assert.equal(applyProjectFolder(noFolder, project), noFolder, '그 Host 에 폴더가 없으면 그대로');
  assert.equal(applyProjectFolder(empty, null), empty, '프로젝트 없음');
});

test('prefillAssigneeForProject: 손대지 않은 새 티켓은 프로젝트 기본 담당자 + 그 Host 의 폴더', () => {
  const withDefault = {
    ...project,
    default_assignee: { manager_agent_id: 'h-rolf', cli: 'codex', model: 'gpt-5', working_dir: '', label: 'awb-coder', runtime_config: { strategy: 'single', permission_mode: 'trusted' } },
  };
  const result = prefillAssigneeForProject(null, withDefault, { assigneeTouched: false });
  assert.equal(result.cli, 'codex');
  assert.equal(result.model, 'gpt-5');
  assert.equal(result.label, 'awb-coder');
  assert.equal(result.working_dir, '/home/parn/awb', '기본 담당자에 폴더가 없으면 Host 폴더로 채운다');
  assert.equal(result.folder_scope, 'shared', '빠진 키는 emptyRuntimeSpec 기본값');
  assert.deepEqual(result.runtime_config, { strategy: 'single', permission_mode: 'trusted' });
  assert.notEqual(result.runtime_config, withDefault.default_assignee.runtime_config, 'runtime_config 는 복사본');

  const explicitDir = { ...withDefault, default_assignee: { ...withDefault.default_assignee, working_dir: '/opt/awb' } };
  assert.equal(prefillAssigneeForProject(null, explicitDir, { assigneeTouched: false }).working_dir, '/opt/awb');
});

test('prefillAssigneeForProject: 사람이 담당자를 정했으면 유지하고 빈 폴더만 채운다', () => {
  const withDefault = { ...project, default_assignee: { manager_agent_id: 'h-ralf', cli: 'codex', working_dir: '' } };
  const mine = spec({ manager_agent_id: 'h-rolf' });
  const kept = prefillAssigneeForProject(mine, withDefault, { assigneeTouched: true });
  assert.equal(kept.manager_agent_id, 'h-rolf');
  assert.equal(kept.cli, 'claude');
  assert.equal(kept.working_dir, '/home/parn/awb');

  assert.equal(prefillAssigneeForProject(null, withDefault, { assigneeTouched: true }), null, '비워 둔 담당자는 비운 채로');
  assert.equal(prefillAssigneeForProject(mine, null, { assigneeTouched: false }), mine, '프로젝트 해제는 그대로');
  const noDefault = prefillAssigneeForProject(spec({ manager_agent_id: 'h-ralf' }), project, { assigneeTouched: false });
  assert.equal(noDefault.working_dir, 'E:\\work\\awb', '기본 담당자가 없으면 현재 담당자에 폴더만');
});

test('projectFolderChoices: 프로젝트마다 이 Host 의 폴더(없으면 null)', () => {
  const other = { id: 'p2', name: '', host_folders: [{ host_id: 'h-ralf', path: 'D:\\x' }] };
  assert.deepEqual(projectFolderChoices([project, other], 'h-rolf'), [
    { id: 'p1', name: 'awb', path: '/home/parn/awb' },
    { id: 'p2', name: 'p2', path: null },
  ]);
  assert.deepEqual(projectFolderChoices([project], null).map((c) => c.path), [null]);
});
