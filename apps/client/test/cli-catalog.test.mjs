// LLM CLI 카탈로그(src/cli/catalog.ts) + 표시 표(src/cli/presentation.ts) 회귀 테스트.
//
// 컴포넌트 14곳에 흩어져 있던 per-CLI 하드코딩 표(라벨, credential prefix, 로그인
// 커맨드, effort 키, hermes 전용 게이트 …)를 카탈로그 하나로 모았다. 여기서는
// (1) 헬퍼가 모르는 id 에도 던지지 않고 안전한 기본값을 주는지, (2) 기존 호출자가
// 쓰는 이름(`runtimeLabel`, `credentialFallbackCopy`)의 출력이 그대로인지,
// (3) effort 편집기가 "자기 슬라이스를 가진 CLI 마다 한 블록"을 만드는 순수 헬퍼를
// 고정한다.
//
// 실행:  node --import tsx --test apps/client/test/cli-catalog.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STATIC_CLI_CATALOG,
  DEFAULT_CLI_ID,
  cliCatalog,
  setCliCatalog,
  resetCliCatalog,
  subscribeCliCatalog,
  cliDescriptor,
  cliLabel,
  cliCredentialPrefix,
  cliSupportsCredential,
  cliSupportsBackendProfile,
  cliModelSelectable,
  cliEffortKeys,
  cliLoginInfo,
  cliRuntimeConfig,
  cliCollaboration,
  cliUpdatable,
  cliCredentialProviders,
  cliForCredentialProvider,
  loginCapableClis,
  executableClis,
  acpSessionClis,
  effortEditorClis,
} from '../src/cli/catalog.ts';
import {
  cliColor,
  providerColor,
  providerIcon,
  defaultLoginCli,
  CREDENTIAL_FALLBACK_COPY,
  GENERIC_CREDENTIAL_FALLBACK,
} from '../src/cli/presentation.ts';
import { credentialFallbackCopy } from '../src/utils/credentialFallback.ts';
import { runtimeLabel } from '../src/components/sessions/sessionTranscript.logic.ts';
import {
  buildRuntimeConfig,
  runtimeOptions,
  strategyOptionsFor,
} from '../src/components/admin/RuntimeConfigFields.tsx';
import {
  runtimeProfileForAgentUpdate,
  runtimeProfileForManagedAgentCreate,
  runtimeProfileSelectionReady,
} from '../src/utils/claudeRuntimeProfile.ts';
import { cliLoginCommand, instanceLabel } from '../src/components/admin/CliAutoLogin.tsx';
import { importDetailsFor } from '../src/components/admin/CliCredentialImport.tsx';

const CATALOG_IDS = ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'opencode', 'hermes', 'custom'];

test.beforeEach(() => resetCliCatalog());

// ─── 1. 정적 미러의 형태 ──────────────────────────────────────────────────────

test('static catalog lists the eight CLIs in contract order', () => {
  assert.deepEqual(STATIC_CLI_CATALOG.map((d) => d.id), CATALOG_IDS);
  assert.equal(DEFAULT_CLI_ID, 'claude');
  for (const d of STATIC_CLI_CATALOG) {
    assert.equal(typeof d.label, 'string');
    assert.ok(['cli', 'acp', 'none'].includes(d.transport), `${d.id} transport`);
    assert.ok(Array.isArray(d.collaboration) && d.collaboration.includes('single'), `${d.id} collaboration`);
    assert.equal(typeof d.sessions.acp, 'boolean');
    assert.equal(typeof d.sessions.backend_profile, 'boolean');
    assert.equal(typeof d.runtime_config.profiles, 'boolean');
    assert.equal(typeof d.runtime_config.child_limits, 'boolean');
  }
});

