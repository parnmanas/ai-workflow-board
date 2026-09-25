/**
 * LLM CLI 카탈로그 — 서버가 CLI 하나에 대해 아는 모든 사실의 **단일 원천**.
 *
 * 예전에는 CLI 를 하나 추가하려면 7개 파일의 손으로 베낀 표를 각각 고쳐야
 * 했다(cli-types.ts 의 이름 목록, runtime-config.ts 의 실행 가능 집합,
 * effort-presets.ts 의 CLI 별 zod 블록, agent-sessions.ts 의 ACP 집합,
 * agent-sessions.service.ts 의 credential 접두어, credentials.controller.ts 의
 * provider 필드표, cli-login-session.service.ts 의 로그인 provider 표 …). 하나만
 * 빠뜨려도 컴파일은 통과하고 런타임에서만 조용히 어긋났다. 이제 그 표들은 전부
 * 이 파일의 `CLI_CATALOG` 에서 **파생**된다 — CLI 를 추가하려면 여기 descriptor
 * 하나를 넣는 것으로 끝난다(agent-manager 어댑터와 클라이언트 picker 는 별도
 * 빌드 유닛이라 여전히 자기 몫이 있다 — cli-types.ts 헤더 참조).
 *
 * `validateCliCatalog()` 가 모듈 로드 시점에 자기 검증을 돌린다: 접두어 규약,
 * provider id 규약, required/multiline/revealable ⊆ fields, 로그인 harvest
 * provider 존재, id 유일성. 카탈로그가 깨져 있으면 서버가 뜨지 않는다 —
 * 런타임에 조용히 어긋나는 것보다 낫다.
 *
 * REST: `GET /api/cli-catalog` (modules/cli-catalog) 가 이 배열을 그대로
 * 돌려 준다 — 클라이언트는 이 shape 를 그대로 미러하면 된다.
 */

/** CLI 와 매니저 사이의 실행 방식. `none` = custom(운영자가 launch script 를 준다). */
export type CliTransport = 'cli' | 'acp' | 'none';

/** effort preset 이 CLI 블록 안에 실을 수 있는 키(effort-presets.ts 참조). */
export type CliEffortKey = 'model' | 'effort' | 'ultracode';

/** Runtime config 협업 전략 — runtime-config.ts 의 ExecutionStrategy 와 같은 집합. */
export type CliCollaboration = 'single' | 'delegated' | 'swarm';

/**
 * CLI 하나가 받을 수 있는 Credential.provider 한 종류.
 *  - `fields`: 운영자가 입력하는 필드(credentials 화면 · PROVIDER_FIELDS 와 같은 뜻).
 *  - `required`: 자동 로그인 결과물 저장 시 반드시 있어야 하는 필드.
 *  - `multiline`: 붙여넣기 시 안쪽 공백을 보존하는 blob 필드(credential-fields.ts).
 *  - `revealable`: admin 이 비밀번호 재확인 뒤 원문을 볼 수 있는 필드(credentials reveal).
 */
export interface CliCredentialProviderDescriptor {
  id: string;
  label: string;
  fields: readonly string[];
  required: readonly string[];
  multiline: readonly string[];
  revealable: readonly string[];
}

/** 자동 로그인(device-auth) 다이얼로그의 provider 프리셋 — opencode 처럼 provider 단위로 로그인하는 CLI 전용. */
export interface CliLoginPreset {
  label: string;
  provider: string;
  method: string;
}

/** CLI 자동 로그인(ticket b2e79108) 이 아는 사실. 실제 spawn 은 agent-manager 의 cli-login.ts 가 한다. */
export interface CliLoginDescriptor {
  /** 로그인 결과물을 저장할 Credential.provider. */
  harvest_provider: string;
  /** 그 provider 에서 로그인 결과물(auth 파일 본문)이 들어갈 필드. */
  harvest_field: string;
  /** true 면 `-p <provider> -m <method>` 를 반드시 받는다(opencode). */
  provider_scoped: boolean;
  /** 안내용 커맨드 문자열(다이얼로그 설명문). */
  command: string;
  /** 로그인 결과 파일의 위치(안내용). */
  file_path: string | null;
  /** 로그인 결과물 외에 함께 거둬 오는 부가 파일 필드(codex 의 config_toml). */
  extra_file_field: string | null;
  presets: readonly CliLoginPreset[];
}

