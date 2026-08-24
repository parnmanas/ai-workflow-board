// resolveMentionDispatchExtras (티켓 71532b4f) — comment_mention dispatch가
// agent_trigger와 동일한 harness / effort preset / Claude backend runtime
// profile / environment env_vars / worktree mode를 계산하는지 검증한다.
// room-messaging-chat-runtime-profile.test.mjs와 같은 기법: 컴파일된 dist/
// 함수를 가벼운 stub DataSource(엔티티 클래스 참조로 분기)로 직접 구동한다 —
// 이 함수는 comment-tools.ts/tickets.controller.ts의 실제 comment_mention
// emit 호출부에서 쓰이므로, 그 호출부들은 이 함수가 옳게 계산한다는 것만
// 신뢰하면 된다(호출부 자체의 배선은 QA-flow 통합 테스트가 이미 커버).
//
// 커버 범위:
//   - board+workspace+agent가 모두 설정되어 있으면 다섯 값이 전부 채워진다
//   - non-Claude agent(codex 등)는 board/agent에 프로필이 있어도
//     cli_runtime_profile이 null로 남는다(room-messaging 테스트와 동일 계약)
//   - 프로필이 요구하는 credential을 agent가 갖고 있지 않으면
//     cli_runtime_profile만 soft-fail로 null이 되고 나머지 넷은 정상 반환된다
//   - 리졸브 도중 예외가 나면(예: DataSource 접근 실패) 다섯 값 모두
//     null/기본값으로 fail-closed degrade한다 — 멘션 전달 자체는 절대
//     막지 않는다는 계약(다른 common/ resolver들과 동일)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST_ROOT = path.resolve(__dirname, '..', 'dist');

const { resolveMentionDispatchExtras } = await import(
  'file://' + path.join(DIST_ROOT, 'common', 'mention-dispatch-profile.js')
);
const { Board, Workspace, BoardColumn } = await import(
  'file://' + path.join(DIST_ROOT, 'entities', 'index.js')
);

const LOCAL_PROFILE = {
  id: 'local-anthropic',
  protocol: 'anthropic-compatible',
  base_url: 'http://127.0.0.1:9001',
  model: 'model-a',
};

const BOARD_COLUMN = { id: 'col-1', board_id: 'board-1' };
const BOARD = {
  id: 'board-1',
  language: null,
  harness_config: JSON.stringify({ system_prompt_append: 'Respond in Korean.' }),
  effort_presets: JSON.stringify({
    default: 'high',
    presets: [{ id: 'high', label: 'High', claude: { effort: 'high' } }],
  }),
  environment_config: JSON.stringify({ env_vars: { MY_BOARD_VAR: 'hello' } }),
  worktree_mode: 'shared',
  cli_runtime_profile: null,
};
const WORKSPACE = {
  id: 'ws-1',
  harness_config: null,
  environment_config: null,
  claude_backend_profiles_migrated: 0,
  cli_runtime_profiles: JSON.stringify([LOCAL_PROFILE]),
};
const TICKET = { column_id: 'col-1', workspace_id: 'ws-1', effort_preset: 'high', cli_runtime_profile: null };

// Entity-class-keyed stub — resolveClaudeBackendProfileForDispatch also calls
// getRepository() for the registry-backed path (SystemSetting /
// WorkspaceClaudeBackendProfile / ClaudeBackendProfile); this test doesn't
// exercise that path (WORKSPACE.claude_backend_profiles_migrated stays 0, so
// resolution reads workspace.cli_runtime_profiles instead — same fixture
// pattern as room-messaging-chat-runtime-profile.test.mjs), so every other
// entity type falls through to the blanket empty stub.
function makeDataSource({ boardColumn = BOARD_COLUMN, board = BOARD, workspace = WORKSPACE, throwOn } = {}) {
  return {
    getRepository(entity) {
      if (throwOn === entity) throw new Error('simulated DataSource failure');
      if (entity === BoardColumn) return { async findOne() { return boardColumn; } };
      if (entity === Board) return { async findOne() { return board; } };
      if (entity === Workspace) return { async findOne() { return workspace; } };
      return { async findOne() { return null; }, async find() { return []; } };
    },
  };
}

test('resolveMentionDispatchExtras: fully configured board+workspace+agent resolves all five fields', async () => {
  const dataSource = makeDataSource();
  const agent = { type: 'claude', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.deepEqual(extras.harness_config, { system_prompt_append: 'Respond in Korean.' });
  assert.deepEqual(extras.effort_preset, { id: 'high', label: 'High', claude: { effort: 'high' } });
  assert.equal(extras.worktree_mode, 'shared');
  assert.deepEqual(extras.environment_config?.env_vars, { MY_BOARD_VAR: 'hello' });
  assert.ok(extras.cli_runtime_profile, 'a claude agent with a resolvable profile must get one');
  for (const [key, value] of Object.entries(LOCAL_PROFILE)) {
    assert.equal(extras.cli_runtime_profile[key], value, `cli_runtime_profile.${key}`);
  }
});

test('resolveMentionDispatchExtras: non-Claude agent never gets a runtime profile, even with one configured', async () => {
  const dataSource = makeDataSource();
  const agent = { type: 'codex', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.equal(extras.cli_runtime_profile, null, 'non-Claude CLIs must never see a backend profile');
  // The other four are agent-type-agnostic and must still resolve normally.
  assert.deepEqual(extras.harness_config, { system_prompt_append: 'Respond in Korean.' });
  assert.equal(extras.worktree_mode, 'shared');
});

test('resolveMentionDispatchExtras: a profile requiring a credential the agent lacks soft-fails to null (other four still resolve)', async () => {
  const guardedProfile = { ...LOCAL_PROFILE, id: 'needs-cred', credential_required: true, credential_ref: '11111111-1111-4111-8111-111111111111' };
  const workspace = { ...WORKSPACE, cli_runtime_profiles: JSON.stringify([guardedProfile]) };
  const dataSource = makeDataSource({ workspace });
  const agent = { type: 'claude', cli_runtime_profile: 'needs-cred', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.equal(extras.cli_runtime_profile, null, 'a profile the agent cannot authenticate to must not reach the wire');
  assert.deepEqual(extras.harness_config, { system_prompt_append: 'Respond in Korean.' });
  assert.equal(extras.worktree_mode, 'shared');
});

test('resolveMentionDispatchExtras: a DataSource failure degrades all five fields to null/default instead of throwing (fail-closed, mention delivery never blocked)', async () => {
  const dataSource = makeDataSource({ throwOn: BoardColumn });
  const agent = { type: 'claude', cli_runtime_profile: 'local-anthropic', credential_id: null };
  const extras = await resolveMentionDispatchExtras(dataSource, TICKET, agent);

  assert.deepEqual(extras, {
    harness_config: null,
    effort_preset: null,
    cli_runtime_profile: null,
    environment_config: null,
    worktree_mode: 'per_ticket',
  });
});