test('catalog facts match the previously hardcoded tables', () => {
  // credential prefixes (ex AgentsPage CLI_TO_CREDENTIAL_PREFIX)
  assert.equal(cliCredentialPrefix('claude'), 'claude_');
  assert.equal(cliCredentialPrefix('deepseek'), 'deepseek_');
  assert.equal(cliCredentialPrefix('codex'), 'codex_');
  assert.equal(cliCredentialPrefix('antigravity'), 'antigravity_');
  assert.equal(cliCredentialPrefix('opencode'), 'opencode_');
  for (const id of ['pi', 'hermes', 'custom']) {
    assert.equal(cliCredentialPrefix(id), null, `${id} has no credential concept`);
    assert.equal(cliSupportsCredential(id), false);
  }
  // backend profile (ex `cli === 'claude'` gates)
  assert.equal(cliSupportsBackendProfile('claude'), true);
  for (const id of CATALOG_IDS.filter((i) => i !== 'claude')) assert.equal(cliSupportsBackendProfile(id), false, id);
  // model selectable (ex `cli !== 'hermes'` gates)
  assert.equal(cliModelSelectable('hermes'), false);
  for (const id of CATALOG_IDS.filter((i) => i !== 'hermes')) assert.equal(cliModelSelectable(id), true, id);
  // effort keys (ex BoardSettingsPage 4-column grid)
  assert.deepEqual(cliEffortKeys('claude'), ['effort', 'ultracode', 'model']);
  assert.deepEqual(cliEffortKeys('deepseek'), ['effort', 'ultracode', 'model']);
  assert.equal(cliDescriptor('deepseek').effort.slice_key, 'claude');
  for (const id of ['codex', 'antigravity', 'pi', 'opencode']) assert.deepEqual(cliEffortKeys(id), ['model'], id);
  assert.deepEqual(cliEffortKeys('hermes'), []);
  assert.deepEqual(cliEffortKeys('custom'), []);
  // runtime config knobs + collaboration (ex `runtime === 'hermes'`)
  assert.deepEqual(cliRuntimeConfig('hermes'), { profiles: true, child_limits: true });
  assert.deepEqual(cliCollaboration('hermes'), ['single', 'delegated', 'swarm']);
  for (const id of CATALOG_IDS.filter((i) => i !== 'hermes')) {
    assert.deepEqual(cliRuntimeConfig(id), { profiles: false, child_limits: false }, id);
    assert.deepEqual(cliCollaboration(id), ['single'], id);
  }
  // updatable / executable (ex AgentLifecycleControls NON_UPDATABLE_CLI_TYPES, RUNTIME_OPTIONS)
  assert.equal(cliUpdatable('custom'), false);
  assert.deepEqual(executableClis().map((d) => d.id), CATALOG_IDS.filter((i) => i !== 'custom'));
  // sessions (ex SessionsPage "Claude Code, Codex, Hermes")
  assert.deepEqual(acpSessionClis().map((d) => d.id), ['claude', 'codex', 'opencode', 'hermes']);
  // login (ex CliAutoLogin / CliCredentialImport tables)
  assert.deepEqual(loginCapableClis().map((d) => d.id), ['claude', 'codex', 'opencode']);
  assert.equal(cliLoginInfo('codex').command, 'codex login --device-auth');
  assert.equal(cliLoginInfo('codex').file_path, '~/.codex/auth.json');
  assert.equal(cliLoginInfo('codex').extra_file_field, 'config_toml');
  assert.equal(cliLoginInfo('claude').command, 'claude auth login');
  assert.equal(cliLoginInfo('claude').file_path, '~/.claude/.credentials.json');
  assert.equal(cliLoginInfo('opencode').provider_scoped, true);
  assert.deepEqual(cliLoginInfo('opencode').presets.map((p) => p.provider), ['openai', 'github-copilot']);
});

