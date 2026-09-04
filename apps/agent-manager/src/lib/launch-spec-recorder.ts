/**
 * 실제 spawn 된 실행 사양의 기록 — ticket 20fff298 (리뷰 2R·3R).
 *
 * ## 왜 계산된 projection 만으로는 부족한가
 *
 * `launch-spec.ts` 는 heartbeat 시점에 알 수 있는 것만으로 "다음 spawn 사양"을
 * **추정**한다. 그런데 디스패치 시점 입력(보드/워크스페이스 harness, 티켓 effort
 * preset, 티켓별 `cli_runtime_profile`)은 권한 플래그·모델·프로파일 args/env/cwd
 * 를 **덮을 수 있다**. 그래서 추정값만 보여 주면 화면의 명령이 바로 다음 실행과
 * 다를 수 있고, `varies_per_dispatch` 문구는 그 차이를 고지할 뿐 없애지 못한다.
 *
 * 이 모듈은 그 공백을 **ground truth** 로 메운다: 실제 spawn 사이트가 argv·env·
 * cwd 를 최종 확정한 직후, 그 값을 마스킹해 에이전트별로 기록한다. heartbeat 이
 * 이를 함께 보고하므로 화면은 "추정"과 "마지막 실제 실행"을 나란히 보여 줄 수
 * 있고, 운영자는 per-dispatch 입력이 실제로 무엇을 바꿨는지 확인할 수 있다.
 *
 * ## 기록에도 인자별 출처가 붙는다 (리뷰 3R)
 *
 * 기록이 "실제 argv" 이기만 하고 출처가 전부 `unattributed` 였을 때, 출처가 있는
 * 쪽은 디스패치 입력을 반영하지 못하는 추정뿐이었다 — 요구사항의 "실효 실행 인자
 * 전체 + 인자별 출처"가 두 블록에 반쪽씩 나뉘어 어느 쪽도 충족하지 못한 상태였다.
 *
 * 그래서 spawn 사이트가 **최종 descriptor 를 만든 그 spec 과 빌더**를 함께 넘기고
 * ({@link LaunchAttributionInput}), 여기서 그 실제 입력으로 변형(variant)을 다시
 * 만들어 추정과 **동일한 차집합 규칙**으로 귀속한다. 추정과 달리 입력이 실제값
 * 이므로 harness·effort 처럼 디스패치 시점에만 정해지는 것까지 귀속된다.
 *
 * 재빌드 결과가 기록된 argv 와 **한 토큰이라도 다르면 귀속을 포기**한다
 * ({@link attributeRecordedArgs}). 실제와 다른 argv 에 출처를 붙이는 것은 이
 * 티켓이 고치려는 오표시 그 자체이므로, 그 경우엔 출처 없이 실제 argv 만 남긴다.
 *
 * ## 핫 패스 규칙
 *
 * 이 기록은 **가시성 용도**이므로 spawn 의 정확성보다 절대 앞설 수 없다:
 *   - 호출은 자식이 이미 떠서 pid 가 확인된 **뒤**에 한다 (양쪽 spawn 사이트 모두).
 *   - 절대 throw 하지 않는다(호출부에서 한 번 더 감싸도 무해하다).
 *   - 동기·상수 시간. spawn 전에 어떤 await 도 추가하지 않는다. 귀속용 재빌드는
 *     어댑터의 순수 함수 몇 번 호출이고, pid 확인 뒤에 돈다.
 */

import { redactSpawnArgToken } from './cli-adapters/base.js';
import {
  maskEnvValue,
  renderModeArgs,
  type LaunchArgEntry,
  type LaunchArgSource,
  type LaunchEnvEntry,
} from './launch-spec-render.js';

