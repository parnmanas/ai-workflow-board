// CLI 카탈로그(common/cli-catalog.ts) — 서버가 CLI 하나에 대해 아는 모든 사실의
// 단일 원천.
//
// 이 파일이 지키는 것:
//   1. 카탈로그 자체가 자기 검증(validateCliCatalog)을 통과한다.
//   2. 예전에 7개 파일에 손으로 베껴 두던 표들이 카탈로그에서 파생된 뒤에도
//      **정확히 예전 리터럴 값**과 같다 — 리팩터링이 동작을 바꾸지 않았다는 증거.
//   3. effort preset 스키마가 예전과 같은 preset 을 받고, 여전히 strict 하다.
//   4. 카탈로그 사본에 fixture descriptor 하나를 덧붙이면 다른 파일을 하나도
//      안 고쳐도 스키마/표들이 그것을 포함한다 — "CLI 추가 = descriptor 하나".
import 'reflect-metadata';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.ENCRYPTION_KEY = `test-encryption-key-${randomUUID()}`;

const {
  CLI_CATALOG,
  CLI_IDS,
  DEFAULT_CLI_ID,
  cliDescriptor,
  validateCliCatalog,
  catalogCredentialProviders,
  catalogLoginCapable,
  catalogMultilineFields,
} = await import('../dist/common/cli-catalog.js');
const { CLI_TYPES, ALLOWED_CLI_TYPES } = await import('../dist/common/types/cli-types.js');
const { isExecutableRuntime, validateAgentRuntimeConfig } = await import('../dist/common/runtime-config.js');
const {
  EffortPresetSchema,
  EffortPresetsConfigSchema,
  BUILTIN_EFFORT_PRESETS,
  buildEffortPresetSchema,
  validateEffortPresetsInput,
} = await import('../dist/common/effort-presets.js');
const { ACP_SESSION_CLIS } = await import('../dist/common/types/agent-sessions.js');
const { MULTILINE_CREDENTIAL_FIELDS } = await import('../dist/common/credential-fields.js');
const {
  PROVIDER_FIELDS,
  REVEALABLE_OAUTH_FIELDS,
  NON_CLI_CREDENTIAL_PROVIDERS,
  buildProviderFields,
  buildRevealableFields,
} = await import('../dist/common/credential-providers.js');
const { TEAM_SLOT_CLIS, mergeTeamAgentSpec } = await import('../dist/common/orchestration-member-spec.js');
const { SESSION_CLI_CREDENTIAL_PREFIX, BACKEND_PROFILE_CLIS } = await import(
  '../dist/modules/agent-sessions/agent-sessions.service.js'
);
const { CLI_PROVIDER, PROVIDER_SCOPED_CLIS, REQUIRED_FIELD } = await import(
  '../dist/modules/credentials/cli-login-session.service.js'
);

// ─── 예전 리터럴 (리팩터링 직전 각 파일에 있던 값 그대로) ─────────────────

