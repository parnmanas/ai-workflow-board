import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from '../src/api.ts';
import { React, act, click, mount, setupDom } from './helpers/jsdom.mjs';
import {
  reconcileRuntimeProfileSelection,
  runtimeProfileForAgentUpdate,
} from '../src/utils/claudeRuntimeProfile.ts';

const { default: ManagedAgentDialog } = await import(
  '../src/components/admin/ManagedAgentDialog.tsx'
);

const profiles = [{ id: 'profile-valid', name: '유효 프로필' }];

const agent = {
  id: 'agent-1',
  name: 'Claude 작업자',
  type: 'claude',
  workspace_id: 'workspace-1',
  working_dir: '/workspace',
  cli_runtime_profile: 'profile-valid',
  runtime_config: { strategy: 'single', permission_mode: 'trusted' },
};

async function renderEditDialog(profileRequest) {
  const dom = setupDom();
  const originals = {
    listCredentials: api.listCredentials,
    listClaudeBackendProfiles: api.listClaudeBackendProfiles,
    listAgentManagerInstances: api.listAgentManagerInstances,
    updateAgent: api.updateAgent,
  };
  let updateCalls = 0;
  api.listCredentials = async () => [];
  api.listClaudeBackendProfiles = profileRequest;
  api.listAgentManagerInstances = async () => [{
    agent_id: 'manager-1',
    runtime_capabilities: { claude: { installed: true, healthy: true } },
  }];
  api.updateAgent = async () => { updateCalls += 1; };

  const view = mount(React.createElement(ManagedAgentDialog, {
    isOpen: true,
    onClose() {},
    managerAgentId: 'manager-1',
    mode: 'edit',
    agent,
    onSubmitted() {},
  }));
  await act(async () => {});

  return {
    view,
    updateCalls: () => updateCalls,
    cleanup() {
      view.unmount();
      Object.assign(api, originals);
      dom.cleanup();
    },
  };
}

function forceSubmit(view) {
  const save = [...view.container.querySelectorAll('button')]
    .find((button) => button.textContent.trim() === 'Save');
  assert.ok(save, '편집 대화상자의 Save 버튼이 있어야 한다');
  assert.equal(save.disabled, true, '프로필 목록 확인 전에는 Save 버튼도 비활성화되어야 한다');
  save.disabled = false;
  click(save);
}

test('프로필 조회 실패 시 실제 편집 제출 경로가 updateAgent 호출을 차단한다', async () => {
  const harness = await renderEditDialog(async () => { throw new Error('조회 실패'); });
  try {
    forceSubmit(harness.view);
    await act(async () => {});
    assert.equal(harness.updateCalls(), 0);
  } finally {
    harness.cleanup();
  }
});

test('프로필 조회 중에도 실제 편집 제출 경로가 updateAgent 호출을 차단한다', async () => {
  const harness = await renderEditDialog(() => new Promise(() => {}));
  try {
    forceSubmit(harness.view);
    await act(async () => {});
    assert.equal(harness.updateCalls(), 0);
  } finally {
    harness.cleanup();
  }
});

test('프로필 조회 성공 시 stale 선택을 해제하고 수정 payload로 전송하지 않는다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-stale', profiles);
  const payload = { cli_runtime_profile: runtimeProfileForAgentUpdate('claude', selection, profiles, 'ready') };
  assert.equal(selection, '');
  assert.equal(payload.cli_runtime_profile, null);
});

test('권위 목록의 유효한 선택값은 수정 payload에 유지한다', () => {
  const selection = reconcileRuntimeProfileSelection('profile-valid', profiles);
  const payload = { cli_runtime_profile: runtimeProfileForAgentUpdate('claude', selection, profiles, 'ready') };
  assert.equal(payload.cli_runtime_profile, 'profile-valid');
});

// 티켓 e616dbfc — 프로필이 인스턴스 전역이 되면서 드롭다운은 워크스페이스
// allow-set 으로 거르지 않는다. 예전 응답은 profiles + allowed_profile_ids 였고
// 컴포넌트가 그 교집합만 보여줬는데, 지금은 전역 카탈로그를 그대로 렌더한다.
// 이 테스트는 필터가 되살아나 목록이 조용히 비는 회귀를 막는다.
test('전역 카탈로그를 워크스페이스 필터 없이 그대로 드롭다운에 채운다', async () => {
  const harness = await renderEditDialog(async () => ({
    profiles: [
      { id: 'profile-valid', name: '유효 프로필' },
      { id: 'profile-from-another-workspace', name: '다른 워크스페이스에서 만든 프로필' },
    ],
    default_profile_id: null,
  }));
  try {
    const select = [...harness.view.container.querySelectorAll('select')]
      .find(node => [...node.options].some(option => option.value === 'profile-valid'));
    assert.ok(select, '프로필 셀렉트를 찾을 수 없습니다.');
    const values = [...select.options].map(option => option.value);
    assert.deepEqual(values, ['', 'none', 'profile-valid', 'profile-from-another-workspace']);
    // 상속 라벨도 사라진 workspace 단계를 더 이상 약속하지 않아야 한다.
    assert.equal(select.options[0].textContent, 'Inherit board / global default');
    assert.equal(select.disabled, false, '목록을 받은 뒤에는 선택할 수 있어야 합니다.');
  } finally {
    harness.cleanup();
  }
});
