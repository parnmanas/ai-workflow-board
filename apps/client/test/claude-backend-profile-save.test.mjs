import test from 'node:test';
import assert from 'node:assert/strict';
import { setupDom, mount, click, typeInto, React, act } from './helpers/jsdom.mjs';
import { api } from '../src/api.ts';
import ClaudeBackendProfilesManager from '../src/components/admin/ClaudeBackendProfilesManager.tsx';

const credentials = [
  { id: 'credential-a', workspace_id: 'workspace-1', scope: 'workspace', name: '운영 Claude', provider: 'claude_oauth_token' },
  { id: 'credential-b', workspace_id: 'workspace-1', scope: 'workspace', name: '개발 API', provider: 'anthropic' },
];
const existingProfile = {
  id: 'profile-1', name: '기존 프로필', kind: 'claude-backend', protocol: 'anthropic-compatible',
  base_url: 'https://example.test', model: 'claude-test', omit_effort: false,
  credential_required: false, auth_env: 'ANTHROPIC_AUTH_TOKEN', credential_ref: 'credential-a',
  credential_status: 'ok',
};

const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function change(element, value) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value')?.set;
    assert.ok(setter);
    setter.call(element, value);
    element.dispatchEvent(new window.Event('change', { bubbles: true }));
  });
}

async function renderManager(t, { profiles = [], listCredentials = async () => credentials } = {}) {
  const dom = setupDom();
  const originals = {
    getClaudeBackendProfiles: api.getClaudeBackendProfiles,
    listCredentials: api.listCredentials,
    createClaudeBackendProfile: api.createClaudeBackendProfile,
    updateClaudeBackendProfile: api.updateClaudeBackendProfile,
  };
  api.getClaudeBackendProfiles = async () => ({ profiles, default_profile_id: null });
  api.listCredentials = listCredentials;
  api.createClaudeBackendProfile = async () => {};
  api.updateClaudeBackendProfile = async () => {};
  const view = mount(React.createElement(ClaudeBackendProfilesManager, { workspaceId: 'workspace-1' }));
  await flush();
  t.after(() => {
    view.unmount();
    Object.assign(api, originals);
    dom.cleanup();
  });
  return view;
}

function credentialSelect(container) {
  const select = container.querySelector('select[aria-label="Credential 선택"]');
  assert.ok(select);
  return select;
}

function button(container, label) {
  const found = [...container.querySelectorAll('button')].find(item => item.textContent?.includes(label));
  assert.ok(found, `${label} 버튼을 찾을 수 없습니다.`);
  return found;
}

function checkbox(container, label) {
  const owner = [...container.querySelectorAll('label')].find(item => item.textContent?.includes(label));
  const input = owner?.querySelector('input[type="checkbox"]');
  assert.ok(input, `${label} 체크박스를 찾을 수 없습니다.`);
  return input;
}

test('신규 Credential을 이름으로 검색·선택하고 create payload에는 UUID만 저장한다', async (t) => {
  const { container } = await renderManager(t);
  const calls = [];
  api.createClaudeBackendProfile = async payload => { calls.push(payload); };

  const search = container.querySelector('input[type="search"]');
  assert.ok(search);
  typeInto(search, '개발');
  assert.deepEqual([...credentialSelect(container).options].map(option => option.textContent), ['선택하지 않음', '개발 API · anthropic']);
  change(credentialSelect(container), 'credential-b');
  click(button(container, '프로필 저장'));
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].credential_ref, 'credential-b');
  assert.equal(JSON.stringify(calls[0]).includes('개발 API'), false);
});

test('기존 값의 이름을 표시하고 변경 및 해제를 PATCH UUID/null 계약으로 저장한다', async (t) => {
  const { container } = await renderManager(t, { profiles: [existingProfile] });
  const calls = [];
  api.updateClaudeBackendProfile = async (id, payload) => { calls.push({ id, payload }); };

  click(button(container, '기존 프로필'));
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '운영 Claude · claude_oauth_token');
  change(credentialSelect(container), 'credential-b');
  click(button(container, '프로필 저장'));
  await flush();
  assert.equal(calls[0].id, 'profile-1');
  assert.equal(calls[0].payload.credential_ref, 'credential-b');
  assert.equal('credential_status' in calls[0].payload, false);

  click(button(container, '기존 프로필'));
  change(credentialSelect(container), '');
  click(button(container, '프로필 저장'));
  await flush();
  assert.equal(calls[1].payload.credential_ref, null);
});

test('Claude 고유 필드와 adapter JSON을 create payload에 손실 없이 전달한다', async (t) => {
  const { container } = await renderManager(t);
  const calls = [];
  api.createClaudeBackendProfile = async payload => { calls.push(payload); };

  typeInto(container.querySelector('input[aria-label="Stable ID"]'), 'new-profile');
  typeInto(container.querySelector('input[aria-label="Name"]'), '신규 프로필');
  typeInto(container.querySelector('input[aria-label="Model"]'), 'claude-new');
  typeInto(container.querySelector('input[aria-label="Base URL"]'), 'https://new.example.test');
  typeInto(container.querySelector('input[aria-label="Auth environment variable"]'), 'CUSTOM_CLAUDE_TOKEN');
  click(checkbox(container, 'Credential required'));
  click(checkbox(container, 'Do not set effort'));
  typeInto(container.querySelector('textarea'), '{"request":{"model_field":"deployment"}}');
  click(button(container, '프로필 저장'));
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].auth_env, 'CUSTOM_CLAUDE_TOKEN');
  assert.equal(calls[0].credential_required, true);
  assert.equal(calls[0].omit_effort, true);
  assert.deepEqual(calls[0].adapter, { request: { model_field: 'deployment' } });
});