export interface CliDescriptor {
  id: string;
  label: string;
  transport: CliTransport;
  /** false 는 custom 뿐 — 매니저가 자동 spawn 을 거부한다. */
  executable: boolean;
  collaboration: readonly CliCollaboration[];
  /** null = credential 개념이 없다(pi / hermes / custom). `prefix` 는 항상 `${id}_`. */
  credential: {
    prefix: string;
    providers: readonly CliCredentialProviderDescriptor[];
  } | null;
  login: CliLoginDescriptor | null;
  sessions: {
    /** Agent Session(CLI 직접 세션)을 열 수 있는가. */
    acp: boolean;
    /** Claude backend profile 을 받을 수 있는가. */
    backend_profile: boolean;
  };
  /**
   * effort preset 블록. null = 블록 없음(hermes / custom).
   * `slice_key` 가 있으면 자기 블록을 갖지 않고 그 CLI 의 블록을 읽는다
   * (deepseek 는 Claude Code 바이너리로 돌기 때문에 `claude` 블록을 쓴다).
   */
  effort: {
    slice_key?: string;
    keys: readonly CliEffortKey[];
  } | null;
  /** 모델 id 를 골라 넘길 수 있는가(hermes 는 아니다). */
  model_selectable: boolean;
  /** runtime_config 의 CLI 별 knob — hermes 만 profile / max_children / max_iterations 를 쓴다. */
  runtime_config: {
    profiles: boolean;
    child_limits: boolean;
  };
  /** 매니저가 `update_cli` 로 갱신할 수 있는가(custom 은 아니다). */
  updatable: boolean;
}

const NO_SESSIONS = { acp: false, backend_profile: false } as const;
const NO_RUNTIME_KNOBS = { profiles: false, child_limits: false } as const;
const MODEL_ONLY = { keys: ['model'] } as const;

