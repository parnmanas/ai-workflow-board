import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  parseCliRuntimeProfiles,
  resolveCliRuntimeProfile,
  validateCliRuntimeProfiles,
} from '../dist/common/cli-runtime-profiles.js';
import {
  profileEntityToRuntime,
  publicProfile,
  runtimeToProfileEntity,
} from '../dist/common/claude-backend-registry.js';

const profiles = [
  {
    id: 'local-anthropic',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:9001',
    model: 'model-a',
  },
  {
    id: 'local-openai',
    kind: 'claude-backend',
    protocol: 'openai-compatible',
    base_url: 'http://127.0.0.1:9002/v1',
    model: 'model-b',
    adapter: {
      module: 'proxy',
      base_url: 'http://127.0.0.1:9003',
    },
  },
];

const here = dirname(fileURLToPath(import.meta.url));
const triggerSource = await readFile(
  join(here, '..', 'src', 'modules', 'agents', 'trigger-loop.service.ts'),
  'utf8',
);
const adminControllerSource = await readFile(
  join(here, '..', 'src', 'modules', 'admin', 'claude-backend-profiles.controller.ts'),
  'utf8',
);
const workspaceControllerSource = await readFile(
  join(here, '..', 'src', 'modules', 'workspaces', 'workspaces.controller.ts'),
  'utf8',
);
const migrationSource = await readFile(
  join(here, '..', 'src', 'database', 'migrations', '1760000000066-BackfillGlobalClaudeBackendProfiles.ts'),
  'utf8',
);

test('validates a configuration-only backend catalog and resolves Agent > Board', () => {
  const checked = validateCliRuntimeProfiles(profiles);
  assert.equal(checked.ok, true);
  assert.equal(checked.value.length, 2, 'a second backend/model requires only another profile');
  assert.equal(resolveCliRuntimeProfile(checked.value, [
    { source: 'agent', value: null },
    { source: 'board', value: 'local-openai' },
    { source: 'global', value: 'local-anthropic' },
  ]).id, 'local-openai');
  assert.equal(resolveCliRuntimeProfile(checked.value, [
    { source: 'run', value: 'none' },
    { source: 'agent', value: 'local-openai' },
  ]), null);
});

test('resolves run > Agent > Board > Global and explicit none stops inheritance', () => {
  assert.equal(resolveCliRuntimeProfile(profiles, [
    { source: 'run', value: null },
    { source: 'agent', value: null },
    { source: 'board', value: null },
    { source: 'global', value: 'local-anthropic' },
  ]).id, 'local-anthropic');
  assert.equal(resolveCliRuntimeProfile(profiles, [
    { source: 'run', value: null },
    { source: 'agent', value: 'none' },
    { source: 'global', value: 'local-anthropic' },
  ]), null);
});

test('registry storage roundtrip keeps adapter config while public DTO hides credential identity', () => {
  const runtime = {
    ...profiles[1],
    credential_required: true,
    credential_ref: '11111111-1111-4111-8111-111111111111',
  };
  const entity = runtimeToProfileEntity(runtime, 'Local OpenAI');
  const restored = profileEntityToRuntime({ ...entity, created_at: new Date(), updated_at: new Date() });
  assert.deepEqual(restored, validateCliRuntimeProfiles([runtime]).value[0]);
  const safe = publicProfile({ ...entity, created_at: new Date(), updated_at: new Date() });
  assert.equal(safe.name, 'Local OpenAI');
  assert.equal(safe.credential_status, 'configured');
  assert.equal('credential_ref' in safe, false);
  assert.equal(JSON.stringify(safe).includes(runtime.credential_ref), false);
});

