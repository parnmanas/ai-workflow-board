/**
 * 실효 실행 사양(effective launch spec) — ticket 20fff298.
 *
 * 관리 대상 에이전트 하나가 **다음에 spawn 될 때 실제로 받게 될** 실행 파일과
 * argv 를, 출처를 붙여 계산한다. heartbeat 에 실려 AWB 로 올라가고 Agent
 * details 화면의 "실행 인자" 섹션이 이 값을 그대로 보여준다.
 *
 * ## 왜 argv 를 다시 조립하지 않는가
 *
 * 이 모듈은 플래그 이름을 하나도 알지 못한다 — 어댑터의 **실제** 빌더
 * (`buildOneshotSpawn` / `buildSessionSpawn`)를 호출해 나온 descriptor 를 읽을
 * 뿐이다. 여기서 "claude 면 --model, codex 면 -c ..." 식으로 argv 를 재구성했다면
 * 어댑터가 바뀔 때마다 조용히 어긋나고, 화면은 실제로 실행되지 않는 명령을
 * 보여주게 된다. 화면의 목적이 "실제로 뭐가 붙었는지 확인"인 이상 그건 버그보다
 * 나쁘다.
 *
 * ## 왜 모드가 둘인가
 *
 * spawn 경로가 실제로 둘이고 **argv 모양이 다르다**:
 *   - `session` — persistent 티켓/채팅 세션. `delegation.persistentTicketSessions`
 *     기본값이 true 라 claude 계열 티켓 디스패치의 **기본 경로**다
 *     (`base-session-manager.ts` → `buildSessionSpawn`). `--session-id` 와
 *     `--input-format stream-json` 이 붙고 `--print` 는 없다.
 *   - `oneshot` — 일회성 실행 (`subagent-manager.ts` → `buildOneshotSpawn`).
 *     `--print` 가 붙고 task text 가 positional 로 들어간다.
 *
 * 하나만 보고하면 나머지 경로에서는 **실행되지 않는 명령**을 보여주게 된다.
 * 그래서 지원하는 모드를 전부, 기본 경로를 앞에 두고 보고한다.
 *
 * ## 출처는 어떻게 붙이는가
 *
 * 출처도 하드코딩하지 않는다. 입력 하나를 뺀 **변형(variant)** 을 같은 빌더로
 * 다시 만들어, 원본에는 있는데 변형에는 없는 토큰을 그 입력의 것으로 귀속한다
 * ({@link attributeBy}). 어댑터가 플래그 철자를 바꿔도 귀속은 따라간다.
 *
 * ## 무엇이 여기 없는가
 *
 * 프롬프트 본문·task text·세션 id 는 실행 시점에만 정해지므로 자리표시자를
 * 넣고 `placeholder` 로 표시한다. 보드/워크스페이스 harness 와 티켓 effort
 * preset, 티켓별 `cli_runtime_profile` 도 **디스패치 시점** 입력이라 heartbeat
 * 시점에는 알 수 없다 — 지어내지 않고 `varies_per_dispatch` 에 이름만 남긴다.
 */

import { createAdapter } from './cli-adapters/index.js';
import {
  ADAPTER_CAPABILITIES,
  looksLikeSecretArg,
  redactSpawnArgToken,
  type OneshotSpec,
  type SessionSpec,
  type RuntimeProfileSpec,
} from './cli-adapters/base.js';
import { resolveBinOverride } from './cli-resolver.js';
import {
  resolveEffectivePermissionPolicy,
  type EffectivePermissionPolicy,
} from './permission-policy.js';
import type { ManagedAgentContext } from './managed-agent-context.js';

/** argv 토큰 하나의 출처. */
export type LaunchArgSource =
  /** 어댑터가 CLI 종류만 보고 항상 붙이는 기본 인자. */
  | 'adapter'
  /** 에이전트(또는 런타임 프로파일)의 모델 설정에서 나온 인자. */
  | 'model'
  /** trust(`runtime_config.permission_mode`) 또는 harness 로 정해진 권한 등급. */
  | 'permission'
  /** MCP 설정 파일 경로를 싣는 인자. */
  | 'mcp'
  /** 세션 식별자를 싣는 인자 (session 모드 전용). */
  | 'session'
  /** 런타임 프로파일이 descriptor 뒤에 덧붙인 인자. */
  | 'runtime_profile'
  /** 변형 비교로 출처를 가리지 못한 인자. 지어내는 대신 모른다고 말한다. */
  | 'unattributed';