const OLD_CLI_TYPES = ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'opencode', 'hermes', 'custom'];
const OLD_EXECUTABLE_RUNTIMES = ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'opencode', 'hermes'];
const OLD_ACP_SESSION_CLIS = ['claude', 'codex', 'opencode', 'hermes'];
const OLD_SESSION_CLI_CREDENTIAL_PREFIX = { claude: 'claude_', codex: 'codex_', opencode: 'opencode_' };
const OLD_BACKEND_PROFILE_CLIS = ['claude'];
const OLD_PROVIDER_FIELDS = {
  github: { label: 'GitHub', fields: ['token'] },
  gitlab: { label: 'GitLab', fields: ['token'] },
  openai: { label: 'OpenAI', fields: ['api_key'] },
  custom: { label: 'Custom', fields: ['token'] },
  claude_subscription: { label: 'Claude (Subscription)', fields: ['credentials_json'] },
  claude_api_key: { label: 'Claude (API Key)', fields: ['api_key'] },
  claude_oauth_token: { label: 'Claude (OAuth Token)', fields: ['oauth_token'] },
  deepseek_api_key: { label: 'DeepSeek (API Key)', fields: ['api_key', 'model', 'base_url'] },
  codex_subscription: { label: 'Codex (Subscription)', fields: ['auth_json', 'config_toml'] },
  codex_api_key: { label: 'Codex (API Key)', fields: ['api_key'] },
  opencode_auth: { label: 'Opencode (Provider Auth)', fields: ['auth_json'] },
  antigravity_subscription: { label: 'Antigravity (Subscription)', fields: ['oauth_creds_json'] },
  antigravity_api_key: { label: 'Antigravity (API Key)', fields: ['api_key'] },
};
const OLD_REVEALABLE_OAUTH_FIELDS = { claude_oauth_token: ['oauth_token'] };
const OLD_CLI_PROVIDER = {
  codex: 'codex_subscription',
  claude: 'claude_subscription',
  opencode: 'opencode_auth',
};
const OLD_PROVIDER_SCOPED_CLIS = ['opencode'];
const OLD_REQUIRED_FIELD = {
  codex_subscription: 'auth_json',
  claude_subscription: 'credentials_json',
  opencode_auth: 'auth_json',
};
const OLD_MULTILINE_CREDENTIAL_FIELDS = ['credentials_json', 'auth_json', 'config_toml', 'oauth_creds_json'];
const OLD_EFFORT_CLI_BLOCKS = ['claude', 'codex', 'antigravity', 'pi', 'opencode'];

const sorted = (xs) => [...xs].sort();
const plain = (v) => JSON.parse(JSON.stringify(v));

// ─── 1. 카탈로그 자체 ─────────────────────────────────────────────────

test('catalog validates and is ordered/labelled as specified', () => {
  assert.doesNotThrow(() => validateCliCatalog());
  assert.deepEqual(CLI_CATALOG.map((d) => d.id), OLD_CLI_TYPES);
  assert.deepEqual(CLI_IDS, OLD_CLI_TYPES);
  assert.deepEqual(
    CLI_CATALOG.map((d) => d.label),
    ['Claude Code', 'DeepSeek', 'Codex', 'Antigravity', 'PI', 'OpenCode', 'Hermes ACP', 'Custom'],
  );
  assert.equal(DEFAULT_CLI_ID, 'claude');
  assert.equal(cliDescriptor('claude')?.label, 'Claude Code');
  assert.equal(cliDescriptor(' Codex ')?.id, 'codex', 'lookup trims + lowercases');
  assert.equal(cliDescriptor('gpt'), null, 'retired ids are not in the catalog');
  assert.equal(cliDescriptor(null), null);
  assert.equal(cliDescriptor(undefined), null);
  assert.equal(cliDescriptor(''), null);
});

test('catalog encodes the per-CLI facts the old tables carried', () => {
  const byId = Object.fromEntries(CLI_CATALOG.map((d) => [d.id, d]));
  assert.equal(byId.custom.executable, false);
  assert.equal(byId.custom.transport, 'none');
  assert.equal(byId.custom.updatable, false);
  assert.equal(byId.hermes.transport, 'acp');
  assert.deepEqual(byId.hermes.collaboration, ['single', 'delegated', 'swarm']);
  assert.deepEqual(byId.hermes.runtime_config, { profiles: true, child_limits: true });
  assert.equal(byId.hermes.model_selectable, false);
  assert.equal(byId.hermes.effort, null);
  assert.equal(byId.hermes.credential, null);
  assert.equal(byId.pi.credential, null);
  assert.deepEqual(byId.deepseek.effort, { slice_key: 'claude', keys: ['effort', 'ultracode', 'model'] });
  assert.deepEqual(byId.claude.effort, { keys: ['effort', 'ultracode', 'model'] });
  for (const id of ['codex', 'antigravity', 'pi', 'opencode']) {
    assert.deepEqual(byId[id].effort, { keys: ['model'] }, `${id} is model-only`);
  }
  for (const d of CLI_CATALOG) {
    if (d.id === 'hermes') continue;
    assert.deepEqual(d.collaboration, ['single'], `${d.id} is single-only`);
    assert.deepEqual(d.runtime_config, { profiles: false, child_limits: false }, `${d.id} has no hermes knobs`);
  }
  // 로그인 — 안내 문자열은 클라이언트(CliAutoLogin.tsx)가 보여 주던 값 그대로.
  assert.deepEqual(byId.codex.login, {
    harvest_provider: 'codex_subscription',
    harvest_field: 'auth_json',
    provider_scoped: false,
    command: 'codex login --device-auth',
    file_path: '~/.codex/auth.json',
    extra_file_field: 'config_toml',
    presets: [],
  });
  assert.deepEqual(byId.claude.login, {
    harvest_provider: 'claude_subscription',
    harvest_field: 'credentials_json',
    provider_scoped: false,
    command: 'claude auth login',
    file_path: '~/.claude/.credentials.json',
    extra_file_field: null,
    presets: [],
  });
  assert.equal(byId.opencode.login.provider_scoped, true);
  assert.equal(byId.opencode.login.file_path, '~/.local/share/opencode/auth.json');
  assert.deepEqual(byId.opencode.login.presets, [
    { label: 'OpenAI — ChatGPT Pro/Plus', provider: 'openai', method: 'ChatGPT Pro/Plus (headless)' },
    { label: 'GitHub Copilot', provider: 'github-copilot', method: 'Login with GitHub Copilot' },
  ]);
  for (const id of ['deepseek', 'antigravity', 'pi', 'hermes', 'custom']) {
    assert.equal(byId[id].login, null, `${id} has no automated login`);
  }
  assert.deepEqual(catalogLoginCapable().map((d) => d.id), ['claude', 'codex', 'opencode']);
});