test('returns actionable validation errors without accepting plaintext secrets', () => {
  const checked = validateCliRuntimeProfiles([
    profiles[0],
    { ...profiles[0] },
    {
      id: 'bad-openai',
      kind: 'claude-backend',
      protocol: 'openai-compatible',
      base_url: 'http://127.0.0.1:9002',
      model: 'm',
      env: { AWB_API_KEY: 'reserved', OPENAI_API_KEY: 'plaintext' },
      credential_required: true,
    },
  ]);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /duplicate profile id/);
  assert.match(checked.error, /adapter.*required/s);
  assert.match(checked.error, /reserved/);
  assert.match(checked.error, /sensitive.*credential_ref/s);
  assert.match(checked.error, /credential_ref/);
});

// ticket 7d8ea7c9 후속(컨텍스트 윈도우 초과), ticket 41dc37cb round 3 —
// context_window/max_output_tokens/safety_margin_tokens/auto_compact_window
// 는 ClaudeBackendProfile.config JSON blob 에 실려 agent-manager 로 그대로
// 전달된다(entity 컬럼 추가 불요). 넷 다 선택적이라 기존 프로필(필드 생략)은
// 그대로 통과해야 한다.
test('context_window/max_output_tokens/safety_margin_tokens/auto_compact_window 는 선택적이며 저장소를 왕복해도 유지된다', () => {
  const runtime = {
    ...profiles[0],
    context_window: 65_536,
    max_output_tokens: 32_000,
    safety_margin_tokens: 1_000,
    auto_compact_window: 58_000,
  };
  const checked = validateCliRuntimeProfiles([runtime]);
  assert.equal(checked.ok, true);
  assert.equal(checked.value[0].context_window, 65_536);
  assert.equal(checked.value[0].max_output_tokens, 32_000);
  assert.equal(checked.value[0].safety_margin_tokens, 1_000);
  assert.equal(checked.value[0].auto_compact_window, 58_000);

  const entity = runtimeToProfileEntity(checked.value[0], 'With context window');
  const restored = profileEntityToRuntime({ ...entity, created_at: new Date(), updated_at: new Date() });
  assert.equal(restored.context_window, 65_536);
  assert.equal(restored.max_output_tokens, 32_000);
  assert.equal(restored.safety_margin_tokens, 1_000);
  assert.equal(restored.auto_compact_window, 58_000);
});

test('context_window/max_output_tokens/safety_margin_tokens/auto_compact_window 를 생략한 profile 도 여전히 통과한다 (기존 프로필 영향 없음)', () => {
  const checked = validateCliRuntimeProfiles([profiles[0]]);
  assert.equal(checked.ok, true);
  assert.equal(checked.value[0].context_window, undefined);
  assert.equal(checked.value[0].max_output_tokens, undefined);
  assert.equal(checked.value[0].safety_margin_tokens, undefined);
  assert.equal(checked.value[0].auto_compact_window, undefined);
});

test('auto_compact_window 는 양의 정수가 아니면 거부한다', () => {
  const negative = validateCliRuntimeProfiles([{ ...profiles[0], auto_compact_window: -1 }]);
  assert.equal(negative.ok, false);

  const fractional = validateCliRuntimeProfiles([{ ...profiles[0], auto_compact_window: 1.5 }]);
  assert.equal(fractional.ok, false);
});

test('max_output_tokens >= context_window 및 양의 정수가 아닌 값을 거부한다', () => {
  const tooLarge = validateCliRuntimeProfiles([{ ...profiles[0], context_window: 1_000, max_output_tokens: 1_000 }]);
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error, /max_output_tokens.*less than context_window/s);

  const negative = validateCliRuntimeProfiles([{ ...profiles[0], context_window: -1 }]);
  assert.equal(negative.ok, false);

  const fractional = validateCliRuntimeProfiles([{ ...profiles[0], max_output_tokens: 1.5 }]);
  assert.equal(fractional.ok, false);
});