export interface LaunchArgEntry {
  /** 마스킹된 표시용 토큰. 원문이 아니다. */
  value: string;
  source: LaunchArgSource;
  /** 실행 시점에만 정해지는 자리(프롬프트 본문, 세션 id 등)를 메운 값. */
  placeholder?: boolean;
}

/** spawn 경로 하나와 그 경로의 argv. */
export interface LaunchModeSpec {
  mode: 'session' | 'oneshot';
  args: LaunchArgEntry[];
}

export interface LaunchEnvEntry {
  key: string;
  /** 항상 마스킹된다. 값 자체는 절대 싣지 않는다. */
  value: string;
  source: 'cli_home' | 'credential' | 'runtime_profile';
}

export interface AgentLaunchSpecEntry {
  agent_id: string;
  cli: string;
  /** 해석된 실행 파일 절대경로. resolve 가 실패하면 null 이고 사유가 아래에. */
  bin: string | null;
  bin_error: string | null;
  /** 이 CLI 가 지원하는 spawn 경로들. **첫 항목이 기본 경로**다. */
  modes: LaunchModeSpec[];
  cwd: string | null;
  /** `cwd` 의 의미 (ticket 20fff298).
   *
   *  - `'exact'` — 이 경로에서 그대로 돈다. 런타임 프로파일이 `cwd` 를 고정한
   *    경우로, 프로파일 값이 다른 모든 것을 이긴다.
   *  - `'base'` — **기준** 경로다. 티켓 디스패치는 이 아래 티켓별 worktree
   *    (`<working_dir>/.awb/wt/<repo>/<ticket>`)에서 돌기 때문에 실제 프로세스
   *    cwd 는 매번 다르다. 이걸 구분하지 않고 "작업 폴더"라고만 쓰면 argv 옆에
   *    붙은 경로가 실제 프로세스 cwd 라고 읽히는데, 그건 틀린 정보다. */
  cwd_kind: 'exact' | 'base';
  mcp_config_path: string | null;
  /** 이 spawn 에 적용될 모델 id. 미설정이면 null(= CLI 자체 기본값). */
  model: string | null;
  permission: {
    tier: EffectivePermissionPolicy['tier'];
    source: EffectivePermissionPolicy['source'];
    harness_mode: string | null;
  };
  runtime_profile: {
    id: string;
    protocol: string;
    model: string | null;
    /** 이 프로파일이 descriptor 뒤에 덧붙이는 인자 개수. */
    arg_count: number;
  } | null;
  env: LaunchEnvEntry[];
  /** 디스패치 시점에만 정해져 이 사양에 반영되지 않은 입력들의 이름. */
  varies_per_dispatch: string[];
  /** 사양을 계산한 시각(ISO). */
  computed_at: string;
}

/** 실행 시점에만 정해지는 값을 대신하는 자리표시자. argv 에 그대로 실려
 *  나가므로 사람이 읽을 수 있어야 하고, 마스킹을 통과해야 한다. */
const PLACEHOLDERS = Object.freeze({
  rolePrompt: '<역할 프롬프트: 디스패치 시 생성>',
  taskText: '<작업 내용: 디스패치 시 생성>',
  sessionId: '<세션 id: spawn 시 생성>',
});
const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(Object.values(PLACEHOLDERS));

/** session 변형을 만들기 위한 sentinel. 어댑터가 이 값을 자기 형식(claude 는
 *  UUID)으로 정규화하므로 결과 토큰을 문자열로 예측하지 않고, `sessionId: null`
 *  변형과의 차집합으로 위치만 찾아낸다. */
const SESSION_ID_SENTINEL = 'awb-launch-spec-session-sentinel';

/** 디스패치 시점에만 정해지는 입력들. 이름만 보고하고 값은 지어내지 않는다. */
const PER_DISPATCH_INPUTS = Object.freeze([
  '보드·워크스페이스 harness (harness_config)',
  '티켓 effort preset',
  '티켓별 cli_runtime_profile',
  '프롬프트 본문 · task text',
  'spawn 마다 새로 만들어지는 MCP 설정 사본 경로',
  '티켓별 worktree 경로 (cwd 가 base 일 때 실제 프로세스 cwd)',
]);