test('Claude 고유 필드와 adapter JSON을 update payload에 손실 없이 유지한다', async (t) => {
  const profile = {
    ...existingProfile,
    protocol: 'openai-compatible',
    credential_required: true,
    omit_effort: true,
    auth_env: 'CUSTOM_CLAUDE_TOKEN',
    adapter: { request: { model_field: 'deployment' } },
  };
  const { container } = await renderManager(t, { profiles: [profile] });
  const calls = [];
  api.updateClaudeBackendProfile = async (id, payload) => { calls.push({ id, payload }); };

  click(button(container, '기존 프로필'));
  click(button(container, '프로필 저장'));
  await flush();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, profile.id);
  assert.equal(calls[0].payload.auth_env, 'CUSTOM_CLAUDE_TOKEN');
  assert.equal(calls[0].payload.credential_required, true);
  assert.equal(calls[0].payload.omit_effort, true);
  assert.deepEqual(calls[0].payload.adapter, { request: { model_field: 'deployment' } });
  assert.equal('credential_status' in calls[0].payload, false);
});

test('저장 중 버튼을 잠그고 실패 후 다시 저장할 수 있게 복구한다', async (t) => {
  const { container } = await renderManager(t);
  const pending = deferred();
  let calls = 0;
  api.createClaudeBackendProfile = () => {
    calls += 1;
    return pending.promise;
  };

  const save = button(container, '프로필 저장');
  click(save);
  assert.equal(calls, 1);
  assert.equal(save.disabled, true);
  assert.ok(save.querySelector('[aria-hidden="true"]'));
  click(save);
  assert.equal(calls, 1, '저장 중 중복 요청을 보내면 안 됩니다.');

  await act(async () => { pending.reject(new Error('의도한 저장 실패')); });
  assert.equal(save.disabled, false);
  assert.equal(save.querySelector('[aria-hidden="true"]'), null);
});

test('유효하지 않은 기존 참조를 명시하고 다른 Credential 선택 또는 해제를 허용한다', async (t) => {
  const profile = { ...existingProfile, credential_ref: 'deleted-credential' };
  const { container } = await renderManager(t, { profiles: [profile] });
  click(button(container, '기존 프로필'));

  assert.equal(credentialSelect(container).value, 'deleted-credential');
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '삭제되었거나 접근할 수 없는 Credential');
  assert.match(container.textContent, /다른 Credential을 선택하거나 해제하세요/);
});

test('목록 로딩 실패 중 기존 참조를 보존 표시하고 재시도 후 이름을 복구한다', async (t) => {
  let attempts = 0;
  const listCredentials = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('목록 오류');
    return credentials;
  };
  const { container } = await renderManager(t, { profiles: [existingProfile], listCredentials });
  click(button(container, '기존 프로필'));

  assert.equal(credentialSelect(container).disabled, true);
  assert.equal(credentialSelect(container).value, 'credential-a');
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '기존 선택 유지 (Credential 목록 로드 실패)');
  assert.match(container.textContent, /기존 선택값은 변경되지 않습니다/);

  click(button(container, '다시 시도'));
  await flush();
  assert.equal(attempts, 2);
  assert.equal(credentialSelect(container).disabled, false);
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '운영 Claude · claude_oauth_token');
});

test('목록 로딩 중에도 기존 참조가 빈 선택으로 보이지 않는다', async (t) => {
  const pending = deferred();
  const { container } = await renderManager(t, {
    profiles: [existingProfile],
    listCredentials: () => pending.promise,
  });
  click(button(container, '기존 프로필'));

  assert.equal(credentialSelect(container).disabled, true);
  assert.equal(credentialSelect(container).value, 'credential-a');
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '기존 선택 유지 (Credential 목록 확인 중)');

  await act(async () => {
    pending.resolve(credentials);
    await pending.promise;
  });
  assert.equal(credentialSelect(container).selectedOptions[0].textContent, '운영 Claude · claude_oauth_token');
});

test('공통 프로필 컨트롤과 자동 래핑 레이아웃을 사용하고 편집 취소 시 신규 상태로 돌아간다', async (t) => {
  const { container } = await renderManager(t, { profiles: [existingProfile] });

  const manager = container.querySelector('[data-testid="claude-profile-manager"]');
  const columns = container.querySelector('[data-layout="responsive-profile-columns"]');
  assert.ok(manager);
  assert.ok(columns);
  assert.equal(columns.style.display, 'flex');
  assert.equal(columns.style.flexWrap, 'wrap');
  assert.ok(container.querySelector('input[aria-label="Stable ID"]'));
  assert.ok(container.querySelector('select[aria-label="Protocol"]'));

  click(button(container, '기존 프로필'));
  assert.match(container.textContent, /기존 프로필 편집/);
  click(button(container, '취소'));
  assert.match(container.textContent, /프로필 만들기/);
  assert.equal(container.querySelector('input[aria-label="Stable ID"]').value, '');
});