// `as const satisfies` — 리터럴 id 가 살아남아 CliType 이 문자열 유니온으로 파생되고,
// 동시에 각 항목이 CliDescriptor 모양임을 컴파일러가 확인한다.
const CATALOG = [
  {
    id: 'claude',
    label: 'Claude Code',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'claude_',
      providers: [
        // subscription = CLI 의 `login` 이 만든 OAuth credential 파일 본문을
        // 그대로 붙여넣은 것(per-agent cli-home 에 그대로 재생된다).
        {
          id: 'claude_subscription',
          label: 'Claude (Subscription)',
          fields: ['credentials_json'],
          required: ['credentials_json'],
          multiline: ['credentials_json'],
          revealable: [],
        },
        // api_key = 매니저가 ANTHROPIC_API_KEY 로 export 하는 billing token.
        {
          id: 'claude_api_key',
          label: 'Claude (API Key)',
          fields: ['api_key'],
          required: ['api_key'],
          multiline: [],
          revealable: [],
        },
        // `claude setup-token` 출력(sk-ant-oat…, 1년짜리 비회전 OAuth 토큰).
        // CLAUDE_CODE_OAUTH_TOKEN 으로 주입 — 회전하는 .credentials.json 과 달리
        // 하나를 등록해 모든 agent-manager 가 가져다 쓸 수 있어 admin 이 원문을
        // 다시 볼 수 있게(revealable) 둔다.
        {
          id: 'claude_oauth_token',
          label: 'Claude (OAuth Token)',
          fields: ['oauth_token'],
          required: ['oauth_token'],
          multiline: [],
          revealable: ['oauth_token'],
        },
      ],
    },
    login: {
      harvest_provider: 'claude_subscription',
      harvest_field: 'credentials_json',
      provider_scoped: false,
      command: 'claude auth login',
      file_path: '~/.claude/.credentials.json',
      extra_file_field: null,
      presets: [],
    },
    sessions: { acp: true, backend_profile: true },
    effort: { keys: ['effort', 'ultracode', 'model'] },
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    // DeepSeek 는 Claude Code 바이너리로 DeepSeek 의 Anthropic 호환 endpoint 에
    // 붙는다. Claude CLI 홈을 공유하므로 세션은 claude 로 흡수되고, effort
    // preset 도 claude 블록을 읽는다.
    id: 'deepseek',
    label: 'DeepSeek',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'deepseek_',
      providers: [
        // api_key 는 ANTHROPIC_AUTH_TOKEN 으로 export; model/base_url 은 선택 override.
        {
          id: 'deepseek_api_key',
          label: 'DeepSeek (API Key)',
          fields: ['api_key', 'model', 'base_url'],
          required: ['api_key'],
          multiline: [],
          revealable: [],
        },
      ],
    },
    login: null,
    sessions: NO_SESSIONS,
    effort: { slice_key: 'claude', keys: ['effort', 'ultracode', 'model'] },
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    id: 'codex',
    label: 'Codex',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'codex_',
      providers: [
        {
          id: 'codex_subscription',
          label: 'Codex (Subscription)',
          fields: ['auth_json', 'config_toml'],
          required: ['auth_json'],
          multiline: ['auth_json', 'config_toml'],
          revealable: [],
        },
        {
          id: 'codex_api_key',
          label: 'Codex (API Key)',
          fields: ['api_key'],
          required: ['api_key'],
          multiline: [],
          revealable: [],
        },
      ],
    },
    login: {
      harvest_provider: 'codex_subscription',
      harvest_field: 'auth_json',
      provider_scoped: false,
      command: 'codex login --device-auth',
      file_path: '~/.codex/auth.json',
      extra_file_field: 'config_toml',
      presets: [],
    },
    sessions: { acp: true, backend_profile: false },
    effort: MODEL_ONLY,
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    id: 'antigravity',
    label: 'Antigravity',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'antigravity_',
      providers: [
        {
          id: 'antigravity_subscription',
          label: 'Antigravity (Subscription)',
          fields: ['oauth_creds_json'],
          required: ['oauth_creds_json'],
          multiline: ['oauth_creds_json'],
          revealable: [],
        },
        {
          id: 'antigravity_api_key',
          label: 'Antigravity (API Key)',
          fields: ['api_key'],
          required: ['api_key'],
          multiline: [],
          revealable: [],
        },
      ],
    },
    login: null,
    sessions: NO_SESSIONS,
    effort: MODEL_ONLY,
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    // pi 는 credential 개념이 아예 없다(다른 어댑터는 최소한 선택적 per-agent credential 을 받는다).
    id: 'pi',
    label: 'PI',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: null,
    login: null,
    sessions: NO_SESSIONS,
    effort: MODEL_ONLY,
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    // opencode 는 provider 단위로 로그인한다(openai / github-copilot / anthropic …).
    // 결과물은 provider 가 무엇이든 `~/.local/share/opencode/auth.json` 한 파일이므로
    // credential kind 도 하나다 — 어느 provider 인지는 파일 자신이 알고 있고,
    // 어댑터는 그대로 되돌려 쓸 뿐이다. 어댑터 사이드카 없이 자기 자신이 ACP 서버다.
    id: 'opencode',
    label: 'OpenCode',
    transport: 'cli',
    executable: true,
    collaboration: ['single'],
    credential: {
      prefix: 'opencode_',
      providers: [
        {
          id: 'opencode_auth',
          label: 'Opencode (Provider Auth)',
          fields: ['auth_json'],
          required: ['auth_json'],
          multiline: ['auth_json'],
          revealable: [],
        },
      ],
    },
    login: {
      harvest_provider: 'opencode_auth',
      harvest_field: 'auth_json',
      // `-p`/`-m` 을 빠뜨리면 CLI 가 TTY 선택 UI 를 띄우려다 파이프 뒤에서
      // 조용히 멎어 10분 타임아웃까지 "starting" 으로 남는다(실측) — fail-fast.
      provider_scoped: true,
      command: 'opencode auth login -p <provider> -m "<method>"',
      file_path: '~/.local/share/opencode/auth.json',
      extra_file_field: null,
      presets: [
        { label: 'OpenAI — ChatGPT Pro/Plus', provider: 'openai', method: 'ChatGPT Pro/Plus (headless)' },
        { label: 'GitHub Copilot', provider: 'github-copilot', method: 'Login with GitHub Copilot' },
      ],
    },
    sessions: { acp: true, backend_profile: false },
    effort: MODEL_ONLY,
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: true,
  },
  {
    // hermes 는 ACP 네이티브 런타임 — delegated/swarm 협업과 profile /
    // max_children / max_iterations knob 을 유일하게 지원한다. credential 은 아직 없다.
    id: 'hermes',
    label: 'Hermes ACP',
    transport: 'acp',
    executable: true,
    collaboration: ['single', 'delegated', 'swarm'],
    credential: null,
    login: null,
    sessions: { acp: true, backend_profile: false },
    effort: null,
    model_selectable: false,
    runtime_config: { profiles: true, child_limits: true },
    updatable: true,
  },
  {
    // custom 은 유효한 정체성이지만 매니저가 자동 spawn 을 거부한다(운영자가 launch script 를 준다).
    id: 'custom',
    label: 'Custom',
    transport: 'none',
    executable: false,
    collaboration: ['single'],
    credential: null,
    login: null,
    sessions: NO_SESSIONS,
    effort: null,
    model_selectable: true,
    runtime_config: NO_RUNTIME_KNOBS,
    updatable: false,
  },
] as const satisfies readonly CliDescriptor[];

