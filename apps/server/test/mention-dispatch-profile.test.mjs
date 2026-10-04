// resolveMentionDispatchExtras / resolveMentionTarget (티켓 71532b4f) —
// comment_mention dispatch가 agent_trigger와 동일한 harness / Claude backend
// runtime profile / environment env_vars / worktree mode를 계산하는지 검증한다.
// room-messaging-chat-runtime-profile.test.mjs와 같은 기법: 컴파일된 dist/
// 함수를 가벼운 stub DataSource(엔티티 클래스 참조로 분기)로 직접 구동한다 —
// 이 함수들은 comment-tools.ts/tickets.controller.ts의 실제 comment_mention
// emit 호출부에서 쓰이므로, 그 호출부들은 이 함수가 옳게 계산한다는 것만
// 신뢰하면 된다(호출부 자체의 배선은 QA-flow 통합 테스트가 이미 커버).
//
// 보드가 사라진 뒤(docs/tickets.md) 설정 레이어는 워크스페이스 하나뿐이고,
// effort 는 RuntimeSpec 의 runtime_config 로 가므로 effort_preset 은 항상 null,
// worktree mode 는 항상 per_ticket 이다. 깨울 수 있는 멘션 대상은 티켓의
// assignee(RuntimeSpec) 하나뿐이다.
//
// 커버 범위:
//   - workspace harness / language / env_vars 가 extras 로 채워진다
//   - non-Claude CLI(codex 등)는 프로필이 있어도 cli_runtime_profile이 null
//   - 프로필이 요구하는 credential을 spec 이 갖고 있지 않으면 dispatch를 거부한다
//   - runtime profile 조회 예외를 삼키지 않아 기본 backend로 폴백하지 않는다
//   - workspace 조회 예외는 기본값으로 degrade 한다(멘션 전달 유지)
//   - resolveMentionTarget 은 티켓 assignee identity 만 대상으로 삼는다

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { resolveMentionDispatchExtras, resolveMentionTarget } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'mention-dispatch-profile.js')
);
const { Workspace, ClaudeBackendProfile } = await import(
  'file://' + path.join(DIST_ROOT, 'entities', 'index.js')
);
const { runtimeIdentityKey } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'runtime-spec.js')
);

/** 런타임 프로필 정의를 claude_backend_profiles 행 모양으로 옮긴다. */
function profileRow(runtime) {
  const { id, protocol, base_url: baseUrl, model, credential_ref: credentialRef, ...rest } = runtime;
  return {
    id, protocol, base_url: baseUrl, model,
    credential_ref: credentialRef ?? null,
    config: JSON.stringify(rest),
  };
}

const LOCAL_PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:9001',
  model: 'model-a',
};

const WORKSPACE = {
  id: 'ws-1',
  language: null,
  harness_config: JSON.stringify({ system_prompt_append: 'Respond in Korean.' }),
  environment_config: JSON.stringify({ env_vars: { MY_WS_VAR: 'hello' } }),
};
const TICKET = { id: 'ticket-1', workspace_id: 'ws-1' };

