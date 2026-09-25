// CLI 모듈 레지스트리 계약.
//
// 리팩토링 전에는 CLI 별 지식이 소비자 파일마다 손으로 적은 표(`SUPPORTED_CLIS`,
// `REQUIRED_CREDENTIAL_FIELDS`, `SESSION_CLI_CREDENTIAL_PREFIX`, `ACP_SESSION_CLIS`,
// `CANDIDATE_PROVIDERS`, `selectEffortSlice` 의 if 사다리 …)로 흩어져 있었다. 이 테스트는
// (1) 그 표들이 모듈 선언에서 **같은 값**으로 파생되는지, (2) 모듈 하나만 추가해도 소비자
// 코드 수정 없이 모든 표에 나타나는지, (3) 모듈 선언 자체의 불변식을 고정한다.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  BUILTIN_CLI_MODULES,
  cliDispatch,
  cliLogin,
  cliModule,
  cliModulesWith,
  credentialProviderKind,
  defineCliModule,
  findCliModule,
  findCredentialProvider,
  isAcpRuntime,
  KNOWN_CLI_IDS,
  requiredCredentialFields,
} from '../dist/lib/clis/index.js';
import { effortKeysForSlice, effortSliceKeys, selectEffortSlice } from '../dist/lib/clis/effort.js';
import { ACP_SESSION_CLIS, SESSION_CLI_CREDENTIAL_PREFIX, detectAcpSessionClis, resolveAcpCommandForCli } from '../dist/lib/agent-session-runner.js';
import { binarySpecFor, resolveBinOverride } from '../dist/lib/cli-resolver.js';
import { KNOWN_ADAPTER_CLI_TYPES } from '../dist/lib/cli-adapters/index.js';
import { requestCapabilities } from '../dist/lib/runtime/domain/capabilities.js';

const base = { protocol: 'jsonl', session: 'oneshot', native_mcp: false, native_approvals: false, steering: false, cancellation: true, usage: 'none', collaboration: [], skill_delivery: ['prompt'], permission_tiers: { strict: 'unsupported', approve: 'unsupported', trusted: 'native' } };

test('내장 모듈 목록이 곧 레지스트리다 — 순서·집합이 같다', () => {
  assert.deepEqual([...KNOWN_CLI_IDS], BUILTIN_CLI_MODULES.map((m) => m.id));
  assert.deepEqual([...KNOWN_ADAPTER_CLI_TYPES], [...KNOWN_CLI_IDS]);
  assert.deepEqual([...KNOWN_CLI_IDS], ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'opencode', 'hermes']);
  // 레지스트리는 등록 시 manifest 를 다시 freeze 하므로 참조가 아니라 선언 내용으로 비교한다.
  for (const m of BUILTIN_CLI_MODULES) assert.equal(cliModule(m.id).label, m.label);
  assert.equal(findCliModule('gemini'), null);
  assert.equal(findCliModule(''), null);
});

test('예전 손표들이 모듈 선언에서 같은 값으로 파생된다', () => {
  // cli-login.ts SUPPORTED_CLIS
  assert.deepEqual(KNOWN_CLI_IDS.filter((id) => cliLogin(id)), ['claude', 'codex', 'opencode']);
  // cli-login-session.service CLI_PROVIDER / PROVIDER_SCOPED_CLIS
  assert.equal(cliLogin('codex').harvestProvider, 'codex_subscription');
  assert.equal(cliLogin('claude').harvestProvider, 'claude_subscription');
  assert.equal(cliLogin('opencode').harvestProvider, 'opencode_auth');
  assert.equal(cliLogin('opencode').providerScoped, true);
  assert.ok(!cliLogin('codex').providerScoped);
  // agent-manager-commands REQUIRED_CREDENTIAL_FIELDS
  const required = Object.fromEntries(
    cliModulesWith('credentials').flatMap((m) => m.credentials.providers.map((p) => [p.id, [...p.required]])),
  );
  assert.deepEqual(required, {
    claude_subscription: ['credentials_json'],
    claude_api_key: ['api_key'],
    claude_oauth_token: ['oauth_token'],
    deepseek_api_key: ['api_key'],
    codex_subscription: ['auth_json'],
    codex_api_key: ['api_key'],
    antigravity_subscription: ['oauth_creds_json'],
    antigravity_api_key: ['api_key'],
    opencode_auth: ['auth_json'],
    opencode_api_key: ['api_key'],
  });
  assert.deepEqual(requiredCredentialFields('codex_subscription'), ['auth_json']);
  assert.equal(requiredCredentialFields('github'), null, '모르는 provider 는 검사하지 않는다(이전 동작)');
  // agent-session-runner SESSION_CLI_CREDENTIAL_PREFIX / ACP_SESSION_CLIS
  assert.deepEqual(SESSION_CLI_CREDENTIAL_PREFIX, { claude: 'claude_', codex: 'codex_', opencode: 'opencode_' });
  assert.deepEqual([...ACP_SESSION_CLIS], ['claude', 'codex', 'opencode', 'hermes']);
  // credentialKind 접미어 규칙
  assert.equal(credentialProviderKind('claude_subscription'), 'subscription');
  assert.equal(credentialProviderKind('claude_api_key'), 'api_key');
  assert.equal(credentialProviderKind('claude_oauth_token'), 'api_key');
  assert.equal(credentialProviderKind('mystery_thing'), 'subscription');
  // cli-resolver CANDIDATE_PROVIDERS / resolveBinOverride
  assert.equal(binarySpecFor('agy').name, 'agy');
  assert.equal(binarySpecFor('antigravity').name, 'agy');
  assert.equal(binarySpecFor('deepseek').borrowsFrom, 'claude');
  assert.equal(resolveBinOverride('codex', { codexBin: '/c' }), '/c');
  assert.equal(resolveBinOverride('claude', { claudeBin: '/a' }, '/lease'), '/lease');
  assert.equal(resolveBinOverride('pi', { claudeBin: '/a', codexBin: '/c' }), null);
  // 디스패치 게이트
  assert.equal(cliDispatch('pi').ticketDispatch, 'blocked');
  assert.equal(cliDispatch('codex').cliHomePrepFatal, true);
  assert.equal(cliDispatch('claude').runtimeProfile, true);
  assert.ok(!cliDispatch('deepseek').runtimeProfile);
  assert.deepEqual(cliDispatch('nope'), {});
  assert.equal(isAcpRuntime('hermes'), true);
  assert.equal(isAcpRuntime('claude'), false);
  assert.equal(isAcpRuntime('custom'), false);
});

