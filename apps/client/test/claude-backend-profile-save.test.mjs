import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import ClaudeBackendProfilesManager from '../src/components/admin/ClaudeBackendProfilesManager.tsx';

const existingProfile = {
  id: 'profile-1', name: '기존 프로필', kind: 'claude-backend', protocol: 'openai-compatible',
  base_url: 'https://example.test', model: 'claude-test', omit_effort: true,
  credential_required: true, credential_ref: 'credential-1', auth_env: 'ANTHROPIC_AUTH_TOKEN',
  adapter: { request: { model_field: 'model' } },
};

const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  assert.ok(found, `${label} 버튼을 찾을 수 없습니다.`);
  return found;
}

function inputByLabel(container, label) {
  const labels = [...container.querySelectorAll('label')];
  const owner = labels.find(item => item.textContent?.includes(label));
  const input = (owner?.htmlFor ? container.querySelector(`#${owner.htmlFor}`) : null)
    || owner?.querySelector('input, textarea, select')
    || owner?.parentElement?.querySelector('input, textarea, select');
  assert.ok(input, `${label} 입력을 찾을 수 없습니다.`);
  return input;
}

test('기존 Claude 고유 필드를 손실 없이 수정 payload로 전달한다', async (t) => {
  const dom = setupDom();
  const originals = {
    getClaudeBackendProfiles: api.getClaudeBackendProfiles,
    updateClaudeBackendProfile: api.updateClaudeBackendProfile,
  };
  const calls = [];
  api.getClaudeBackendProfiles = async () => ({ profiles: [existingProfile], default_profile_id: null });
  api.updateClaudeBackendProfile = async (id, payload) => { calls.push({ id, payload }); };
  const view = mount(React.createElement(ClaudeBackendProfilesManager));
  await flush();
  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });

  click(button(view.container, '기존 프로필'));
  const nameInput = [...view.container.querySelectorAll('input')].find(input => input.value === '기존 프로필');
  assert.ok(nameInput);
  typeInto(nameInput, '수정된 프로필');
  click(button(view.container, 'Save profile'));
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'profile-1');
  assert.deepEqual(calls[0].payload, { ...existingProfile, name: '수정된 프로필' });
});

test('새 프로필 생성 payload에 auth_env, 플래그, adapter JSON을 그대로 전달한다', async (t) => {
  const dom = setupDom();
  const originals = {
    getClaudeBackendProfiles: api.getClaudeBackendProfiles,
    createClaudeBackendProfile: api.createClaudeBackendProfile,
  };
  const calls = [];
  api.getClaudeBackendProfiles = async () => ({ profiles: [], default_profile_id: null });
  api.createClaudeBackendProfile = async payload => { calls.push(payload); };
  const view = mount(React.createElement(ClaudeBackendProfilesManager));
  await flush();
  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });

  typeInto(inputByLabel(view.container, 'Stable ID'), 'new-profile');
  typeInto(inputByLabel(view.container, 'Name'), '신규 프로필');
  typeInto(inputByLabel(view.container, 'Model'), 'claude-new');
  typeInto(inputByLabel(view.container, 'Base URL'), 'https://new.example.test');
  typeInto(inputByLabel(view.container, 'Authentication environment variable'), 'CUSTOM_CLAUDE_TOKEN');
  click(inputByLabel(view.container, 'Credential required'));
  click(inputByLabel(view.container, 'Do not set effort'));
  typeInto(inputByLabel(view.container, 'Adapter config'), '{"request":{"model_field":"deployment"}}');
  click(button(view.container, 'Save profile'));
  await flush();

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    id: 'new-profile',
    name: '신규 프로필',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'https://new.example.test',
    model: 'claude-new',
    omit_effort: true,
    credential_required: true,
    auth_env: 'CUSTOM_CLAUDE_TOKEN',
    adapter: { request: { model_field: 'deployment' } },
  });
});

test('저장 중 버튼을 비활성화하고 실패 후 다시 저장할 수 있게 복구한다', async (t) => {
  const dom = setupDom();
  const originals = {
    getClaudeBackendProfiles: api.getClaudeBackendProfiles,
    createClaudeBackendProfile: api.createClaudeBackendProfile,
  };
  let rejectSave;
  let calls = 0;
  api.getClaudeBackendProfiles = async () => ({ profiles: [], default_profile_id: null });
  api.createClaudeBackendProfile = () => {
    calls += 1;
    return new Promise((_, reject) => { rejectSave = reject; });
  };
  const view = mount(React.createElement(ClaudeBackendProfilesManager));
  await flush();
  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });

  const save = button(view.container, 'Save profile');
  click(save);
  assert.equal(calls, 1);
  assert.equal(save.disabled, true);
  assert.ok(save.querySelector('[aria-hidden="true"]'), '저장 중 스피너가 표시되어야 합니다.');
  click(save);
  assert.equal(calls, 1, '저장 중 중복 요청을 보내면 안 됩니다.');

  await act(async () => { rejectSave(new Error('의도한 저장 실패')); });
  assert.equal(save.disabled, false);
  assert.equal(save.querySelector('[aria-hidden="true"]'), null);
});

test('편집 취소는 빈 생성 폼으로 돌아간다', async (t) => {
  const dom = setupDom();
  const originalGet = api.getClaudeBackendProfiles;
  api.getClaudeBackendProfiles = async () => ({ profiles: [existingProfile], default_profile_id: null });
  const view = mount(React.createElement(ClaudeBackendProfilesManager));
  await flush();
  t.after(() => {
    view.unmount();
    api.getClaudeBackendProfiles = originalGet;
    dom.cleanup();
  });

  click(button(view.container, '기존 프로필'));
  assert.match(view.container.textContent, /Edit 기존 프로필/);
  click(button(view.container, 'Cancel'));
  assert.match(view.container.textContent, /Create profile/);
  assert.equal(view.container.querySelector('input')?.value, '');
});

test('프로필 셸과 폼은 공통 컨트롤 및 축소 가능한 반응형 계약을 사용한다', async () => {
  const source = await readFile(new URL('../src/components/admin/ClaudeBackendProfilesManager.tsx', import.meta.url), 'utf8');
  assert.match(source, /data-testid="claude-profile-shell"/);
  assert.match(source, /flexWrap: 'wrap'/);
  assert.match(source, /repeat\(auto-fit/);
  assert.match(source, /data-testid="claude-profile-list"/);
  assert.match(source, /data-testid="claude-profile-editor"/);
  assert.match(source, /minWidth: 0/);
  assert.match(source, /<Input/);
  assert.match(source, /<Select/);
  assert.doesNotMatch(source, /gridTemplateColumns: 'minmax\(260px, 1fr\) minmax\(380px, 2fr\)'/);
  assert.doesNotMatch(source, /float: 'right'/);
});