/** 실제로 spawn 된 한 번의 실행 사양 (마스킹 완료). */
export interface RecordedLaunchSpec {
  /** 어느 spawn 경로였나 — projection 의 `modes[].mode` 와 같은 축. */
  mode: 'session' | 'oneshot';
  /** 해석된 실행 파일. */
  bin: string | null;
  /** 실제 argv (마스킹됨, 순서 보존, 인자별 출처 포함). */
  args: LaunchArgEntry[];
  /** 인자별 출처를 붙일 수 있었나. false 면 모든 항목이 `unattributed` 다 —
   *  "귀속을 못 했다"와 "귀속했더니 출처 불명이었다"를 UI 가 구분해야 한다. */
  args_attributed: boolean;
  /** 실제 프로세스 cwd — 추정이 아니라 crossSpawn 에 넘어간 값 그대로. */
  cwd: string | null;
  /** 실제 주입된 env (키 + 마스킹된 값). */
  env: LaunchEnvEntry[];
  /** 이 실행을 만든 디스패치 문맥 — 추정값이 왜 달랐는지의 근거다. */
  context: {
    ticket_id: string | null;
    role: string | null;
    /** 보드/워크스페이스 harness 가 적용됐나 (적용된 키 이름). */
    harness_keys: string[];
    /** 티켓 effort preset 이 만든 최종 effort 값. */
    effort: string | null;
    /** 이 실행에 적용된 런타임 프로파일 id. */
    runtime_profile_id: string | null;
  };
  recorded_at: string;
}

/** 에이전트별 **마지막** 실행만 유지한다. 이력을 쌓지 않는 이유: 화면이 묻는
 *  것은 "직전에 실제로 뭐가 붙었나" 하나이고, 무한히 쌓으면 매니저 메모리가
 *  프롬프트 길이에 비례해 자란다. */
const lastByAgent = new Map<string, RecordedLaunchSpec>();

/** argv 토큰 수 상한. 비정상적으로 긴 argv 가 매니저 메모리를 잡지 않게 한다. */
const MAX_RECORDED_ARGS = 200;
const MAX_RECORDED_ENV = 100;

/** 실제 주입 env 중 **매니저가 덧붙인 것만** 고른다.
 *
 *  `process.env` 를 통째로 상속한 baseEnv 까지 보고하면 운영자 셸의 무관한
 *  변수 수백 개가 화면을 덮고, 그중 일부는 이 에이전트와 무관한 비밀값이다.
 *  spawn 사이트가 baseEnv 위에 올린 키만 diff 로 골라 보고한다. */
function addedEnvEntries(
  finalEnv: EnvBag | undefined,
  baseEnv: EnvBag | undefined,
): LaunchEnvEntry[] {
  const out: LaunchEnvEntry[] = [];
  if (!finalEnv) return out;
  const base: EnvBag = baseEnv ?? {};
  for (const key of Object.keys(finalEnv).sort()) {
    const value = finalEnv[key];
    if (value === undefined) continue;
    // baseEnv 와 값이 같으면 상속분이므로 뺀다. 값이 다르면 매니저가 덮은 것.
    if (base[key] === value) continue;
    out.push({ key, value: maskEnvValue(String(value)), source: 'credential' });
    if (out.length >= MAX_RECORDED_ENV) break;
  }
  return out;
}

/** spawn 사이트가 실제로 넘기는 env 모양. `NodeJS.ProcessEnv` 와
 *  `Record<string, string｜undefined>` 를 모두 받는다 — 기록은 가시성 sink 이므로
 *  호출부가 가진 형태를 그대로 수용해야 한다(호출부에서 캐스팅하게 만들면
 *  spawn 에 넘긴 값과 다른 것을 기록할 여지가 생긴다). */
type EnvBag = Record<string, string | undefined>;

/** 어댑터 빌더에 넘어가는 spec. 키 집합이 모드(oneshot/session)마다 다르고
 *  어댑터별 확장 필드도 있어 구조를 여기서 다시 선언하지 않는다 — 이 모듈은
 *  spec 을 **해석하지 않고** 얕게 덮어 빌더에 되돌려 주기만 한다. */
type BuilderSpec = Record<string, unknown>;

/**
 * 최종 descriptor 를 만든 입력 — 실제 argv 에 출처를 붙이기 위한 재료.
 *
 * spawn 사이트만이 이걸 알고 있으므로 여기서 재구성하지 않는다. 재구성했다면
 * 이 티켓이 처음에 만들어 낸 오표시("실행되지 않는 명령을 실행 명령이라고
 * 보여 주는 것")를 귀속 단계에서 다시 만드는 셈이다.
 */