test('flattened credential providers keep the old dropdown order and field facts', () => {
  const providers = cliCredentialProviders();
  assert.deepEqual(providers.map((p) => p.id), [
    'claude_subscription', 'claude_api_key', 'claude_oauth_token',
    'deepseek_api_key',
    'codex_subscription', 'codex_api_key',
    'antigravity_subscription', 'antigravity_api_key',
    'opencode_auth', 'opencode_api_key',
  ]);
  for (const p of providers) {
    assert.ok(p.id.startsWith(cliCredentialPrefix(p.cli)), `${p.id} carries its CLI prefix`);
    for (const f of [...p.required, ...p.multiline, ...p.revealable]) {
      assert.ok(p.fields.includes(f), `${p.id}.${f} must be a declared field`);
    }
  }
  const codexSub = providers.find((p) => p.id === 'codex_subscription');
  assert.deepEqual(codexSub.fields, ['auth_json', 'config_toml']);
  assert.deepEqual(codexSub.required, ['auth_json']);
  assert.deepEqual(providers.find((p) => p.id === 'claude_oauth_token').revealable, ['oauth_token']);
  assert.equal(cliForCredentialProvider('antigravity_api_key').id, 'antigravity');
  assert.equal(cliForCredentialProvider('github'), undefined);
});

// ─── 2. 미지 id 에 대한 안전한 기본값 — 어떤 헬퍼도 던지지 않는다 ────────────

for (const unknown of ['future-cli', '', null, undefined]) {
  test(`helpers tolerate unknown id ${JSON.stringify(unknown)}`, () => {
    assert.equal(cliDescriptor(unknown), undefined);
    assert.equal(cliCredentialPrefix(unknown), null);
    assert.equal(cliSupportsCredential(unknown), false);
    assert.equal(cliSupportsBackendProfile(unknown), false);
    assert.equal(cliModelSelectable(unknown), true, 'unknown CLIs keep the free-text model input');
    assert.deepEqual(cliEffortKeys(unknown), []);
    assert.equal(cliLoginInfo(unknown), null);
    assert.deepEqual(cliRuntimeConfig(unknown), { profiles: false, child_limits: false });
    assert.deepEqual(cliCollaboration(unknown), ['single']);
    assert.equal(cliUpdatable(unknown), true);
    assert.equal(typeof cliColor(unknown), 'string');
    assert.equal(typeof providerColor(unknown), 'string');
    assert.equal(typeof providerIcon(unknown), 'string');
  });
}

test('cliLabel returns the catalog label, or the raw id when unknown', () => {
  assert.equal(cliLabel('claude'), 'Claude Code');
  assert.equal(cliLabel('hermes'), 'Hermes ACP');
  assert.equal(cliLabel('future-cli'), 'future-cli');
});

test('runtimeLabel (sessions surface) reads the catalog and keeps its old empty fallback', () => {
  assert.equal(runtimeLabel('opencode'), 'OpenCode');
  assert.equal(runtimeLabel('claude'), 'Claude Code');
  assert.equal(runtimeLabel('unknown-runtime'), 'unknown-runtime');
  assert.equal(runtimeLabel(''), 'CLI');
});

// ─── 3. 스토어 — fetch 결과로 교체되면 헬퍼와 구독자가 즉시 그것을 본다 ────────

test('setCliCatalog swaps the source every helper reads and notifies subscribers', () => {
  let notified = 0;
  const unsubscribe = subscribeCliCatalog(() => { notified += 1; });
  const fetched = STATIC_CLI_CATALOG.map((d) => (d.id === 'pi' ? { ...d, label: 'PI (server)' } : d));
  setCliCatalog(fetched);
  assert.equal(notified, 1);
  assert.equal(cliCatalog(), fetched);
  assert.equal(cliLabel('pi'), 'PI (server)');
  assert.equal(runtimeLabel('pi'), 'PI (server)');
  unsubscribe();
  resetCliCatalog();
  assert.equal(cliLabel('pi'), 'PI');
  setCliCatalog(fetched);
  assert.equal(notified, 1, 'unsubscribed listener is not called again');
});

// ─── 4. 카탈로그 위에 올라간 파생 헬퍼들 ─────────────────────────────────────

