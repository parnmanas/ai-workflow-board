import { z } from 'zod';

/**
 * Repository clone policy (ticket bddb63ee).
 *
 * 대형 저장소의 첫 clone 이 고정 wall-clock timeout 에 걸려 프로비저닝이 실패하던
 * 문제를 없애기 위해, clone 예산과 clone 전략을 **Repo Resource 단위**로 저장하고
 * dispatch 시점에 해석해 agent-manager 로 실어 보낸다.
 *
 * 저장 위치는 `harness_config` / `environment_config` 관례를 그대로 따른다 —
 * JSON text 컬럼 한 개:
 *   - `Resource.clone_policy`  (type='repository' 에서만 의미 있음) = repo 별 override
 *   - `Workspace.clone_policy`                                     = workspace 기본값
 *
 * 우선순위는 **키 단위**로 Repo Resource → Workspace → 시스템 기본값이다
 * (`resolveClonePolicy`). Resource 가 timeout 만 지정하면 나머지 키는 Workspace 값,
 * Workspace 에도 없으면 시스템 기본값이 채워진다.
 *
 * 하위 호환: 두 컬럼 모두 nullable 이고 기본 null 이다. 둘 다 비어 있으면
 * `resolveClonePolicy` 가 null 을 돌려주고, 그 경우 SSE payload 에서도 필드가
 * null 로 나간다 — agent-manager 는 null 을 "정책 없음 = 매니저 기본값"으로
 * 취급하며, 그 매니저 기본값이 곧 시스템 기본값(clone timeout 60분)이다. 즉
 * 설정이 전혀 없는 기존 저장소도, 이 필드를 모르는 구버전 매니저도 동일하게
 * 60분 예산으로 clone 된다.
 */

/** 시스템 기본 clone wall-clock 예산 — 60분. 이 티켓 이전의 고정값은 20분이었다. */
export const DEFAULT_CLONE_TIMEOUT_SECONDS = 3600;

/**
 * 시스템 기본 idle timeout — 10분. clone 이 **아무 진행 출력도 내지 않은 채**
 * 이만큼 지나면 정지(stall)로 판단한다. wall-clock 예산과 달리 진행 중인 clone 은
 * 절대 끊지 않는 것이 목적이라, 실제로 바이트가 흐르는 동안은 60분 한도까지
 * 살아 있고 완전히 멈춘 연결만 조기에 회수된다. 0 은 idle 판정 비활성.
 */
export const DEFAULT_CLONE_IDLE_TIMEOUT_SECONDS = 600;

/**
 * `--filter` 값 화이트리스트 정규식. git 이 받는 형태(`blob:none`,
 * `blob:limit=1m`, `tree:0`, `object:type=blob`, `combine:blob:none+tree:0`)를
 * 커버하되 반드시 영숫자로 시작하게 강제한다 — `-` 로 시작하는 값이 argv 에
 * 그대로 실리면 git 플래그로 해석되기 때문이다.
 */
const CLONE_FILTER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:=+._-]*$/;

export const ClonePolicySchema = z
  .object({
    /** clone 전체 wall-clock 예산(초). 60초~24시간. */
    clone_timeout_seconds: z.number().int().min(60).max(86400).optional(),
    /** 무출력 상태가 이 시간을 넘으면 정지로 판단(초). 0 = 비활성. */
    clone_idle_timeout_seconds: z.number().int().min(0).max(86400).optional(),
    /** `--depth` — shallow clone 커밋 수. 미지정 = 전체 히스토리. */
    clone_depth: z.number().int().min(1).max(1000000).optional(),
    /** `--filter` — partial clone 필터(예: `blob:none`). 미지정 = 필터 없음. */
    clone_filter: z.string().trim().max(64).regex(CLONE_FILTER_PATTERN, {
      message: 'must match /^[A-Za-z0-9][A-Za-z0-9:=+._-]*$/ (e.g. "blob:none", "tree:0")',
    }).optional(),
    /** `--single-branch` — 대상 브랜치 하나만 가져온다. */
    single_branch: z.boolean().optional(),
  })
  .strict();

export type ClonePolicy = z.infer<typeof ClonePolicySchema>;

/** dispatch 시점에 확정돼 SSE payload 로 나가는 형태 — 모든 키가 채워져 있다. */
export interface ResolvedClonePolicy {
  clone_timeout_seconds: number;
  clone_idle_timeout_seconds: number;
  clone_depth: number | null;
  clone_filter: string | null;
  single_branch: boolean;
}

export const CLONE_POLICY_KEYS = [
  'clone_timeout_seconds',
  'clone_idle_timeout_seconds',
  'clone_depth',
  'clone_filter',
  'single_branch',
] as const;

function isEmptyPolicy(value: ClonePolicy): boolean {
  return CLONE_POLICY_KEYS.every((key) => value[key] === undefined);
}

/**
 * 저장된 clone_policy text 컬럼을 파싱한다. null/빈문자열/깨진 JSON/스키마 위반은
 * 전부 null — 읽기 경로는 절대 throw 하지 않는다(parseHarnessConfig 와 동일 계약).
 */
export function parseClonePolicy(raw: string | null | undefined): ClonePolicy | null {
  if (!raw) return null;
  try {
    const parsed = ClonePolicySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return null;
    return isEmptyPolicy(parsed.data) ? null : parsed.data;
  } catch {
    return null;
  }
}

/** 쓰기 경로(REST PATCH body / MCP 인자) 검증. 위반은 호출자가 400 으로 돌려준다. */
export function validateClonePolicyInput(
  input: unknown,
): { ok: true; value: ClonePolicy } | { ok: false; error: string } {
  const parsed = ClonePolicySchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid clone_policy: ${issues}` };
  }
  return { ok: true, value: parsed.data };
}

/** 저장용 직렬화 — 빈 정책은 null 로 접어 "정책 없음" 을 단일 falsy 상태로 유지한다. */
export function serializeClonePolicy(value: ClonePolicy | null | undefined): string | null {
  if (!value || isEmptyPolicy(value)) return null;
  return JSON.stringify(value);
}

/**
 * Repo Resource → Workspace → 시스템 기본값을 **키 단위**로 합친다.
 *
 * 두 레이어 모두 비어 있으면 null 을 돌려준다 — 호출자는 이를 "override 없음"
 * 으로 흘려보내고 agent-manager 가 자신의 기본값(= 여기 시스템 기본값과 동일)을
 * 쓰게 한다. 한쪽이라도 값을 지정했다면 나머지 키까지 전부 채운 확정 형태를
 * 돌려주므로, wire 로 나가는 정책은 언제나 완전하다.
 */
export function resolveClonePolicy(
  resourceRaw: string | null | undefined,
  workspaceRaw: string | null | undefined,
): ResolvedClonePolicy | null {
  const resource = parseClonePolicy(resourceRaw);
  const workspace = parseClonePolicy(workspaceRaw);
  if (!resource && !workspace) return null;
  const pick = <K extends keyof ClonePolicy>(key: K): ClonePolicy[K] =>
    resource?.[key] !== undefined ? resource[key] : workspace?.[key];
  return {
    clone_timeout_seconds: pick('clone_timeout_seconds') ?? DEFAULT_CLONE_TIMEOUT_SECONDS,
    clone_idle_timeout_seconds: pick('clone_idle_timeout_seconds') ?? DEFAULT_CLONE_IDLE_TIMEOUT_SECONDS,
    clone_depth: pick('clone_depth') ?? null,
    clone_filter: pick('clone_filter') ?? null,
    single_branch: pick('single_branch') ?? false,
  };
}