/** 카탈로그 id 의 문자열 리터럴 유니온 — cli-types.ts 가 `CliType` 으로 재export 한다. */
export type CliType = (typeof CATALOG)[number]['id'];

export const CLI_CATALOG: readonly CliDescriptor[] = CATALOG;

/** 카탈로그 순서 그대로의 id 목록(cli-types.ts 의 CLI_TYPES). */
export const CLI_IDS: readonly CliType[] = CATALOG.map((d) => d.id);

/** `cli` 가 비어 있거나 알 수 없을 때 쓰는 기본 CLI(heartbeat / 이벤트 fallback). */
export const DEFAULT_CLI_ID: CliType = 'claude';

export function cliDescriptor(id: string | null | undefined): CliDescriptor | null {
  if (typeof id !== 'string') return null;
  const key = id.trim().toLowerCase();
  if (!key) return null;
  return CLI_CATALOG.find((d) => d.id === key) ?? null;
}

// ─── 파생 헬퍼 ───────────────────────────────────────────────────────────
// 모두 `catalog` 인자를 받아 기본값으로 CLI_CATALOG 를 쓴다 — 테스트가 fixture
// descriptor 를 덧붙인 사본으로 같은 표를 만들어 "다른 파일을 안 고쳐도 따라온다"
// 를 단언할 수 있게.

/** 카탈로그 순서로 펼친 모든 CLI credential provider. */
export function catalogCredentialProviders(
  catalog: readonly CliDescriptor[] = CLI_CATALOG,
): CliCredentialProviderDescriptor[] {
  const out: CliCredentialProviderDescriptor[] = [];
  for (const d of catalog) {
    if (!d.credential) continue;
    out.push(...d.credential.providers);
  }
  return out;
}

/** 자동 로그인을 지원하는 descriptor 만. */
export function catalogLoginCapable(
  catalog: readonly CliDescriptor[] = CLI_CATALOG,
): CliDescriptor[] {
  return catalog.filter((d) => d.login !== null);
}

/** 모든 provider 의 multiline 필드 합집합(중복 제거, 등장 순서 유지). */
export function catalogMultilineFields(
  catalog: readonly CliDescriptor[] = CLI_CATALOG,
): string[] {
  const seen = new Set<string>();
  for (const p of catalogCredentialProviders(catalog)) {
    for (const f of p.multiline) seen.add(f);
  }
  return [...seen];
}

// ─── 자기 검증 ───────────────────────────────────────────────────────────

/**
 * 카탈로그 불변식을 검사하고 위반 시 throw. 모듈 로드 시 한 번 호출되고,
 * 테스트가 fixture 사본에 대해 다시 부른다.
 */