/**
 * `full` 에는 있지만 `variant` 에는 없는 토큰의 위치를 고른다.
 *
 * 같은 빌더에 입력 하나만 빼서 돌린 결과이므로 두 배열은 그 입력이 만든
 * 토큰만큼만 차이 난다. 순서에 기대지 않도록 **다중집합 차집합**으로 센다 —
 * 어댑터가 인자 순서를 바꿔도 귀속이 깨지지 않고, 같은 토큰이 여러 번 나와도
 * (`--allowedTools` 두 번 등) 개수만큼만 귀속된다.
 */
function attributeBy(full: readonly string[], variant: readonly string[]): Set<number> {
  const remaining = new Map<string, number>();
  for (const token of variant) remaining.set(token, (remaining.get(token) ?? 0) + 1);
  const picked = new Set<number>();
  for (let i = 0; i < full.length; i++) {
    const left = remaining.get(full[i]) ?? 0;
    if (left > 0) remaining.set(full[i], left - 1);
    else picked.add(i);
  }
  return picked;
}

/**
 * 표시용 토큰으로 접는다.
 *
 * 기본은 spawn 로그와 **완전히 같은** 마스킹({@link redactSpawnArgToken})이다.
 * 다만 이 화면의 목적상 그대로 보여야 의미가 있는 값이 있다 — 모델 id,
 * cwd, MCP 설정 경로처럼 **매니저가 구조적으로 알고 있고 UI 가 이미 다른
 * 곳에서 보여주는** 값들이다. 이들은 "모양"이 아니라 **알려진 안전값과의
 * 완전 일치**로만 통과시킨다(`safeValues`). 사용자 자유 입력이 이 집합에
 * 들어올 수 없으므로 통과 경로가 마스킹의 우회로가 되지 않는다.
 *
 * secret 안전망은 그 앞에 둔다 — 안전값으로 등록된 값이라도 secret 모양이면
 * 가린다(working_dir 가 `/srv/api_key/...` 인 경우 등).
 */
function displayToken(arg: string, previous: string, safeValues: ReadonlySet<string>): string {
  if (looksLikeSecretArg(arg)) return redactSpawnArgToken(arg, previous);
  if (safeValues.has(arg)) return arg;
  return redactSpawnArgToken(arg, previous);
}

/** 순수한 **플래그 이름** 모양인가 — `--foo-bar` 처럼 값을 담을 자리가 없는 형태.
 *  `=` 가 붙은 결합형(`--foo=값`)은 값을 품으므로 제외한다. */
const BARE_FLAG_NAME = /^--[a-z0-9][a-z0-9-]*$/i;

/**
 * 런타임 프로파일이 덧붙인 인자의 표시 규칙.
 *
 * 공용 마스킹은 **기본 차단**이라 어댑터가 쓰지 않는 플래그(`--settings` 등)의
 * 이름까지 `<Nch>` 로 가린다. 프로파일 인자에서는 그 이름이 정확히 화면의
 * 존재 이유("이 프로파일이 뭘 덧붙였나")라서 그대로 가리면 섹션이 무의미해진다.
 *
 * 그래서 여기서만, **플래그 이름 모양**({@link BARE_FLAG_NAME})인 토큰을
 * 통과시킨다. 값을 담을 자리가 없는 형태이고 secret 안전망을 먼저 통과해야
 * 하므로 payload 가 실릴 수 없다. **값은 예외 없이 공용 규칙을 그대로 탄다** —
 * 프로파일 args 에 토큰을 박아 둔 설정이 이 경로로 새지 않는다.
 */
function displayProfileToken(arg: string, previous: string, safeValues: ReadonlySet<string>): string {
  if (looksLikeSecretArg(arg)) return redactSpawnArgToken(arg, previous);
  if (BARE_FLAG_NAME.test(arg)) return arg;
  return displayToken(arg, previous, safeValues);
}

/** env 값은 어떤 경우에도 원문을 싣지 않는다 — 키 이름과 존재만 보고한다. */
function maskEnvValue(value: string): string {
  if (!value) return "''";
  if (looksLikeSecretArg(value)) return '<redacted>';
  return `<${value.length}ch>`;
}