test('effort 슬라이스 선택이 모듈 선언을 따른다 (옛 selectEffortSlice 와 같은 결과)', () => {
  const preset = { id: 'p', claude: { model: 'opus', effort: 'high', ultracode: true }, codex: { model: 'gpt', effort: 'high' }, opencode: { model: 'oc' } };
  assert.deepEqual(selectEffortSlice('claude', preset), { model: 'opus', effort: 'high', ultracode: true });
  assert.deepEqual(selectEffortSlice('deepseek', preset), { model: 'opus', effort: 'high', ultracode: true }, 'deepseek 는 claude 슬라이스를 빌려 쓴다');
  assert.deepEqual(selectEffortSlice('codex', preset), { model: 'gpt' }, 'codex 는 model 만 — effort 는 버린다');
  assert.deepEqual(selectEffortSlice('opencode', preset), { model: 'oc' });
  assert.equal(selectEffortSlice('pi', preset), null, '슬라이스가 없으면 null');
  assert.equal(selectEffortSlice('hermes', preset), null);
  assert.equal(selectEffortSlice('claude', null), null);
  assert.deepEqual(effortSliceKeys(), ['claude', 'codex', 'antigravity', 'pi', 'opencode']);
  assert.deepEqual([...effortKeysForSlice('claude')].sort(), ['effort', 'model', 'ultracode']);
  assert.deepEqual([...effortKeysForSlice('codex')], ['model']);
});

test('Agent Session: ACP 명령·감지가 모듈 슬라이스에서 나온다', async () => {
  const codex = await resolveAcpCommandForCli('codex');
  assert.ok(codex.command === 'npx' || codex.command.endsWith('codex-acp'), `codex → codex-acp 또는 npx 패키지: ${codex.command}`);
  const opencode = await resolveAcpCommandForCli('opencode');
  assert.deepEqual(opencode.args, ['acp']);
  await assert.rejects(() => resolveAcpCommandForCli('pi'), /No ACP adapter is known for CLI "pi"/);
  // 실행 파일 탐색은 프로세스 PATH 를 쓰므로 빈 임시 디렉터리로 바꿔 끼운다(agent-session-runner 테스트와 같은 방식).
  const emptyDir = await mkdtemp(join(tmpdir(), 'awb-cli-modules-'));
  const originalPath = process.env.PATH;
  process.env.PATH = emptyDir;
  try {
    const detected = await detectAcpSessionClis({ AWB_ACP_COMMAND_CODEX: 'node fake.js' });
    assert.deepEqual(detected, ['codex'], 'env override 만으로도 감지되고, PATH 가 비면 나머지는 빠진다');
  } finally {
    process.env.PATH = originalPath;
    await rm(emptyDir, { recursive: true, force: true });
  }
});