export function validateCliCatalog(catalog: readonly CliDescriptor[] = CLI_CATALOG): void {
  const errors: string[] = [];
  const ids = new Set<string>();
  const providerIds = new Set<string>();
  const providerOwner = new Map<string, CliDescriptor>();

  for (const d of catalog) {
    if (!d.id || d.id !== d.id.trim().toLowerCase()) errors.push(`descriptor id "${d.id}" must be a trimmed lowercase slug`);
    if (ids.has(d.id)) errors.push(`duplicate descriptor id "${d.id}"`);
    ids.add(d.id);
    if (!d.label) errors.push(`${d.id}: label is required`);
    if (d.transport === 'none' && d.executable) errors.push(`${d.id}: transport 'none' cannot be executable`);
    if (d.transport !== 'none' && !d.executable) errors.push(`${d.id}: transport '${d.transport}' must be executable`);
    if (!d.collaboration.includes('single')) errors.push(`${d.id}: collaboration must include 'single'`);
    if (d.sessions.backend_profile && !d.sessions.acp) errors.push(`${d.id}: backend_profile requires acp sessions`);

    if (d.credential) {
      const expectedPrefix = `${d.id}_`;
      if (d.credential.prefix !== expectedPrefix) {
        errors.push(`${d.id}: credential.prefix must be "${expectedPrefix}" (got "${d.credential.prefix}")`);
      }
      if (d.credential.providers.length === 0) errors.push(`${d.id}: credential.providers must not be empty`);
      for (const p of d.credential.providers) {
        if (!p.id.startsWith(d.credential.prefix)) errors.push(`${d.id}: provider "${p.id}" must start with "${d.credential.prefix}"`);
        if (providerIds.has(p.id)) errors.push(`duplicate credential provider id "${p.id}"`);
        providerIds.add(p.id);
        providerOwner.set(p.id, d);
        if (!p.label) errors.push(`${p.id}: label is required`);
        if (p.fields.length === 0) errors.push(`${p.id}: fields must not be empty`);
        if (new Set(p.fields).size !== p.fields.length) errors.push(`${p.id}: duplicate field`);
        for (const [name, subset] of [['required', p.required], ['multiline', p.multiline], ['revealable', p.revealable]] as const) {
          for (const f of subset) {
            if (!p.fields.includes(f)) errors.push(`${p.id}: ${name} field "${f}" is not in fields`);
          }
        }
        if (p.required.length === 0) errors.push(`${p.id}: required must name at least one field`);
      }
    }

    if (d.login) {
      const owner = providerOwner.get(d.login.harvest_provider);
      const provider = d.credential?.providers.find((p) => p.id === d.login!.harvest_provider) ?? null;
      if (!provider) {
        errors.push(`${d.id}: login.harvest_provider "${d.login.harvest_provider}" is not one of this CLI's credential providers`);
      } else {
        if (owner !== d) errors.push(`${d.id}: login.harvest_provider belongs to another CLI`);
        if (!provider.fields.includes(d.login.harvest_field)) {
          errors.push(`${d.id}: login.harvest_field "${d.login.harvest_field}" is not a field of ${provider.id}`);
        }
        if (!provider.required.includes(d.login.harvest_field)) {
          errors.push(`${d.id}: login.harvest_field "${d.login.harvest_field}" must be required on ${provider.id}`);
        }
        if (d.login.extra_file_field && !provider.fields.includes(d.login.extra_file_field)) {
          errors.push(`${d.id}: login.extra_file_field "${d.login.extra_file_field}" is not a field of ${provider.id}`);
        }
      }
      if (!d.login.command) errors.push(`${d.id}: login.command is required`);
      if (d.login.provider_scoped && d.login.presets.length === 0) {
        errors.push(`${d.id}: a provider-scoped login needs at least one preset`);
      }
      if (!d.login.provider_scoped && d.login.presets.length > 0) {
        errors.push(`${d.id}: presets only make sense for a provider-scoped login`);
      }
    }

    if (d.effort) {
      if (d.effort.keys.length === 0) errors.push(`${d.id}: effort.keys must not be empty`);
      if (new Set(d.effort.keys).size !== d.effort.keys.length) errors.push(`${d.id}: duplicate effort key`);
    }
  }

  // slice_key 는 자기 블록을 가진(즉 slice_key 없는) 다른 descriptor 를 가리켜야 한다.
  for (const d of catalog) {
    const slice = d.effort?.slice_key;
    if (!slice) continue;
    const target = catalog.find((x) => x.id === slice);
    if (!target) errors.push(`${d.id}: effort.slice_key "${slice}" names an unknown CLI`);
    else if (!target.effort) errors.push(`${d.id}: effort.slice_key "${slice}" names a CLI without an effort block`);
    else if (target.effort.slice_key) errors.push(`${d.id}: effort.slice_key "${slice}" must not chain to another slice`);
    else if (target.id === d.id) errors.push(`${d.id}: effort.slice_key cannot be self`);
  }

  if (!ids.has(DEFAULT_CLI_ID)) errors.push(`DEFAULT_CLI_ID "${DEFAULT_CLI_ID}" is not in the catalog`);

  if (errors.length > 0) {
    throw new Error(`CLI catalog is invalid:\n  - ${errors.join('\n  - ')}`);
  }
}

validateCliCatalog();
