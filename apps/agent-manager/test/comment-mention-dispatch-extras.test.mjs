// 티켓 71532b4f — comment_mention의 one-shot 폴백 spawn()(handleCommentMention)이
// 컬럼 트리거(#dispatchTriggerBody)와 동일하게 harness / runtime profile /
// effort preset / env vars를 실어 보내는지 검증한다. 이전에는
// handleCommentMention이 이 넷을 전혀 계산하지 않아, agent에 명시 핀된
// cli_runtime_profile이 조용히 무시되고 순정 Claude로 돌았다(증상 재현: 설치본
// awb-agent-manager@1.6.157 dist/ 실측, 이 티켓 본문 참고). 서버가
// comment_mention 페이로드에 agent_trigger와 같은 이름의 필드
// (harness_config/cli_runtime_profile/effort_preset/environment_config/
// worktree_mode)를 싣도록 확장된 뒤(event-registry.ts, mention-dispatch-profile.ts),
// 이 파일은 그 필드들이 실제로 spawn() spec까지 도달하는지 agent-manager 쪽만 검증한다.
//
// 커버 범위:
//   - comment_mention 이벤트가 다섯 값을 모두 실어 보내면 one-shot spawn() spec에
//     그대로(트리거 경로와 같은 in-file 파싱 함수로) 반영된다
//   - 다섯 다 없으면 트리거 경로와 동일하게 전부 null/기본값으로 degrade하고
//     spawn() 자체는 여전히 성공한다(멘션 전달이 프로필 파싱 실패로 막히지 않음 —
//     mention-dispatch-profile.ts의 fail-closed degrade와 대칭인 agent-manager 쪽 계약)
//   - 인스턴스 `--runtime-profile` 오버라이드가 per-agent DB 프로필 부재 시 여전히
//     폴백으로 적용된다(trigger-runtime-profile-priority.test.mjs와 동일한 계약을
//     handleCommentMention 전체 경로로 재확인)

import assert from 'node:assert/strict';
import test from 'node:test';
import { EventDispatcher } from '../dist/lib/event-dispatcher.js';

const AGENT_ID = 'A1';
const WORKING_DIR = '/tmp/awb-test-comment-mention-agent-a1';

const MANAGED_AGENT_CONTEXTS = new Map([
  [AGENT_ID, {
    agent_id: AGENT_ID,
    workspace_id: 'W1',
    api_key: 'test-key',
    working_dir: WORKING_DIR,
    mcp_config_path: '/tmp/awb-test-comment-mention-mcp.json',
    cli: 'claude',
  }],
]);

const HARNESS_CONFIG = { system_prompt_append: 'Respond in Korean.' };
const RUNTIME_PROFILE = {
  id: 'vllm-profile',
  protocol: 'anthropic-compatible',
  base_url: 'http://192.168.0.6:8000',
  model: 'qwen3-coder-next',
};
const EFFORT_PRESET = { id: 'high-effort', label: 'High', claude: { effort: 'high' } };
const ENVIRONMENT_CONFIG = { env_vars: { MY_BOARD_VAR: 'hello' } };

// persistentTicketSessions:false여서 forwardCommentMention 분기가 통째로
// 스킵된다 — direct mention(role_shortcut 없음)이라 seat 예약 분기도 스킵되고,
// 곧장 아래 one-shot #subagentManager.spawn()까지 도달한다.
function makeDispatcher(extraDeps = {}) {
  let spawnedSpec = null;
  const subagentManager = {
    canSpawn() { return true; },
    async spawn(spec) {
      spawnedSpec = spec;
      return { spawned: true, pid: 4242 };
    },
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test',
      delegation: { enabled: true, persistentTicketSessions: false },
    },
    {
      managedAgentContexts: MANAGED_AGENT_CONTEXTS,
      subagentManager,
      ...extraDeps,
    },
  );
  return { dispatcher, getSpawnedSpec: () => spawnedSpec };
}

function baseEvent(overrides) {
  return {
    ticket_id: 'T1',
    comment_id: 'C1',
    agent_id: AGENT_ID,
    actor_id: 'U1',
    actor_type: 'user',
    content: '@[agent:A1|Bot] 확인해주세요',
    mention_source: 'direct',
    ...overrides,
  };
}

test('handleCommentMention: one-shot spawn carries harness/runtimeProfile/effortPreset/envVars when the event carries them', async () => {
  const { dispatcher, getSpawnedSpec } = makeDispatcher();
  await dispatcher.handleCommentMention(JSON.stringify(baseEvent({
    harness_config: HARNESS_CONFIG,
    cli_runtime_profile: RUNTIME_PROFILE,
    effort_preset: EFFORT_PRESET,
    environment_config: ENVIRONMENT_CONFIG,
    worktree_mode: 'shared',
  })));

  const spec = getSpawnedSpec();
  assert.ok(spec, 'one-shot subagentManager.spawn() must have been called');
  assert.deepEqual(spec.harness, HARNESS_CONFIG);
  assert.deepEqual(spec.runtimeProfile, RUNTIME_PROFILE);
  assert.deepEqual(spec.effortPreset, EFFORT_PRESET);
  assert.equal(spec.envVars.MY_BOARD_VAR, 'hello');
  assert.equal(spec.envVars.AWB_WORKTREE_MODE, 'shared');
  assert.equal(spec.envVars.AWB_TICKET_ID, 'T1');
  assert.equal(spec.envVars.AWB_WORK_FOLDER, WORKING_DIR);
});