// 리뷰 지적(P1) — context_window 가 (생략 시 기본값으로 간주하는)
// safety_margin_tokens 조차 감당 못 하면, agent-manager 의
// resolveEffectiveMaxOutputTokens() 는 known input 0(가장 유리한 경우)에서도
// 항상 throw 하는 무의미한 profile 이다 — 저장 시점에 거부한다.
test('context_window 가 safety_margin_tokens(기본값 또는 명시값)조차 감당 못 하면 거부한다', () => {
  // safety_margin_tokens 생략 → 서버측 DEFAULT_SAFETY_MARGIN_TOKENS(40,000) 가정.
  const defaultMargin = validateCliRuntimeProfiles([{ ...profiles[0], context_window: 8_000 }]);
  assert.equal(defaultMargin.ok, false);
  assert.match(defaultMargin.error, /leaves less than.*tokens for output/s);

  const explicitMargin = validateCliRuntimeProfiles([
    { ...profiles[0], context_window: 2_000, safety_margin_tokens: 1_500 },
  ]);
  assert.equal(explicitMargin.ok, false);
  assert.match(explicitMargin.error, /leaves less than.*tokens for output/s);

  // 경계(정확히 1,024 남음)는 통과해야 한다.
  const boundary = validateCliRuntimeProfiles([
    { ...profiles[0], context_window: 2_000, safety_margin_tokens: 976 },
  ]);
  assert.equal(boundary.ok, true);
});

test('missing selected profile fails with its inheritance source', () => {
  assert.throws(
    () => resolveCliRuntimeProfile(profiles, [{ source: 'agent', value: 'deleted' }]),
    /Claude backend profile "deleted".*agent.*does not exist/,
  );
});

test('migrates safely reusable legacy Anthropic rows instead of silently dropping the catalog', () => {
  const migrated = parseCliRuntimeProfiles(JSON.stringify([{
    id: 'legacy-anthropic',
    provider: 'anthropic',
    type: 'server',
    model: 'legacy-model',
    base_url: 'http://127.0.0.1:9010',
    shutdown_policy: 'reuse',
    claude: { env: { LEGACY_PUBLIC: 'preserved' }, args: ['--legacy-flag'] },
  }]));
  assert.deepEqual(migrated, [{
    id: 'legacy-anthropic',
    kind: 'claude-backend',
    protocol: 'anthropic-compatible',
    base_url: 'http://127.0.0.1:9010',
    model: 'legacy-model',
    omit_effort: false,
    env: { LEGACY_PUBLIC: 'preserved' },
    args: ['--legacy-flag'],
    credential_required: false,
    auth_env: 'ANTHROPIC_AUTH_TOKEN',
  }]);
});

test('legacy backend-launch rows fail with an actionable migration error', () => {
  const legacyVllm = [{
    id: 'legacy-vllm',
    provider: 'vllm',
    type: 'server',
    model: 'demo',
    module: 'vllm.entrypoints.openai.api_server',
    port: 8000,
  }];
  const checked = validateCliRuntimeProfiles(legacyVllm);
  assert.equal(checked.ok, false);
  assert.match(checked.error, /legacy profile "legacy-vllm".*cannot be migrated safely.*openai-compatible.*adapter.*no longer starts/s);
  assert.throws(
    () => parseCliRuntimeProfiles(JSON.stringify(legacyVllm)),
    /legacy profile "legacy-vllm".*cannot be migrated safely/,
  );
});

