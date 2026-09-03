import { z } from 'zod';

/**
 * 랜딩 lease(merge lease) 보드별 설정 (ticket e630b530).
 *
 * `common/merge-gate-config.ts` 와 같은 모양(zod 스키마 + parse/validate/
 * serialize)이라 보드의 `merge_lease_config` 텍스트 컬럼이 `merge_gate_config`
 * / `harness_config` 와 정확히 같은 방식으로 읽히고 쓰인다.
 *
 * 의미 — Merging 단계의 "CI 검증 시작 → 랜딩" 구간을 저장소별로 직렬화한다.
 * 최신 base 위로 rebase 한 SHA 의 초록 CI 를 요구하는데 CI 가 도는 ~9분 동안
 * base 가 다시 전진하면 rebase 로 SHA 가 바뀌어 같은 변경을 다시 검증해야 한다
 * (원본 사례: 내용 변경 없이 CI 3회). 홀더가 그 구간을 독점하면 base 가 그동안
 * 전진하지 않으므로 재검증 루프가 유한하게 끝난다.
 *
 * ── merge_gate_config 와 기본값이 반대인 이유 ──────────────────────────────
 * merge-gate 는 "보드 opt-in · 기본 OFF" 로 출시된 뒤 이 인스턴스의 16개 보드
 * 전부에서 한 번도 켜지지 않았다(`merge_gate_config` 전부 null). 같은 기본값을
 * 쓰면 이 기능도 "출시했으나 아무 데서도 동작하지 않음" 이 된다. 그래서 여기서는
 * **기본 ON** 이고, 안전성은 기본값이 아니라 **fail-open** 이 담보한다:
 *
 *   lease 획득은 어떤 경우에도 하드 블록하지 않는다.
 *
 * 저장소 미해석 / 서비스 오류 / 대기 상한 초과 → degraded 로 기록하고 **lease
 * 없이 그대로 진행**한다. 그래서 최악의 버그가 "오늘 동작으로 회귀" 이지
 * "보드 전역 랜딩 교착" 이 아니다. AWB 는 자기 자신을 이 저장소로 배포하므로
 * 랜딩 교착은 *그 교착을 고치는 수정까지* 들어오지 못하게 막는다 — 여기서는
 * 타협 불가능한 성질이다.
 *
 * 킬 스위치는 그대로 존재한다: 보드에 `{"enabled": false}` 를 쓰면 그 보드의
 * lease 는 완전히 비활성화되고 도구는 항상 degraded 로 통과시킨다.
 */
export const MergeLeaseConfigSchema = z
  .object({
    /** 마스터 스위치. **미설정(null)이면 ON** — 명시적 false 만 끈다. */
    enabled: z.boolean().optional(),
    /**
     * 홀더가 "살아 있다" 고 볼 수 있는 최대 무진행 시간(분). 이 시간을 넘도록
     * 아무 진행 증거가 없으면 리퍼가 lease 를 회수한다. 진행 증거는 홀더의
     * 도구 호출뿐 아니라 **미해소 CI 대기(`pending_ci_wait`)** 도 포함하므로
     * (CI 가 아무리 길어도 살아 있는 것으로 간주) 이 값은 CI 소요시간이 아니라
     * "에이전트가 죽었는지" 를 재는 값이다.
     */
    idle_timeout_minutes: z.number().int().positive().max(24 * 60).optional(),
    /**
     * 진행 증거와 무관한 절대 상한(분) — 백스톱. liveness 판정 자체가 고장나도
     * lease 가 영원히 걸려 있지 않게 한다.
     */
    max_hold_minutes: z.number().int().positive().max(24 * 60).optional(),
    /**
     * 대기자가 lease 를 기다리는 최대 시간(분). 초과하면 **fail-open** —
     * degraded 로 기록하고 lease 없이 진행시킨다(기아 방지의 최종 방어선).
     */
    max_wait_minutes: z.number().int().positive().max(24 * 60).optional(),
  })
  .strict();