test('validateCliCatalog rejects a descriptor that breaks an invariant', () => {
  const bad = (patch) => {
    const claude = plain(CLI_CATALOG[0]);
    const rest = CLI_CATALOG.slice(1);
    return [{ ...claude, ...patch }, ...rest];
  };
  assert.throws(
    () => validateCliCatalog(bad({ credential: { prefix: 'cla_', providers: CLI_CATALOG[0].credential.providers } })),
    /credential\.prefix must be "claude_"/,
  );
  assert.throws(
    () => validateCliCatalog(bad({ id: 'codex' })),
    /duplicate descriptor id "codex"/,
  );
  assert.throws(
    () => validateCliCatalog(bad({ login: { ...CLI_CATALOG[0].login, harvest_provider: 'codex_subscription' } })),
    /harvest_provider "codex_subscription" is not one of this CLI's credential providers/,
  );
  assert.throws(
    () => validateCliCatalog(bad({
      credential: {
        prefix: 'claude_',
        providers: [{ id: 'claude_x', label: 'X', fields: ['a'], required: ['b'], multiline: [], revealable: [] }],
      },
      login: null,
    })),
    /required field "b" is not in fields/,
  );
  assert.throws(
    () => validateCliCatalog(bad({
      credential: {
        prefix: 'claude_',
        providers: [{ id: 'other_x', label: 'X', fields: ['a'], required: ['a'], multiline: [], revealable: [] }],
      },
      login: null,
    })),
    /provider "other_x" must start with "claude_"/,
  );
  assert.throws(
    () => validateCliCatalog(bad({ executable: false })),
    /transport 'cli' must be executable/,
  );
});

// ─── 2. 파생된 표 == 예전 리터럴 ────────────────────────────────────────