test('trigger dispatch resolves and validates Claude backend profiles only for Claude agents', () => {
  const guard = triggerSource.match(
    /if \(agent\?\.type === 'claude'\) \{[\s\S]*?runtimeProfile = await resolveClaudeBackendProfileForDispatch\([\s\S]*?credential_required[\s\S]*?\n    \}/,
  );
  assert.ok(guard, 'profile resolution and credential validation must share an agent.type === claude guard');
  assert.match(guard[0], /\{ source: 'run', value: ticket\.cli_runtime_profile \}[\s\S]*source: 'agent'[\s\S]*source: 'board'/);
  assert.match(
    triggerSource,
    /let runtimeProfile: CliRuntimeProfile \| null = null;/,
    'non-Claude SSE payload must retain a null cli_runtime_profile',
  );
  assert.doesNotMatch(
    triggerSource.slice(guard.index + guard[0].length),
    /runtimeProfile = await resolveClaudeBackendProfileForDispatch/,
    'profile resolution must not have an unguarded fallback',
  );
});

test('global CRUD is AdminGuard-protected and referenced deletion is transactional and fail-closed', () => {
  assert.match(adminControllerSource, /@UseGuards\(AdminGuard\)/);
  assert.match(adminControllerSource, /return res\.status\(409\)\.json\(\{ error: 'Profile is referenced', impact \}\)/);
  assert.match(adminControllerSource, /this\.dataSource\.transaction/);
  assert.match(adminControllerSource, /replacement_profile_id/);
  assert.match(adminControllerSource, /detach === true/);
  assert.match(adminControllerSource, /profilePatch\.credential_ref === null/);
  assert.match(adminControllerSource, /delete merged\.credential_ref/);
});

// 티켓 e616dbfc — 워크스페이스 배정/기본값 표면은 제거됐다. 예전 단언(소유자
// 검사·allow-set 검증·publicProfile 매핑)은 그 표면이 존재한다는 전제였으므로,
// 표면이 되살아나는 것 자체를 잡는 방향으로 뒤집는다.
test('workspaces controller no longer exposes any claude-backend-profile surface', () => {
  assert.doesNotMatch(workspaceControllerSource, /claude-backend-profiles/);
  assert.doesNotMatch(workspaceControllerSource, /WorkspaceClaudeBackendProfile/);
  assert.doesNotMatch(workspaceControllerSource, /allowed_profile_ids/);
  assert.doesNotMatch(workspaceControllerSource, /default_claude_backend_profile_id/);
  // 레거시 JSON 컬럼은 dormant 로 남지만 쓰기 경로는 사라져야 한다.
  assert.doesNotMatch(workspaceControllerSource, /ws\.cli_runtime_profiles =/);
  assert.doesNotMatch(workspaceControllerSource, /ws\.default_cli_runtime_profile =/);
});

// 새 비관리자 읽기 표면 — 관리자 전용 라우트를 그대로 갈아끼우면 비관리자
// 드롭다운이 빈 목록이 되므로 AuthGuard 짜리 카탈로그가 따로 있어야 한다.
test('a non-admin catalog route exists and still masks credential refs', () => {
  assert.match(adminControllerSource, /@Controller\('api\/claude-backend-profiles'\)/);
  assert.match(adminControllerSource, /@UseGuards\(AuthGuard\)/);
  assert.match(adminControllerSource, /profiles: rows\.map\(publicProfile\)/);
});

test('legacy migration dedupes exact canonical payload plus credential ref and stays entity-free', () => {
  assert.match(migrationSource, /createHash\('sha256'\)/);
  assert.match(migrationSource, /credential_ref: candidate\.credential_ref/);
  assert.match(migrationSource, /fingerprintToId/);
  assert.match(migrationSource, /cli_runtime_profiles/);
  // 마이그레이션은 synchronize 이후에 돈다(db.ts D-02). 엔티티 리포지토리로
  // 컬럼을 읽으면 이미 DROP 된 컬럼을 건드려 부팅이 터지므로, 테이블명 기반
  // 쿼리 + 존재 가드만 써야 한다.
  // 엔티티를 단 하나도 import 하지 않아야 한다(주석 언급은 무관 — import 줄만 본다).
  const entityImports = migrationSource
    .split('\n')
    .filter(line => /^import /.test(line) && /entities\//.test(line));
  assert.deepEqual(entityImports, [], `마이그레이션이 엔티티를 import 하면 안 됩니다: ${entityImports.join(' | ')}`);
  assert.doesNotMatch(migrationSource, /getRepository\((?:Workspace|ClaudeBackendProfile|Board|Agent|Ticket)\)/);
  assert.match(migrationSource, /hasColumn\('workspaces', 'cli_runtime_profiles'\)/);
});
