// Teams never reintroduce the removed workspace/scope picker.
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, React, act, click } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import { TeamFormModal } from '../src/components/orchestration/OrchestrationTeamsPage.tsx';

function baseTeam(overrides) {
  return {
    id: 'team-1',
    account_id: null,
    is_global: false,
    owner_account_id: null,
    allowed_account_ids: [],
    name: 'Platform squad',
    description: '',
    orchestrator_agent_id: 'agent-1',
    orchestrator_name: 'Orchestrator',
    orchestrator_online: true,
    orchestrator_prompt: '',
    max_parallel_steps: 3,
    max_open_missions: 1,
    enabled: true,
    members: [],
    active_mission_count: 0,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    ...overrides,
  };
}

async function mountModal(t, { team }) {
  const dom = setupDom();
  const view = mount(
    React.createElement(TeamFormModal, {
      isOpen: true,
      accountId: 'ws-1',
      hosts: [],
      credentials: [],
      backendProfiles: [],
      team,
      onClose: () => {},
      onSaved: () => {},
    }),
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  t.after(() => {
    view.unmount();
    dom.cleanup();
  });
  return view;
}

for (const team of [
  null,
  baseTeam({ account_id: 'ws-1', owner_account_id: 'ws-1' }),
  baseTeam({ is_global: true, owner_account_id: 'ws-1', allowed_account_ids: ['ws-1', 'ws-2'] }),
]) {
  test(`team ${team ? team.is_global ? 'shared edit' : 'owned edit' : 'creation'} has no workspace/scope controls`, async (t) => {
    const { container } = await mountModal(t, { team });
    assert.doesNotMatch(container.textContent, /Scope|This account|Global|Allowed accounts/);
    for (const select of container.querySelectorAll('select')) {
      assert.ok([...select.options].every((option) => !['ws-1', 'ws-2', 'global', 'account'].includes(option.value)));
    }
  });
}

test('editing a shared team leaves its ownership and allowed-account policy untouched', async (t) => {
  const team = baseTeam({
    is_global: true, owner_account_id: 'ws-1', allowed_account_ids: ['ws-1', 'ws-2'],
    orchestrator_runtime: {
      manager_agent_id: 'host-1', cli: 'claude', model: null,
      runtime_config: { strategy: 'single', permission_mode: 'default' },
    },
  });
  const original = api.updateOrchestrationTeam;
  const calls = [];
  api.updateOrchestrationTeam = async (id, body) => { calls.push({ id, body }); return team; };
  t.after(() => { api.updateOrchestrationTeam = original; });
  const { container } = await mountModal(t, { team });
  await act(async () => { click([...container.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Save')); });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.account_id, 'ws-1');
  assert.equal('is_global' in calls[0].body, false);
  assert.equal('allowed_account_ids' in calls[0].body, false);
});