export interface LaunchAttributionInput {
  /** 실제 descriptor 를 만든 spec **그대로**. 변형은 이 객체를 얕게 덮어 만든다. */
  spec: BuilderSpec;
  /** 그 spec 으로 argv 를 만드는 함수 — **실제 어댑터 빌더**여야 한다.
   *  throw 하면 그 변형만 버려지고 나머지 귀속은 계속된다. */
  build: (spec: BuilderSpec) => readonly string[] | null | undefined;
  /** 런타임 프로파일이 descriptor **뒤에** push 한 인자. 위치로 귀속된다. */
  profileArgs?: readonly string[];
  /** 표시해도 안전한 구조적 값(cli-home 경로 등). `spec` 에서 읽을 수 있는
   *  model·MCP 경로·세션 id 는 여기 적지 않아도 자동으로 포함된다. */
  safeValues?: Array<string | null | undefined>;
}

export interface RecordLaunchInput {
  agentId: string | null | undefined;
  mode: 'session' | 'oneshot';
  bin: string | null | undefined;
  /** crossSpawn 에 넘긴 argv 그대로. */
  args: readonly string[];
  /** crossSpawn 에 넘긴 cwd 그대로. */
  cwd: string | null | undefined;
  /** crossSpawn 에 넘긴 최종 env. */
  env: EnvBag | undefined;
  /** 그 env 의 상속 베이스(`{...process.env}` 에서 auth strip 된 것). */
  baseEnv: EnvBag | undefined;
  /** 인자별 출처 귀속용 입력. 없으면 argv 는 기록되지만 출처는 전부
   *  `unattributed` 가 된다(지어내지 않는다). */
  attribution?: LaunchAttributionInput | null;
  ticketId?: string | null;
  role?: string | null;
  /** 적용된 harness 객체 — **키 이름만** 기록한다. 값은 프롬프트 본문과 도구
   *  목록을 품으므로 절대 싣지 않는다. 구체 타입 대신 `object` 로 받는 이유는
   *  HarnessSpec 이 index signature 를 갖지 않아서다. */
  harness?: object | null;
  effort?: string | null;
  runtimeProfileId?: string | null;
  now?: () => Date;
}

/** 실제 spawn 기록에서 값 자리를 자리표시자로 접을 출처.
 *
 *  추정과 달리 세션 id·MCP 경로는 **이미 확정된 값**이라 접으면 정보를 잃는다
 *  (그 파일을 열어 보는 것이 운영자가 이 화면에서 하려는 일이다). `prompt` 는
 *  `renderModeArgs` 가 이 집합과 무관하게 항상 접는다. */
const RECORDED_PLACEHOLDER_SOURCES: ReadonlySet<LaunchArgSource> = new Set<LaunchArgSource>();

/**
 * 귀속에 쓰는 변형 목록.
 *
 * **앞선 항목이 이긴다** — `renderModeArgs` 가 먼저 귀속된 위치를 덮지 않는다.
 * 그래서 순서 자체가 판정 규칙이다:
 *   - `prompt` 를 맨 앞에 두어 프롬프트 본문이 실린 토큰이 다른 출처로 새지 않게
 *     한다(harness 도 system prompt 를 바꾸므로 뒤에 두면 본문이 harness 로 잡힌다).
 *   - 그다음 추정과 **같은 순서**(permission → model → mcp → session)를 유지해
 *     두 블록의 귀속이 같은 규칙으로 읽히게 한다.
 *   - harness·effort 는 추정에 존재할 수 없는 디스패치 입력이라 마지막에 붙는다.
 */
function buildVariants(
  att: LaunchAttributionInput,
  build: (over: BuilderSpec) => string[] | null,
): Array<[LaunchArgSource, string[] | null]> {
  const permission = att.spec.permission as { tier?: string } | null | undefined;
  // 권한은 "빼는" 변형이 성립하지 않는다(null 이면 어댑터가 기본 등급으로 폴백).
  // 추정과 같은 방식으로 **다른 등급**을 지어 비교한다 — launch-spec.ts 주석 참조.
  const otherTier = permission?.tier === 'trusted' ? 'strict' : 'trusted';
  return [
    ['prompt', build({ rolePrompt: '', taskText: '' })],
    ['permission', permission ? build({ permission: { ...permission, tier: otherTier } }) : null],
    ['model', build({ model: null })],
    ['mcp', build({ mcpConfigPath: null })],
    ['session', build({ sessionId: undefined })],
    ['harness', build({ harness: null })],
    ['effort', build({ effort: null, ultracode: false })],
  ];
}

/** 에이전트별 입력을 **전부** 뺀 변형. 여기 남는 토큰은 정의상 어댑터 상수라
 *  표시해도 안전하다(`renderModeArgs` 의 safeValues 갈래 2). */
