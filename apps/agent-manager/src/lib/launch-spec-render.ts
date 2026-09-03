/**
 * 실행 사양의 **출처 귀속 + 표시용 렌더** — ticket 20fff298.
 *
 * 두 소비자가 같은 규칙을 써야 하므로 별도 모듈로 둔다:
 *   - `launch-spec.ts` — heartbeat 시점의 **추정**(다음 spawn 예상 argv).
 *   - `launch-spec-recorder.ts` — spawn 사이트가 확정한 **실제** argv
 *     (ticket 20fff298 리뷰 3R). 실제 argv 에 출처가 없으면 요구사항의
 *     "실효 실행 인자 전체 + 인자별 출처" 가 반쪽만 충족된다.
 *
 * 이 두 곳이 각자 렌더/마스킹/귀속을 구현하면 화면의 두 블록이 같은 토큰을
 * 서로 다르게 접어 보여주게 되고, 마스킹 규칙도 갈라진다 — 그래서 한 곳에 둔다.
 */

import { looksLikeSecretArg, redactSpawnArgToken } from './cli-adapters/base.js';


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
  /** 보드·워크스페이스 harness(`harness_config`)가 만든 인자.
   *  **디스패치 시점 입력**이라 heartbeat 추정에는 나타날 수 없고, 실제 spawn
   *  기록에서만 귀속된다(ticket 20fff298 리뷰 3R). */
  | 'harness'
  /** 티켓 effort preset 이 만든 인자. harness 와 같은 이유로 기록 전용이다. */
  | 'effort'
  /** 프롬프트 본문·task text 를 싣는 인자. 값은 **언제나** 자리표시자로 접힌다 —
   *  프롬프트 전문은 어떤 경로로도 화면에 오르지 않는다. */
  | 'prompt'
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
  /** 이 경로에서만 성립하는 단서. argv 만으로는 드러나지 않는 조건부 동작
   *  (예: 역할 고정 여부에 따라 MCP 설정 출처가 갈리는 것)을 적는다. */
  notes: string[];
}

export interface LaunchEnvEntry {
  key: string;
  /** 항상 마스킹된다. 값 자체는 절대 싣지 않는다. */
  value: string;
  source: 'cli_home' | 'credential' | 'runtime_profile';
}


/** 실행 시점에만 정해지는 값을 대신하는 자리표시자. argv 에 그대로 실려
 *  나가므로 사람이 읽을 수 있어야 하고, 마스킹을 통과해야 한다. */
export const PLACEHOLDERS = Object.freeze({
  rolePrompt: '<역할 프롬프트: 디스패치 시 생성>',
  taskText: '<작업 내용: 디스패치 시 생성>',
  sessionId: '<세션 id: spawn 시 생성>',
  mcpConfig: '<MCP 설정: spawn 시 생성>',
  /** 실제 spawn 기록에서 프롬프트 본문이 실려 있던 자리. 추정과 달리 기록에는
   *  **진짜 프롬프트**가 들어 있으므로, 값을 마스킹에 맡기지 않고 출처 판정으로
   *  무조건 이 문자열로 바꾼다(`<Nch>` 로 길이를 흘리는 것도 피한다). */
  promptBody: '<프롬프트 본문: 표시하지 않음>',
});
export const PLACEHOLDER_VALUES: ReadonlySet<string> = new Set(Object.values(PLACEHOLDERS));


/**
 * `full` 에는 있지만 `variant` 에는 없는 토큰의 위치를 고른다.
 *
 * 같은 빌더에 입력 하나만 빼서 돌린 결과이므로 두 배열은 그 입력이 만든
 * 토큰만큼만 차이 난다. 순서에 기대지 않도록 **다중집합 차집합**으로 센다 —
 * 어댑터가 인자 순서를 바꿔도 귀속이 깨지지 않고, 같은 토큰이 여러 번 나와도
 * (`--allowedTools` 두 번 등) 개수만큼만 귀속된다.
 */