/**
 * 한 spawn 모드의 argv 를 출처 붙은 표시용 배열로 만든다.
 *
 * `variants` 는 [출처, 그 입력을 뺀(또는 바꾼) argv] 쌍이고, `bare` 는 에이전트별
 * 입력을 **전부** 뺀 argv 다 — 거기 남는 토큰은 정의상 어댑터 상수라 그대로
 * 보여도 안전하다.
 */
function renderModeArgs(opts: {
  full: string[];
  variants: Array<[LaunchArgSource, string[] | null]>;
  bare: string[] | null;
  profileArgs: string[];
  structuralSafe: Array<string | null | undefined>;
}): LaunchArgEntry[] {
  const { full, variants, bare, profileArgs, structuralSafe } = opts;

  const sources = new Array<LaunchArgSource>(full.length).fill('adapter');
  const assigned = new Array<boolean>(full.length).fill(false);
  for (const [source, variantArgs] of variants) {
    if (!variantArgs) continue;
    for (const i of attributeBy(full, variantArgs)) {
      if (assigned[i]) continue;
      assigned[i] = true;
      sources[i] = source;
    }
  }

  // 프로파일 인자는 spawn 사이트가 descriptor 뒤에 push 하므로(base-session-manager /
  // subagent-manager 의 `descriptor.args.push(...profile.args)`) 위치로 바로 귀속된다.
  const allArgs = [...full, ...profileArgs];
  const allSources: LaunchArgSource[] = [
    ...sources,
    ...profileArgs.map<LaunchArgSource>(() => 'runtime_profile'),
  ];

  // 표시해도 안전한 값 집합. 두 갈래로만 채운다 — 둘 다 "모양"이 아니라
  // **출처**로 판정하므로, 사용자 자유 입력이 여기 들어올 길이 없다.
  //  (1) 매니저가 구조적으로 알고 있고 UI 가 이미 다른 화면에서 보여주는 값.
  const safeValues = new Set<string>(
    structuralSafe.filter((v): v is string => typeof v === 'string' && v.length > 0),
  );
  //  (2) 어댑터 상수 — 에이전트별 입력을 전부 뺐는데도 남는 토큰은 정의상
  //      어댑터가 CLI 종류만 보고 넣은 값이다(`stream-json`, allowedTools 패턴
  //      등). 이런 값까지 `<Nch>` 로 가리면 화면의 존재 이유인 "실제로 뭐가
  //      붙었는지"가 안 보이는데, 통과 근거가 "이 값에는 에이전트 정보가 들어갈
  //      수 없다"는 구성적 사실이라 마스킹의 우회로가 되지 않는다.
  for (const token of bare ?? []) {
    if (!token || PLACEHOLDER_VALUES.has(token)) continue;
    safeValues.add(token);
  }

  return allArgs.map((arg, i) => {
    const source = allSources[i];
    // 세션 id 는 어댑터가 자기 형식으로 정규화해 넣으므로 sentinel 문자열이
    // 그대로 나오지 않는다. 값 자리(플래그 이름이 아닌 토큰)에 온 session 귀속
    // 토큰은 그 정규화 결과이므로, 가짜 UUID 를 보여 주는 대신 자리표시자로
    // 바꾼다 — 어느 어댑터에도 의존하지 않는 판정이다.
    if (source === 'session' && !BARE_FLAG_NAME.test(arg)) {
      return { value: PLACEHOLDERS.sessionId, source, placeholder: true };
    }
    if (PLACEHOLDER_VALUES.has(arg)) {
      return { value: arg, source, placeholder: true };
    }
    const render = source === 'runtime_profile' ? displayProfileToken : displayToken;
    return { value: render(arg, i > 0 ? allArgs[i - 1] : '', safeValues), source };
  });
}

export interface ComputeLaunchSpecDeps {
  /** `config.delegation` — CLI 별 오퍼레이터 바이너리 override 와 세션 정책. */
  delegation?: {
    claudeBin?: string | null;
    codexBin?: string | null;
    persistentTicketSessions?: boolean;
  } | null;
  /** 인스턴스 단위 `--runtime-profile` 오버라이드. 티켓별 프로파일이 오면
   *  디스패치 시점에 대체되므로 `varies_per_dispatch` 에도 적힌다. */
  runtimeProfileOverride?: RuntimeProfileSpec | null;
  /** 테스트 주입용 시계. */
  now?: () => Date;
}