const BARE_OVERRIDES: BuilderSpec = Object.freeze({
  rolePrompt: '',
  taskText: '',
  model: null,
  mcpConfigPath: null,
  sessionId: undefined,
  harness: null,
  effort: null,
  ultracode: false,
  cwd: null,
  cliHomeDir: null,
});

/**
 * 실제 argv 에 인자별 출처를 붙인다. 붙일 수 없으면 null.
 *
 * 재빌드가 기록된 argv 를 **정확히** 재현하는지 먼저 확인한다. 재현하지 못하면
 * (빌더가 비결정적이거나 spawn 사이트가 argv 를 더 변형했거나 spec 이 실제와
 * 다르면) 귀속을 포기한다 — 실제와 다른 argv 에 출처를 붙이면 그게 오표시다.
 */
function attributeRecordedArgs(
  actual: readonly string[],
  att: LaunchAttributionInput,
): LaunchArgEntry[] | null {
  const build = (over: BuilderSpec): string[] | null => {
    try {
      const args = att.build({ ...att.spec, ...over });
      return args ? [...args].map((a) => String(a ?? '')) : null;
    } catch {
      return null;
    }
  };
  const full = build({});
  if (!full) return null;
  const profileArgs = [...(att.profileArgs ?? [])].map((a) => String(a ?? ''));
  const rebuilt = [...full, ...profileArgs];
  if (rebuilt.length !== actual.length) return null;
  for (let i = 0; i < rebuilt.length; i++) {
    if (rebuilt[i] !== String(actual[i] ?? '')) return null;
  }
  return renderModeArgs({
    full,
    variants: buildVariants(att, build),
    bare: build(BARE_OVERRIDES),
    profileArgs,
    // spec 이 들고 있는 구조적 값들 — 매니저가 스스로 만든 값이고 UI 가 이미
    // 다른 행에서 보여준다. 자유 입력이 아니므로 마스킹 우회로가 되지 않는다.
    structuralSafe: [
      typeof att.spec.model === 'string' ? att.spec.model : null,
      typeof att.spec.mcpConfigPath === 'string' ? att.spec.mcpConfigPath : null,
      typeof att.spec.cwd === 'string' ? att.spec.cwd : null,
      typeof att.spec.cliHomeDir === 'string' ? att.spec.cliHomeDir : null,
      ...(att.safeValues ?? []),
    ],
    placeholderSources: RECORDED_PLACEHOLDER_SOURCES,
  });
}

/** 귀속 없이 argv 만 남기는 경로. 출처를 지어내지 않고 모른다고 말한다. */
function unattributedArgs(args: readonly string[]): LaunchArgEntry[] {
  return args.slice(0, MAX_RECORDED_ARGS).map((raw, i, list) => ({
    value: redactSpawnArgToken(String(raw ?? ''), String(list[i - 1] ?? '')),
    source: 'unattributed' as const,
  }));
}

/**
 * 실제 spawn 된 사양을 기록한다. **절대 throw 하지 않는다.**
 */
export function recordActualLaunch(input: RecordLaunchInput): void {
  try {
    if (!input.agentId) return;
    const attributed = input.attribution
      ? attributeRecordedArgs(input.args, input.attribution)
      : null;
    const args = (attributed ?? unattributedArgs(input.args)).slice(0, MAX_RECORDED_ARGS);
    lastByAgent.set(input.agentId, {
      mode: input.mode,
      bin: input.bin ?? null,
      args,
      args_attributed: attributed !== null,
      cwd: input.cwd ?? null,
      env: addedEnvEntries(input.env, input.baseEnv),
      context: {
        ticket_id: input.ticketId || null,
        role: input.role || null,
        harness_keys: input.harness ? Object.keys(input.harness).sort() : [],
        effort: input.effort || null,
        runtime_profile_id: input.runtimeProfileId || null,
      },
      recorded_at: (input.now ?? (() => new Date()))().toISOString(),
    });
  } catch {
    // 가시성 기록이 spawn 경로를 절대 깨뜨리지 않는다.
  }
}

/** 이 에이전트의 마지막 실제 실행. 없으면 null. */
export function lastActualLaunch(agentId: string): RecordedLaunchSpec | null {
  return lastByAgent.get(agentId) ?? null;
}

/** 테스트 전용 — 기록을 비운다. */
export function _resetRecordedLaunches(): void {
  lastByAgent.clear();
}