test('effort editor: one block per CLI with its own effort slice; slice_key CLIs are folded in', () => {
  const blocks = effortEditorClis();
  assert.deepEqual(blocks.map((b) => b.id), ['claude', 'codex', 'antigravity', 'pi', 'opencode']);
  assert.ok(!blocks.some((b) => b.id === 'deepseek'), 'deepseek reads the claude slice — no block of its own');
  assert.ok(!blocks.some((b) => b.id === 'hermes'), 'hermes has no effort concept');
  assert.deepEqual(blocks[0], { id: 'claude', label: 'Claude Code', keys: ['effort', 'ultracode', 'model'] });
  for (const b of blocks.slice(1)) assert.deepEqual(b.keys, ['model'], b.id);
  // Adding an effort-capable CLI to the catalog adds a block without a code change.
  setCliCatalog([...STATIC_CLI_CATALOG, {
    ...STATIC_CLI_CATALOG.find((d) => d.id === 'pi'),
    id: 'newcli', label: 'New CLI', effort: { keys: ['model', 'effort'] },
  }]);
  assert.deepEqual(effortEditorClis().at(-1), { id: 'newcli', label: 'New CLI', keys: ['model', 'effort'] });
});

test('runtime options / strategy options / runtime_config knobs derive from the catalog', () => {
  assert.deepEqual(runtimeOptions().map((o) => o.value), CATALOG_IDS.filter((i) => i !== 'custom'));
  assert.equal(runtimeOptions().find((o) => o.value === 'hermes').label, 'Hermes ACP');
  assert.deepEqual(strategyOptionsFor('claude'), [{ value: 'single', label: 'Single' }]);
  assert.deepEqual(strategyOptionsFor('hermes').map((o) => o.value), ['single', 'delegated', 'swarm']);
  assert.match(strategyOptionsFor('hermes')[1].label, /Delegated/);
  assert.deepEqual(strategyOptionsFor('future-cli'), [{ value: 'single', label: 'Single' }]);

  const base = { strategy: 'single', permissionMode: 'trusted', profile: 'p1', maxChildren: '3', maxIterations: '7' };
  assert.deepEqual(buildRuntimeConfig({ ...base, runtime: 'hermes' }), {
    strategy: 'single', permission_mode: 'trusted', profile: 'p1', max_children: 3, max_iterations: 7,
  });
  assert.deepEqual(buildRuntimeConfig({ ...base, runtime: 'claude' }), {
    strategy: 'single', permission_mode: 'trusted',
  }, 'a CLI without profiles/child_limits drops those knobs');
  assert.equal(buildRuntimeConfig({ ...base, runtime: '' }), null);
});

test('backend-profile helpers gate on sessions.backend_profile rather than the claude literal', () => {
  const profiles = [{ id: 'p1', name: 'P1' }];
  assert.equal(runtimeProfileSelectionReady('claude', 'loading'), false);
  assert.equal(runtimeProfileSelectionReady('codex', 'loading'), true);
  assert.equal(runtimeProfileForAgentUpdate('claude', 'p1', profiles, 'ready'), 'p1');
  assert.equal(runtimeProfileForAgentUpdate('codex', 'p1', profiles, 'ready'), 'none');
  assert.equal(runtimeProfileForManagedAgentCreate('claude', 'p1', profiles, 'ready'), 'p1');
  assert.equal(runtimeProfileForManagedAgentCreate('hermes', 'p1', profiles, 'ready'), undefined);
});

test('login dialog helpers: command templating, default CLI, host label from keyed or legacy flags', () => {
  assert.equal(defaultLoginCli(), 'codex');
  assert.equal(cliLoginCommand('claude', '', ''), 'claude auth login');
  assert.equal(cliLoginCommand('codex', 'x', 'y'), 'codex login --device-auth', 'non provider-scoped CLIs ignore provider/method');
  assert.equal(cliLoginCommand('opencode', 'openai', 'ChatGPT Pro/Plus (headless)'), 'opencode auth login -p openai -m "ChatGPT Pro/Plus (headless)"');
  assert.equal(cliLoginCommand('opencode', '', ''), 'opencode auth login -p <provider> -m "<method>"');
  assert.equal(cliLoginCommand('future-cli', '', ''), '');

  const legacy = { instance_id: 'i', hostname: 'host', workspace_id: null, codex_installed: true, codex_healthy: true, claude_installed: true, claude_healthy: false };
  assert.equal(instanceLabel(legacy, 'codex'), 'host');
  assert.equal(instanceLabel(legacy, 'claude'), 'host (claude code installed, health unknown)');
  assert.equal(instanceLabel(legacy, 'opencode'), 'host (opencode not detected — may still work)');
  const keyed = { ...legacy, clis: { opencode: { installed: true, healthy: true }, codex: { installed: false, healthy: false } } };
  assert.equal(instanceLabel(keyed, 'opencode'), 'host', 'keyed map wins');
  assert.equal(instanceLabel(keyed, 'codex'), 'host (codex not detected — may still work)', 'keyed map wins over legacy flat keys');
  assert.equal(instanceLabel(keyed, 'claude'), 'host (claude code installed, health unknown)', 'falls back to legacy keys per CLI');
});