/**
 * 관리 대상 에이전트 하나의 실효 실행 사양을 계산한다.
 *
 * 계약: **절대 throw 하지 않는다.** heartbeat provider 안에서 도는 코드이므로
 * 어댑터 하나가 터져도 나머지 에이전트의 사양과 heartbeat 자체를 막으면 안
 * 된다. 실패는 `bin_error` 로 표면화하고 계산 가능한 만큼만 보고한다.
 */
export function computeAgentLaunchSpec(
  ctx: ManagedAgentContext,
  deps: ComputeLaunchSpecDeps = {},
): AgentLaunchSpecEntry {
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const profile = ctx.cli === 'claude' ? (deps.runtimeProfileOverride ?? null) : null;
  const permission = resolveEffectivePermissionPolicy({
    trust: ctx.runtime_config?.permission_mode ?? null,
    // harness 는 디스패치 시점 입력이라 여기서는 비어 있다. 지어내지 않는다 —
    // 그래서 이 사양의 permission.source 는 'agent_trust' 아니면 'default' 다.
    harnessMode: null,
  });
  const model = profile?.model || ctx.model || null;

  const base: AgentLaunchSpecEntry = {
    agent_id: ctx.agent_id,
    cli: ctx.cli,
    bin: null,
    bin_error: null,
    modes: [],
    cwd: profile?.cwd || ctx.working_dir || null,
    cwd_kind: profile?.cwd ? 'exact' : 'base',
    mcp_config_path: ctx.mcp_config_path || null,
    model,
    permission: {
      tier: permission.tier,
      source: permission.source,
      harness_mode: permission.harnessMode,
    },
    runtime_profile: profile
      ? {
          id: profile.id,
          protocol: profile.protocol,
          model: profile.model || null,
          arg_count: profile.args?.length ?? 0,
        }
      : null,
    env: [],
    varies_per_dispatch: [...PER_DISPATCH_INPUTS],
    computed_at: now,
  };

  let adapter;
  try {
    adapter = createAdapter(ctx.cli);
  } catch (err: any) {
    base.bin_error = `어댑터를 만들 수 없음: ${err?.message ?? err}`;
    return base;
  }

  // 실행 파일 해석 — spawn 사이트와 같은 override 우선순위를 쓴다. runtime
  // lease 의 claudeExecutable() 은 lease 를 잡은 뒤에만 존재하므로 여기서는
  // 프로파일이 선언한 claude_executable 이 그 자리를 대신한다.
  try {
    const override = resolveBinOverride(ctx.cli, deps.delegation ?? null, profile?.claude_executable ?? null);
    base.bin = adapter.resolveBin(override);
  } catch (err: any) {
    base.bin_error = String(err?.message ?? err);
  }

  const profileArgs = (profile?.args ?? []).map((a) => String(a ?? ''));
  const structuralSafe = [model, base.cwd, base.mcp_config_path, ctx.cli_home_dir];
  // 권한은 "빼는" 변형이 성립하지 않는다 — null 을 넘기면 어댑터가 기본
  // 등급(trusted)으로 폴백해 결국 어떤 권한 플래그든 다시 붙기 때문이다.
  // 대신 **다른 등급**으로 지어 비교하면 등급에 따라 달라지는 토큰만 정확히
  // 남는다. 두 등급 모두 아무 플래그도 안 내는 어댑터라면 차집합이 비고,
  // 그건 "이 CLI 에서 권한은 인자로 표현되지 않는다"는 올바른 답이다.
  const otherTier = permission.tier === 'trusted' ? ('strict' as const) : ('trusted' as const);

  const commonSpec = {
    rolePrompt: PLACEHOLDERS.rolePrompt,
    mcpConfigPath: ctx.mcp_config_path || null,
    model,
    harness: null,
    effort: null,
    permission,
  };

  // ── session 모드 (기본 경로) ────────────────────────────────────────────
  // `persistentTicketSessions` 기본값이 true 라 claude 계열은 이쪽으로 뜬다.
  // 오퍼레이터가 껐거나 어댑터가 persistent session 을 지원하지 않으면 생략한다.
  const sessionEnabled =
    deps.delegation?.persistentTicketSessions !== false
    && adapter.has(ADAPTER_CAPABILITIES.PERSISTENT_SESSION);
  if (sessionEnabled) {
    const sessionSpecOf = (over: Partial<SessionSpec>): SessionSpec => ({
      ...commonSpec,
      sessionMode: 'persistent',
      sessionId: SESSION_ID_SENTINEL,
      ...over,
    });
    const buildSession = (over: Partial<SessionSpec>): string[] | null => {
      try {
        return [...adapter.buildSessionSpawn(sessionSpecOf(over)).args].map((a) => String(a ?? ''));
      } catch {
        return null;
      }
    };
    const full = buildSession({});
    if (full) {
      base.modes.push({
        mode: 'session',
        args: renderModeArgs({
          full,
          variants: [
            ['permission', buildSession({ permission: { ...permission, tier: otherTier } })],
            ['model', buildSession({ model: null })],
            ['mcp', buildSession({ mcpConfigPath: null })],
            ['session', buildSession({ sessionId: undefined })],
          ],
          bare: buildSession({ model: null, mcpConfigPath: null, sessionId: undefined }),
          profileArgs,
          structuralSafe,
        }),
      });
    }
  }

  // ── oneshot 모드 ────────────────────────────────────────────────────────
  const oneshotSpecOf = (over: Partial<OneshotSpec>): OneshotSpec => ({
    ...commonSpec,
    taskText: PLACEHOLDERS.taskText,
    cwd: base.cwd,
    cliHomeDir: ctx.cli_home_dir || null,
    ...over,
  });
  const buildOneshot = (over: Partial<OneshotSpec>): string[] | null => {
    try {
      return [...adapter.buildOneshotSpawn(oneshotSpecOf(over)).args].map((a) => String(a ?? ''));
    } catch {
      return null;
    }
  };
  const oneshotFull = buildOneshot({});
  if (oneshotFull) {
    base.modes.push({
      mode: 'oneshot',
      args: renderModeArgs({
        full: oneshotFull,
        variants: [
          ['permission', buildOneshot({ permission: { ...permission, tier: otherTier } })],
          ['model', buildOneshot({ model: null })],
          ['mcp', buildOneshot({ mcpConfigPath: null })],
        ],
        bare: buildOneshot({ model: null, mcpConfigPath: null, cwd: null, cliHomeDir: null }),
        profileArgs,
        structuralSafe,
      }),
    });
  }

  if (base.modes.length === 0 && !base.bin_error) {
    base.bin_error = '이 CLI 어댑터에서 실행 인자를 계산할 수 없습니다.';
  }

  const env: LaunchEnvEntry[] = [];
  const cliHomeEnvKey = adapter.configDirEnv();
  if (cliHomeEnvKey && ctx.cli_home_dir) {
    // cli-home 경로는 비밀이 아니고 UI 가 이미 다른 곳에서 보여주므로 값을 남긴다.
    env.push({ key: cliHomeEnvKey, value: ctx.cli_home_dir, source: 'cli_home' });
  }
  for (const key of Object.keys(ctx.extra_env ?? {}).sort()) {
    env.push({ key, value: maskEnvValue(String(ctx.extra_env?.[key] ?? '')), source: 'credential' });
  }
  for (const key of Object.keys(profile?.env ?? {}).sort()) {
    env.push({ key, value: maskEnvValue(String(profile?.env?.[key] ?? '')), source: 'runtime_profile' });
  }
  base.env = env;

  return base;
}

/**
 * heartbeat 의 `agent_launch_specs` 필드를 만든다. 에이전트 하나가 터져도
 * 나머지는 보고되도록 개별적으로 감싼다.
 */
export function computeAgentLaunchSpecs(
  contexts: readonly ManagedAgentContext[],
  deps: ComputeLaunchSpecDeps = {},
): AgentLaunchSpecEntry[] {
  const out: AgentLaunchSpecEntry[] = [];
  for (const ctx of contexts) {
    if (!ctx?.agent_id) continue;
    try {
      out.push(computeAgentLaunchSpec(ctx, deps));
    } catch {
      // computeAgentLaunchSpec 자체가 throw 하지 않기로 되어 있지만, 그
      // 계약이 깨져도 heartbeat 은 계속 나가야 한다.
    }
  }
  return out;
}