test('derived constants equal the old hand-written literals', () => {
  assert.deepEqual([...CLI_TYPES], OLD_CLI_TYPES);
  assert.deepEqual(sorted(ALLOWED_CLI_TYPES), sorted(OLD_CLI_TYPES));

  assert.deepEqual(OLD_CLI_TYPES.filter((id) => isExecutableRuntime(id)), OLD_EXECUTABLE_RUNTIMES);
  assert.equal(isExecutableRuntime('custom'), false);
  assert.deepEqual([...TEAM_SLOT_CLIS], OLD_EXECUTABLE_RUNTIMES);

  assert.deepEqual(sorted(ACP_SESSION_CLIS), sorted(OLD_ACP_SESSION_CLIS));
  assert.deepEqual(SESSION_CLI_CREDENTIAL_PREFIX, OLD_SESSION_CLI_CREDENTIAL_PREFIX);
  assert.deepEqual([...BACKEND_PROFILE_CLIS], OLD_BACKEND_PROFILE_CLIS);

  assert.deepEqual(sorted(Object.keys(PROVIDER_FIELDS)), sorted(Object.keys(OLD_PROVIDER_FIELDS)));
  for (const [id, entry] of Object.entries(OLD_PROVIDER_FIELDS)) {
    assert.deepEqual(plain(PROVIDER_FIELDS[id]), entry, `PROVIDER_FIELDS.${id}`);
  }
  assert.deepEqual(
    Object.keys(NON_CLI_CREDENTIAL_PROVIDERS),
    ['github', 'gitlab', 'openai', 'custom'],
  );
  assert.deepEqual(plain(REVEALABLE_OAUTH_FIELDS), OLD_REVEALABLE_OAUTH_FIELDS);

  assert.deepEqual(CLI_PROVIDER, OLD_CLI_PROVIDER);
  assert.deepEqual(sorted(PROVIDER_SCOPED_CLIS), OLD_PROVIDER_SCOPED_CLIS);
  assert.deepEqual(REQUIRED_FIELD, OLD_REQUIRED_FIELD);

  assert.deepEqual([...MULTILINE_CREDENTIAL_FIELDS], OLD_MULTILINE_CREDENTIAL_FIELDS);
  assert.deepEqual(catalogMultilineFields(), OLD_MULTILINE_CREDENTIAL_FIELDS);
});

test('runtime-config collaboration gate still follows the catalog (hermes only)', () => {
  const base = { permission_mode: 'approve' };
  assert.equal(validateAgentRuntimeConfig('hermes', { ...base, strategy: 'swarm' }).strategy, 'swarm');
  assert.throws(
    () => validateAgentRuntimeConfig('claude', { ...base, strategy: 'swarm' }),
    /does not support swarm collaboration/,
  );
  assert.throws(() => validateAgentRuntimeConfig('custom', { ...base, strategy: 'single' }), /Unknown executable runtime/);
});

test('mergeTeamAgentSpec resets strategy/knobs per the catalog on a CLI change', () => {
  const hermes = {
    manager_agent_id: 'mgr',
    cli: 'hermes',
    model: null,
    working_dir: '/srv/work',
    folder_scope: 'shared',
    credential_id: null,
    cli_runtime_profile: null,
    runtime_config: { strategy: 'swarm', permission_mode: 'trusted', profile: 'p', max_children: 3, max_iterations: 9 },
  };
  const toClaude = mergeTeamAgentSpec(hermes, { cli: 'claude' }, 'slot');
  assert.equal(toClaude.cli, 'claude');
  // strategy falls back to single, hermes-only knobs vanish, permission tier survives.
  assert.deepEqual(toClaude.runtime_config, { strategy: 'single', permission_mode: 'trusted' });

  const claude = { ...hermes, cli: 'claude', runtime_config: { strategy: 'single', permission_mode: 'strict' } };
  const toHermes = mergeTeamAgentSpec(claude, { cli: 'hermes' }, 'slot');
  assert.deepEqual(toHermes.runtime_config, { strategy: 'single', permission_mode: 'strict' });
});

// ─── 3. effort preset 스키마 ────────────────────────────────────────────