test('import dialog details come from the catalog login descriptor', () => {
  assert.deepEqual(importDetailsFor('codex'), {
    label: 'Codex CLI',
    command: 'codex login --device-auth',
    file: '~/.codex/auth.json',
    provider: 'codex_subscription',
    field: 'auth_json',
    extraFile: 'config_toml',
  });
  assert.equal(importDetailsFor('claude').provider, 'claude_subscription');
  assert.equal(importDetailsFor('claude').field, 'credentials_json');
  assert.equal(importDetailsFor('opencode').provider, 'opencode_auth');
  assert.equal(importDetailsFor('pi'), null, 'no login flow → nothing to import');
  assert.equal(importDetailsFor('future-cli'), null);
});

// ─── 5. presentation — 색/아이콘은 catalog prefix 로 CLI 를 찾는다 ─────────────

test('providerColor / providerIcon resolve CLI providers through the catalog prefix', () => {
  assert.equal(providerColor('claude_subscription'), cliColor('claude'));
  assert.equal(providerColor('claude_oauth_token'), cliColor('claude'));
  assert.equal(providerColor('opencode_auth'), cliColor('opencode'));
  assert.equal(providerColor('github'), '#24292f');
  assert.equal(providerColor('made-up'), providerColor(null), 'neutral default');
  assert.equal(providerIcon('claude_subscription'), 'CS');
  assert.equal(providerIcon('deepseek_api_key'), 'DS');
  assert.equal(providerIcon('opencode_auth'), 'OA');
  assert.equal(providerIcon('codex_future'), 'CX', 'unknown provider under a known prefix → CLI short code');
  assert.equal(providerIcon('made-up'), 'C');
});

// ─── 6. credentialFallbackCopy — 6개 CLI 출력은 표 이동 전과 동일 ───────────

test('credentialFallbackCopy output for the 6 known CLIs is unchanged (table moved to presentation.ts)', () => {
  const EXPECTED_OPTION_LABELS = {
    claude: 'None — use the host Claude CLI login (claude login)',
    codex: 'None — use the host Codex CLI login (codex login)',
    deepseek: 'None — use the host DEEPSEEK_API_KEY env',
    antigravity: 'None — use the host GEMINI_API_KEY env',
    pi: 'None — pi has no per-agent credential (uses the host pi login)',
    opencode: 'None — use the host opencode login (opencode auth login)',
  };
  for (const [cli, optionLabel] of Object.entries(EXPECTED_OPTION_LABELS)) {
    assert.equal(credentialFallbackCopy(cli).optionLabel, optionLabel, cli);
    assert.deepEqual(credentialFallbackCopy(cli), CREDENTIAL_FALLBACK_COPY[cli], cli);
    assert.match(credentialFallbackCopy(cli).meaning, /valid fallback configuration/);
  }
  assert.deepEqual(credentialFallbackCopy('hermes'), GENERIC_CREDENTIAL_FALLBACK);
  assert.deepEqual(credentialFallbackCopy('custom'), GENERIC_CREDENTIAL_FALLBACK);
  assert.deepEqual(credentialFallbackCopy(undefined), GENERIC_CREDENTIAL_FALLBACK);
});