export function attributeBy(full: readonly string[], variant: readonly string[]): Set<number> {
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
export function displayToken(arg: string, previous: string, safeValues: ReadonlySet<string>): string {
  if (looksLikeSecretArg(arg)) return redactSpawnArgToken(arg, previous);
  if (safeValues.has(arg)) return arg;
  return redactSpawnArgToken(arg, previous);
}

/** 순수한 **플래그 이름** 모양인가 — `--foo-bar` 처럼 값을 담을 자리가 없는 형태.
 *  `=` 가 붙은 결합형(`--foo=값`)은 값을 품으므로 제외한다. */
export const BARE_FLAG_NAME = /^--[a-z0-9][a-z0-9-]*$/i;

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
export function displayProfileToken(arg: string, previous: string, safeValues: ReadonlySet<string>): string {
  if (looksLikeSecretArg(arg)) return redactSpawnArgToken(arg, previous);
  if (BARE_FLAG_NAME.test(arg)) return arg;
  return displayToken(arg, previous, safeValues);
}

/** env 값은 어떤 경우에도 원문을 싣지 않는다 — 키 이름과 존재만 보고한다. */
export function maskEnvValue(value: string): string {
  if (!value) return "''";
  if (looksLikeSecretArg(value)) return '<redacted>';
  return `<${value.length}ch>`;
}

/** 출처 → 그 출처의 값 자리에 들어갈 자리표시자. 여기 없는 출처는 값을 그대로
 *  (마스킹 규칙을 거쳐) 보여준다. */
const PLACEHOLDER_FOR: Partial<Record<LaunchArgSource, string>> = {
  session: PLACEHOLDERS.sessionId,
  mcp: PLACEHOLDERS.mcpConfig,
  prompt: PLACEHOLDERS.promptBody,
};

/** 추정(`launch-spec.ts`)의 기본값 — 세션 id 와 MCP 경로는 아직 존재하지 않는다. */
const DEFAULT_PLACEHOLDER_SOURCES: ReadonlySet<LaunchArgSource> = new Set<LaunchArgSource>([
  'session',
  'mcp',
]);

/**
 * 한 spawn 모드의 argv 를 출처 붙은 표시용 배열로 만든다.
 *
 * `variants` 는 [출처, 그 입력을 뺀(또는 바꾼) argv] 쌍이고, `bare` 는 에이전트별
 * 입력을 **전부** 뺀 argv 다 — 거기 남는 토큰은 정의상 어댑터 상수라 그대로
 * 보여도 안전하다.
 */
export function renderModeArgs(opts: {
  full: string[];
  variants: Array<[LaunchArgSource, string[] | null]>;
  bare: string[] | null;
  profileArgs: string[];
  structuralSafe: Array<string | null | undefined>;
  /** 값 자리를 자리표시자로 바꿀 출처. **추정**에서는 세션 id·MCP 경로가 아직
   *  존재하지 않으므로 둘 다 접지만, 실제 spawn **기록**에서는 그 값이 이미
   *  확정된 ground truth 라 접으면 오히려 정보를 잃는다. `prompt` 는 이 옵션과
   *  무관하게 항상 접힌다. */
  placeholderSources?: ReadonlySet<LaunchArgSource>;
}): LaunchArgEntry[] {
  const { full, variants, bare, profileArgs, structuralSafe } = opts;
  const placeholderSources = opts.placeholderSources ?? DEFAULT_PLACEHOLDER_SOURCES;

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
    // 값 자리(플래그 이름이 아닌 토큰)를 자리표시자로 바꾼다.
    //
    //   - `prompt` — 항상. 기록에는 진짜 프롬프트 본문이 들어 있다.
    //   - `session` / `mcp` — 추정에서만. 세션 id 는 어댑터가 자기 형식으로
    //     정규화해 넣으므로 sentinel 이 그대로 나오지 않고, MCP 파일은 어느
    //     spawn 경로든 spawn 시점에 만들어진다(commonSpec 주석 참조). 가짜
    //     UUID·정적 경로를 실효값처럼 보여 주지 않기 위한 치환이다. 실제 기록
    //     에서는 둘 다 확정값이라 그대로 남긴다.
    const placeholder = source === 'prompt' || placeholderSources.has(source)
      ? PLACEHOLDER_FOR[source]
      : undefined;
    if (placeholder && !BARE_FLAG_NAME.test(arg)) {
      return { value: placeholder, source, placeholder: true };
    }
    if (PLACEHOLDER_VALUES.has(arg)) {
      return { value: arg, source, placeholder: true };
    }
    const render = source === 'runtime_profile' ? displayProfileToken : displayToken;
    return { value: render(arg, i > 0 ? allArgs[i - 1] : '', safeValues), source };
  });
}