test('effort preset schema accepts the same presets as before and stays strict', () => {
  assert.deepEqual(sorted(Object.keys(EffortPresetSchema.shape)), sorted(['id', 'label', ...OLD_EFFORT_CLI_BLOCKS]));
  assert.equal('deepseek' in EffortPresetSchema.shape, false, 'deepseek reads the claude slice — no block of its own');
  assert.equal('hermes' in EffortPresetSchema.shape, false);
  assert.equal('custom' in EffortPresetSchema.shape, false);

  const ok = EffortPresetsConfigSchema.safeParse(BUILTIN_EFFORT_PRESETS);
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));

  const rich = {
    id: 'everything',
    label: 'Everything',
    claude: { effort: 'max', ultracode: true, model: 'claude-opus' },
    codex: { model: 'gpt-5-codex' },
    antigravity: { model: 'gemini' },
    pi: { model: 'pi-1' },
    opencode: { model: 'x/y' },
  };
  assert.equal(EffortPresetSchema.safeParse(rich).success, true);

  // strict: unknown keys at either level are rejected exactly as before.
  assert.equal(EffortPresetSchema.safeParse({ ...rich, bogus: {} }).success, false);
  assert.equal(EffortPresetSchema.safeParse({ ...rich, codex: { effort: 'high' } }).success, false, 'codex is model-only');
  assert.equal(EffortPresetSchema.safeParse({ ...rich, claude: { speed: 'fast' } }).success, false);
  assert.equal(EffortPresetSchema.safeParse({ ...rich, claude: { effort: 'turbo' } }).success, false, 'effort enum');
  assert.equal(EffortPresetSchema.safeParse({ ...rich, deepseek: { model: 'v3' } }).success, false, 'no deepseek block');

  const invalid = validateEffortPresetsInput({ default: 'x', presets: [{ id: 'x', label: 'X', codex: { ultracode: true } }] });
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /codex/);
});

// ─── 4. fixture descriptor 하나로 모든 표가 따라온다 ─────────────────────

const FIXTURE = {
  id: 'zeta',
  label: 'Zeta',
  transport: 'cli',
  executable: true,
  collaboration: ['single', 'delegated'],
  credential: {
    prefix: 'zeta_',
    providers: [
      {
        id: 'zeta_subscription',
        label: 'Zeta (Subscription)',
        fields: ['auth_blob', 'region'],
        required: ['auth_blob'],
        multiline: ['auth_blob'],
        revealable: ['region'],
      },
      {
        id: 'zeta_api_key',
        label: 'Zeta (API Key)',
        fields: ['api_key'],
        required: ['api_key'],
        multiline: [],
        revealable: [],
      },
    ],
  },
  login: {
    harvest_provider: 'zeta_subscription',
    harvest_field: 'auth_blob',
    provider_scoped: false,
    command: 'zeta login',
    file_path: '~/.zeta/auth.blob',
    extra_file_field: 'region',
    presets: [],
  },
  sessions: { acp: true, backend_profile: false },
  effort: { keys: ['model', 'effort'] },
  model_selectable: true,
  runtime_config: { profiles: false, child_limits: true },
  updatable: true,
};

test('appending one descriptor to a catalog copy propagates to every derived table', () => {
  const copy = [...CLI_CATALOG, FIXTURE];
  assert.doesNotThrow(() => validateCliCatalog(copy));
  // the real catalog is untouched
  assert.equal(cliDescriptor('zeta'), null);

  const providers = catalogCredentialProviders(copy).map((p) => p.id);
  assert.ok(providers.includes('zeta_subscription') && providers.includes('zeta_api_key'));

  const fields = buildProviderFields(copy);
  assert.deepEqual(fields.zeta_subscription, { label: 'Zeta (Subscription)', fields: ['auth_blob', 'region'] });
  assert.deepEqual(fields.zeta_api_key, { label: 'Zeta (API Key)', fields: ['api_key'] });
  assert.deepEqual(fields.github, OLD_PROVIDER_FIELDS.github, 'non-CLI providers still present');

  assert.deepEqual(plain(buildRevealableFields(copy)), { ...OLD_REVEALABLE_OAUTH_FIELDS, zeta_subscription: ['region'] });
  assert.deepEqual(catalogMultilineFields(copy), [...OLD_MULTILINE_CREDENTIAL_FIELDS, 'auth_blob']);
  assert.deepEqual(catalogLoginCapable(copy).map((d) => d.id), ['claude', 'codex', 'opencode', 'zeta']);

  const schema = buildEffortPresetSchema(copy);
  assert.ok('zeta' in schema.shape);
  assert.equal(schema.safeParse({ id: 'p', label: 'P', zeta: { model: 'z-1', effort: 'high' } }).success, true);
  assert.equal(schema.safeParse({ id: 'p', label: 'P', zeta: { ultracode: true } }).success, false, 'only the declared keys');
  assert.equal(EffortPresetSchema.safeParse({ id: 'p', label: 'P', zeta: { model: 'z-1' } }).success, false, 'real schema unchanged');
});