export type MergeLeaseConfig = z.infer<typeof MergeLeaseConfigSchema>;

export const MERGE_LEASE_CONFIG_KEYS = [
  'enabled',
  'idle_timeout_minutes',
  'max_hold_minutes',
  'max_wait_minutes',
] as const;

/** 무진행 판정 기본값 — CI 대기는 진행 증거로 치므로 "에이전트 사망" 감지용. */
export const DEFAULT_IDLE_TIMEOUT_MINUTES = 20;
/** 절대 상한 백스톱 기본값. */
export const DEFAULT_MAX_HOLD_MINUTES = 120;
/** 대기 상한 기본값 — 초과 시 fail-open. */
export const DEFAULT_MAX_WAIT_MINUTES = 45;

export interface ResolvedMergeLease {
  enabled: boolean;
  idleTimeoutMs: number;
  maxHoldMs: number;
  maxWaitMs: number;
}

/**
 * 저장된 `merge_lease_config` 텍스트를 파싱한다. null/빈값/깨진 JSON/스키마
 * 위반은 전부 null 을 돌려준다 — 읽기 경로에서 깨진 행은 throw 가 아니라
 * "설정 없음" 으로 degrade 해야 한다(parseMergeGateConfig 와 같은 계약).
 */
export function parseMergeLeaseConfig(raw: string | null | undefined): MergeLeaseConfig | null {
  if (!raw) return null;
  try {
    const parsed = MergeLeaseConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyMergeLease(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/**
 * 저장값을 소비자가 읽는 구체 값으로 해석한다.
 *
 * **기본 ON** — 설정이 아예 없거나(null) `enabled` 를 생략하면 활성이다.
 * `{"enabled": false}` 만이 그 보드의 lease 를 끈다. 깨진 설정도 null 로
 * 파싱되므로 결과는 "기본값으로 활성" 이다 — 깨진 JSON 때문에 조용히 꺼져서
 * 루프가 되살아나는 편보다, 켜진 채 fail-open 하는 편이 안전하다.
 */
export function resolveMergeLease(raw: string | null | undefined): ResolvedMergeLease {
  const cfg = parseMergeLeaseConfig(raw);
  const enabled = cfg?.enabled !== false;
  const minutes = (v: number | undefined, fallback: number) =>
    (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback) * 60_000;
  return {
    enabled,
    idleTimeoutMs: minutes(cfg?.idle_timeout_minutes, DEFAULT_IDLE_TIMEOUT_MINUTES),
    maxHoldMs: minutes(cfg?.max_hold_minutes, DEFAULT_MAX_HOLD_MINUTES),
    maxWaitMs: minutes(cfg?.max_wait_minutes, DEFAULT_MAX_WAIT_MINUTES),
  };
}

/**
 * 쓰기 경로 입력 검증(REST PATCH body / MCP 툴 인자). parseMergeLeaseConfig 와
 * 달리 잘못된 입력을 **거부**해 호출자가 400 을 낼 수 있게 한다 — 쓰기에서
 * 조용히 null 로 강등하면 오타 난 키가 피드백 없이 사라진다.
 */
export function validateMergeLeaseConfigInput(
  input: unknown,
): { ok: true; value: MergeLeaseConfig } | { ok: false; error: string } {
  const parsed = MergeLeaseConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map(i => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid merge_lease_config: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/** 저장용 직렬화: 빈 설정은 null 로 접는다(컬럼 null = "설정 없음" 단일 falsy 상태). */
export function serializeMergeLeaseConfig(value: MergeLeaseConfig | null | undefined): string | null {
  if (!value || isEmptyMergeLease(value)) return null;
  return JSON.stringify(value);
}

function isEmptyMergeLease(value: MergeLeaseConfig): boolean {
  return MERGE_LEASE_CONFIG_KEYS.every(k => value[k] === undefined);
}