// 엔티티 클래스로 분기하는 stub. 프로필은 인스턴스 전역이라(티켓 e616dbfc)
// 해석기가 claude_backend_profiles 를 통째로 읽는다. SystemSetting
// (전역 기본값)은 blanket stub 의 findOne() → null 로 "미설정"이 된다.
function makeDataSource({ workspace = WORKSPACE, profiles = [LOCAL_PROFILE], throwOn } = {}) {
  const rows = profiles.map(profileRow);
  return {
    getRepository(entity) {
      if (throwOn === entity) throw new Error('simulated DataSource failure');
      if (entity === Workspace) return { async findOne() { return workspace; } };
      if (entity === ClaudeBackendProfile) return { async find() { return rows; }, async findOne() { return null; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
}

test('resolveMentionDispatchExtras: a configured workspace + claude spec resolves every field', async () => {
  const dataSource = makeDataSource();
  const agent = { type: 'claude', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.deepEqual(extras.harness_config, { system_prompt_append: 'Respond in Korean.' });
  assert.equal(extras.effort_preset, null, 'effort rides the RuntimeSpec now — never a board preset');
  assert.equal(extras.worktree_mode, 'per_ticket');
  assert.deepEqual(extras.environment_config?.env_vars, { MY_WS_VAR: 'hello' });
  assert.deepEqual(extras.environment_config?.repositories, [], 'repositories only come from the ticket project');
  assert.ok(extras.cli_runtime_profile, 'a claude agent with a resolvable profile must get one');
  for (const [key, value] of Object.entries(LOCAL_PROFILE)) {
    assert.equal(extras.cli_runtime_profile[key], value, `cli_runtime_profile.${key}`);
  }
});

test('resolveMentionDispatchExtras: the workspace language is appended to the harness', async () => {
  const dataSource = makeDataSource({ workspace: { ...WORKSPACE, harness_config: null, language: 'Korean' } });
  const extras = await resolveMentionDispatchExtras(
    dataSource, TICKET, { type: 'codex', cli_runtime_profile: null, credential_id: null },
  );
  assert.match(extras.harness_config?.system_prompt_append || '', /^Respond in Korean\./);
});

test('resolveMentionDispatchExtras: non-Claude agent never gets a runtime profile, even with one configured', async () => {
  const dataSource = makeDataSource();
  const agent = { type: 'codex', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.equal(extras.cli_runtime_profile, null, 'non-Claude CLIs must never see a backend profile');
  // The workspace layers are CLI-agnostic and must still resolve normally.
  assert.deepEqual(extras.harness_config, { system_prompt_append: 'Respond in Korean.' });
  assert.equal(extras.worktree_mode, 'per_ticket');
});

test('resolveMentionDispatchExtras: a profile requiring a credential the agent lacks rejects the dispatch', async () => {
  const guardedProfile = { ...LOCAL_PROFILE, id: 'needs-cred', credential_required: true, credential_ref: '11111111-1111-4111-8111-111111111111' };
  const dataSource = makeDataSource({ profiles: [guardedProfile] });
  const agent = { type: 'claude', cli_runtime_profile: 'needs-cred', credential_id: null };
  await assert.rejects(
    resolveMentionDispatchExtras(dataSource, TICKET, agent),
    /must select that credential before comment mention dispatch/,
  );
});

test('resolveMentionDispatchExtras: a runtime profile DataSource failure rejects instead of falling back to the default backend', async () => {
  const dataSource = makeDataSource({ throwOn: ClaudeBackendProfile });
  const agent = { type: 'claude', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    await assert.rejects(resolveMentionDispatchExtras(dataSource, TICKET, agent), /simulated DataSource failure/);
  } finally {
    console.warn = originalWarn;
  }
  assert.match(String(warnings[0]?.[0]), /runtime profile 해석 실패/);
});

test('resolveMentionDispatchExtras: a workspace lookup failure degrades to defaults (the mention still dispatches)', async () => {
  const dataSource = makeDataSource({ throwOn: Workspace });
  const extras = await resolveMentionDispatchExtras(
    dataSource, TICKET, { type: 'claude', cli_runtime_profile: 'local-anthropic', credential_id: null },
  );
  assert.equal(extras.harness_config, null);
  assert.equal(extras.environment_config, null);
  assert.equal(extras.worktree_mode, 'per_ticket');
  assert.equal(extras.cli_runtime_profile?.id, 'local-anthropic', 'the profile layer is resolved independently');
});

// ─── resolveMentionTarget ────────────────────────────────────────────
const SPEC = {
  manager_agent_id: 'host-1', cli: 'claude', model: null, working_dir: '/tmp/qa/mention',
  folder_scope: 'shared', credential_id: null, cli_runtime_profile: 'local-anthropic',
  label: 'Builder', role_prompt: 'You build things.',
  runtime_config: { strategy: 'single', permission_mode: 'strict' },
};
const SPEC_KEY = runtimeIdentityKey(SPEC);
const ASSIGNED = { ...TICKET, assignee: SPEC, assignee_key: SPEC_KEY };

test('resolveMentionTarget: the ticket assignee identity resolves to a dispatchable target', async () => {
  const target = await resolveMentionTarget(makeDataSource(), ASSIGNED, SPEC_KEY);
  assert.ok(target, 'the assignee must be wakeable by a mention');
  assert.equal(target.agentId, SPEC_KEY);
  assert.equal(target.displayName, 'Builder');
  assert.equal(target.rolePrompt, 'You build things.');
  assert.equal(target.runtime.working_dir, SPEC.working_dir);
  assert.equal(target.runtime.cli, 'claude');
  assert.equal(target.extras.cli_runtime_profile?.id, 'local-anthropic', 'extras use the spec\'s profile selector');
});

test('resolveMentionTarget: any other identity (or a non-runtime id) is not a target', async () => {
  const otherKey = runtimeIdentityKey({ ...SPEC, working_dir: '/tmp/qa/other' });
  assert.equal(await resolveMentionTarget(makeDataSource(), ASSIGNED, otherKey), null);
  assert.equal(await resolveMentionTarget(makeDataSource(), ASSIGNED, '11111111-1111-4111-8111-111111111111'), null);
});

test('resolveMentionTarget: an unassigned ticket has no mention target', async () => {
  const unassigned = { ...TICKET, assignee: null, assignee_key: '' };
  assert.equal(await resolveMentionTarget(makeDataSource(), unassigned, SPEC_KEY), null);
});