test('handleCommentMention: one-shot spawn degrades to null/defaults (never blocks the mention) when the event carries none of the five', async () => {
  const { dispatcher, getSpawnedSpec } = makeDispatcher();
  await dispatcher.handleCommentMention(JSON.stringify(baseEvent({ ticket_id: 'T2', comment_id: 'C2' })));

  const spec = getSpawnedSpec();
  assert.ok(spec, 'one-shot subagentManager.spawn() must still have been called');
  assert.equal(spec.harness, null);
  assert.equal(spec.runtimeProfile, null);
  assert.equal(spec.effortPreset, null);
  // buildDispatchEnvVars always stamps these regardless of environment_config.
  assert.equal(spec.envVars.AWB_WORKTREE_MODE, 'per_ticket');
  assert.equal(spec.envVars.AWB_TICKET_ID, 'T2');
});

test('handleCommentMention: instance --runtime-profile override still applies as a fallback when the event carries no per-agent profile', async () => {
  const { dispatcher, getSpawnedSpec } = makeDispatcher({ runtimeProfileOverride: RUNTIME_PROFILE });
  await dispatcher.handleCommentMention(JSON.stringify(baseEvent({ ticket_id: 'T3', comment_id: 'C3' })));

  const spec = getSpawnedSpec();
  assert.ok(spec, 'one-shot subagentManager.spawn() must have been called');
  assert.deepEqual(spec.runtimeProfile, RUNTIME_PROFILE);
});

test('handleCommentMention: a per-agent profile on the event wins over a DIFFERENT instance override (cross-contamination guard, mirrors resolveTriggerRuntimeProfile)', async () => {
  const instanceOverride = { ...RUNTIME_PROFILE, id: 'instance-override', model: 'some-other-model' };
  const { dispatcher, getSpawnedSpec } = makeDispatcher({ runtimeProfileOverride: instanceOverride });
  await dispatcher.handleCommentMention(JSON.stringify(baseEvent({
    ticket_id: 'T4',
    comment_id: 'C4',
    cli_runtime_profile: RUNTIME_PROFILE,
  })));

  const spec = getSpawnedSpec();
  assert.deepEqual(spec.runtimeProfile, RUNTIME_PROFILE);
});

// ── Hermes ACP 분기 harness 합성 (리뷰 지적, 71532b4f) ──────────────────────
//
// handleCommentMention의 Hermes 분기는 컬럼 트리거(#dispatchTriggerBody)의
// Hermes 분기와 달리 harness.system_prompt_append를 systemContext에 전혀
// 접지 않았다 — one-shot Claude spawn() 경로만 고치고 넘어갔던 최초 구현의
// 리뷰 지적 사항. #dispatchHermes()가 결국 runtimeSupervisor.dispatch()에
// 넘기는 systemContext(skillSnapshot 없을 때는 args.systemContext와 동일)를
// 캡처해 rolePrompt와 harness append가 합성되는지 직접 검증한다.

const HERMES_AGENT_ID = 'H1';
const HERMES_WORKING_DIR = '/tmp/awb-test-comment-mention-agent-h1';
const HERMES_MANAGED_AGENT_CONTEXTS = new Map([
  [HERMES_AGENT_ID, {
    agent_id: HERMES_AGENT_ID,
    workspace_id: 'W1',
    api_key: 'test-key',
    working_dir: HERMES_WORKING_DIR,
    mcp_config_path: '/tmp/awb-test-comment-mention-hermes-mcp.json',
    cli: 'hermes',
  }],
]);

function makeHermesDispatcher(extraDeps = {}) {
  let dispatchedSpec = null;
  const runtimeSupervisor = {
    async dispatch(spec) {
      dispatchedSpec = spec;
      return { sessionId: 'sess-1', stopReason: 'end_turn' };
    },
  };
  const dispatcher = new EventDispatcher(
    {
      url: 'http://127.0.0.1:0',
      apiKey: 'test',
      delegation: { enabled: true, persistentTicketSessions: false },
    },
    {
      managedAgentContexts: HERMES_MANAGED_AGENT_CONTEXTS,
      runtimeSupervisor,
      ...extraDeps,
    },
  );
  return { dispatcher, getDispatchedSpec: () => dispatchedSpec };
}

function hermesBaseEvent(overrides) {
  return {
    ticket_id: 'T5',
    comment_id: 'C5',
    agent_id: HERMES_AGENT_ID,
    actor_id: 'U1',
    actor_type: 'user',
    content: '@[agent:H1|Hermes Bot] 확인해주세요',
    mention_source: 'direct',
    role_prompt: 'You are the assignee.',
    ...overrides,
  };
}

test('handleCommentMention (Hermes branch): harness.system_prompt_append is composed into systemContext alongside rolePrompt', async () => {
  const { dispatcher, getDispatchedSpec } = makeHermesDispatcher();
  await dispatcher.handleCommentMention(JSON.stringify(hermesBaseEvent({
    harness_config: HARNESS_CONFIG,
  })));

  const spec = getDispatchedSpec();
  assert.ok(spec, 'runtimeSupervisor.dispatch() must have been called');
  assert.equal(spec.systemContext, 'You are the assignee.\n\nRespond in Korean.');
});

test('handleCommentMention (Hermes branch): no harness_config on the event falls back to rolePrompt alone (no stray separator)', async () => {
  const { dispatcher, getDispatchedSpec } = makeHermesDispatcher();
  await dispatcher.handleCommentMention(JSON.stringify(hermesBaseEvent()));

  const spec = getDispatchedSpec();
  assert.ok(spec, 'runtimeSupervisor.dispatch() must have been called');
  assert.equal(spec.systemContext, 'You are the assignee.');
});
