/**
 * 실제 spawn 된 실행 사양의 기록 — ticket 20fff298 (리뷰 2R).
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
 * ## 핫 패스 규칙
 *
 * 이 기록은 **가시성 용도**이므로 spawn 의 정확성보다 절대 앞설 수 없다:
 *   - 호출은 자식이 이미 떠서 pid 가 확인된 **뒤**에 한다.
 *   - 절대 throw 하지 않는다(호출부에서 한 번 더 감싸도 무해하다).
 *   - 동기·상수 시간. spawn 전에 어떤 await 도 추가하지 않는다.
 */

import { redactSpawnArgToken, looksLikeSecretArg } from './cli-adapters/base.js';
import type { LaunchArgEntry, LaunchEnvEntry } from './launch-spec.js';

/** 실제로 spawn 된 한 번의 실행 사양 (마스킹 완료). */
export interface RecordedLaunchSpec {
  /** 어느 spawn 경로였나 — projection 의 `modes[].mode` 와 같은 축. */
  mode: 'session' | 'oneshot';
  /** 해석된 실행 파일. */
  bin: string | null;
  /** 실제 argv (마스킹됨, 순서 보존). */
  args: LaunchArgEntry[];
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

/** env 값은 어떤 경우에도 원문을 싣지 않는다 — launch-spec.ts 와 같은 규칙. */
function maskEnvValue(value: string): string {
  if (!value) return "''";
  if (looksLikeSecretArg(value)) return '<redacted>';
  return `<${value.length}ch>`;
}

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

/**
 * 실제 spawn 된 사양을 기록한다. **절대 throw 하지 않는다.**
 */
export function recordActualLaunch(input: RecordLaunchInput): void {
  try {
    if (!input.agentId) return;
    const args = input.args.slice(0, MAX_RECORDED_ARGS).map((raw, i, list) => {
      const token = String(raw ?? '');
      // 기록에는 per-token 출처 귀속을 붙이지 않는다 — 귀속은 변형 빌드가
      // 필요해 핫 패스에서 할 일이 아니고, 이 블록의 목적은 "실제로 무엇이
      // 붙었나" 자체다. 출처는 projection 쪽이 제공한다.
      return {
        value: redactSpawnArgToken(token, String(list[i - 1] ?? '')),
        source: 'unattributed' as const,
      };
    });
    lastByAgent.set(input.agentId, {
      mode: input.mode,
      bin: input.bin ?? null,
      args,
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
