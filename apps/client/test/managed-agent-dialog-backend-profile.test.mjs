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
    getWorkspaceClaudeBackendProfiles: api.getWorkspaceClaudeBackendProfiles,
    listAgentManagerInstances: api.listAgentManagerInstances,
    updateAgent: api.updateAgent,
  };
  let updateCalls = 0;
  api.listCredentials = async () => [];
  api.getWorkspaceClaudeBackendProfiles = profileRequest;
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