test('defineCliModule 은 선언 불변식을 고정한다', () => {
  const ok = defineCliModule({ id: 'fixture', label: 'Fixture', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}),
    credentials: { prefix: 'fixture_', providers: [{ id: 'fixture_api_key', label: 'F', fields: ['api_key'], required: ['api_key'] }] },
    login: { harvestProvider: 'fixture_api_key', plan: () => ({ spawnArgs: [], env: {} }), createLineParser: () => () => null, harvest: async () => ({}) } });
  assert.ok(Object.isFrozen(ok));
  assert.throws(() => defineCliModule({ id: 'x', label: 'x', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}), credentials: { prefix: 'y_', providers: [] } }), /credentials\.prefix must be "x_"/);
  assert.throws(() => defineCliModule({ id: 'x', label: 'x', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}), credentials: { prefix: 'x_', providers: [{ id: 'other_key', label: '', fields: ['k'], required: ['k'] }] } }), /must start with "x_"/);
  assert.throws(() => defineCliModule({ id: 'x', label: 'x', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}), credentials: { prefix: 'x_', providers: [{ id: 'x_k', label: '', fields: ['k'], required: ['nope'] }] } }), /requires unknown field "nope"/);
  assert.throws(() => defineCliModule({ id: 'x', label: 'x', transport: 'cli', capabilities: requestCapabilities(base), createCliAdapter: () => ({}),
    login: { harvestProvider: 'x_missing', plan: () => ({ spawnArgs: [], env: {} }), createLineParser: () => () => null, harvest: async () => ({}) } }), /not a declared credential provider/);
});

test('내장 모듈 전부가 불변식을 만족하고, 슬라이스가 있는 모듈은 provider 조회로 역추적된다', () => {
  for (const m of BUILTIN_CLI_MODULES) {
    assert.ok(m.label, `${m.id} label`);
    if (m.transport === 'cli') assert.equal(typeof m.createCliAdapter, 'function');
    if (m.transport === 'acp') assert.equal(typeof m.createOwner, 'function');
    if (m.credentials) {
      assert.equal(m.credentials.prefix, `${m.id}_`);
      for (const p of m.credentials.providers) assert.equal(findCredentialProvider(p.id)?.module.id, m.id);
    }
    if (m.login) assert.ok(m.credentials?.providers.some((p) => p.id === m.login.harvestProvider));
    if (m.sessions) {
      assert.equal(typeof m.sessions.detect, 'function');
      assert.equal(typeof m.sessions.resolveAcpCommand, 'function');
      assert.equal(typeof m.sessions.operatorHome({}), 'string');
    }
  }
  assert.equal(cliModulesWith('sessions').filter((m) => m.sessions.store).length, 3, 'claude/codex/opencode 만 기록 스캐너가 있다');
});

test('로그인 파서: CLI 마다 다른 URL/코드 줄 규칙이 모듈 안에 있다', () => {
  const claude = cliLogin('claude').createLineParser();
  assert.equal(claude('Opening browser to sign in…'), null);
  assert.deepEqual(claude('If the browser didn\'t open, visit: https://claude.com/cai/oauth/authorize?x=1'), { verification_url: 'https://claude.com/cai/oauth/authorize?x=1' });
  assert.equal(claude('https://again.example'), null, 'URL 은 한 번만 보고한다');

  const codex = cliLogin('codex').createLineParser();
  assert.equal(codex('1. Open this link in your browser: https://auth.openai.com/codex/device'), null, 'codex 는 코드까지 받은 뒤 한 번에 보고한다');
  assert.equal(codex('2. Enter this one-time code:'), null);
  assert.deepEqual(codex('ABCD-EFGH'), { verification_url: 'https://auth.openai.com/codex/device', user_code: 'ABCD-EFGH' });

  const opencode = cliLogin('opencode').createLineParser();
  assert.deepEqual(opencode('●  Go to: https://auth.openai.com/codex/device'), { verification_url: 'https://auth.openai.com/codex/device' });
  assert.deepEqual(opencode('●  Enter code: WZ1E-3RVM7'), { verification_url: 'https://auth.openai.com/codex/device', user_code: 'WZ1E-3RVM7' });
  assert.equal(opencode('◒  Waiting for authorization'), null);

  assert.throws(() => cliLogin('opencode').plan({ homeDir: '/tmp/x' }), /requires both cli_provider and cli_method/);
  const plan = cliLogin('opencode').plan({ homeDir: '/tmp/x', cliProvider: 'openai', cliMethod: 'M' });
  assert.deepEqual(plan.spawnArgs, ['auth', 'login', '-p', 'openai', '-m', 'M']);
  assert.equal(plan.env.HOME, '/tmp/x');
  assert.deepEqual(cliLogin('claude').plan({ homeDir: '/h' }).env, { CLAUDE_CONFIG_DIR: '/h' });
  assert.deepEqual(cliLogin('codex').plan({ homeDir: '/h' }).env, { CODEX_HOME: '/h' });
});
