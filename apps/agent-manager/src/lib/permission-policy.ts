// Effective CLI permission policy — Agent trust를 CLI 실행 권한의 단일
// 기준으로 정규화한다 (ticket 5851e435).
//
// 배경: 권한 계층이 두 개로 갈라져 있었다.
//   1. Agent `runtime_config.permission_mode` (strict/approve/trusted) —
//      운영자가 admin UI 에서 에이전트별로 고르는 "신뢰 등급". 지금까지는
//      Hermes(ACP) RuntimeSupervisor 만 이 값을 읽었고, CLI adapter 들은
//      존재조차 몰랐다.
//   2. board/workspace harness `permission_mode` — 자유 문자열(claude CLI 의
//      `--permission-mode` 값)이며, CLI adapter 들이 실제 spawn 플래그를
//      결정할 때 유일하게 보던 값.
//
// 그래서 `trusted` 로 표시된 에이전트라도 보드에 harness permission_mode 가
// 하나 걸려 있으면 claude 는 `--dangerously-skip-permissions` 를 잃고 workspace
// trust 대화상자가 다시 load-bearing 이 되어 dispatch 가 Pending 으로 떨어졌고,
// codex 는 최고 권한 플래그 대신 제한 sandbox 로 내려갔다.
//
// 이 모듈은 두 계층을 하나의 effective policy 로 합친다:
//   - Agent trust 가 설정돼 있으면 그 값이 tier 를 결정한다(source of truth).
//   - Agent trust 가 없으면(legacy agent) 예전과 똑같이 harness 문자열에서
//     tier 를 유도한다 — 기존 동작 보존.
// 순수 함수만 두어 어댑터/디스패처 없이 단위 테스트할 수 있게 한다.

/** 정규화된 권한 등급. Agent `runtime_config.permission_mode` 와 같은 값 집합. */
export type PermissionTier = 'strict' | 'approve' | 'trusted';

export const PERMISSION_TIERS: readonly PermissionTier[] = Object.freeze([
  'strict',
  'approve',
  'trusted',
]);

/** effective tier 를 누가 결정했는지 — 진단 로그와 precedence 검증용. */
export type PermissionSource =
  /** Agent `runtime_config.permission_mode` (기준값). */
  | 'agent_trust'
  /** Agent trust 미설정 + board/workspace harness `permission_mode` 존재. */
  | 'harness'
  /** 둘 다 없음 — 매니저 기본값(= 최고 권한, 종전 동작). */
  | 'default'
  /** Agent trust 가 **비어 있지 않은데 인식할 수 없는 값**이다. 손상된 config,
   *  손으로 편집한 DB, 매니저보다 새 서버가 보낸 미래의 등급 등. harness 나
   *  기본값으로 폴백하지 않고 최소 권한으로 fail-closed 한다. */
  | 'invalid_trust';

export interface EffectivePermissionPolicy {
  /** 이번 spawn 에 적용할 권한 등급. */
  tier: PermissionTier;
  /** tier 를 결정한 계층. */
  source: PermissionSource;
  /** Agent trust 원본값(정규화 실패 시 null). */
  trust: PermissionTier | null;
  /** harness 가 설정한 원본 permission_mode 문자열(없으면 null). 같은 tier
   *  안에서 "정확히 어떤 CLI 모드 문자열을 쓸지"를 고르는 데만 쓰인다. */
  harnessMode: string | null;
  /** harnessMode 를 legacy 규칙으로 해석한 tier(harnessMode 가 없으면
   *  'trusted' — 종전 기본 동작). */
  harnessTier: PermissionTier;
  /** Agent trust 가 harness 가 요구한 tier 를 실제로 덮어썼는가. */
  harnessOverridden: boolean;
  /** 거부된 Agent trust 원본 문자열(진단용, 길이 제한). 인식 가능한 값이거나
   *  아예 미설정이면 null. `source === 'invalid_trust'` 와 항상 함께 설정된다. */
  invalidTrust: string | null;
}

/**
 * legacy harness `permission_mode` 문자열 → tier.
 *
 * 매핑은 **이 티켓 이전의 실제 spawn 동작**에서 그대로 역산한 것이다:
 *   - 미설정 / `bypassPermissions` → claude `--dangerously-skip-permissions`,
 *     codex `--dangerously-bypass-approvals-and-sandbox` = trusted
 *   - `plan` → codex `--sandbox read-only` = strict
 *   - `acceptEdits`/`auto`/`default`/`dontAsk`/`manual` → codex
 *     `--sandbox workspace-write` = approve
 *   - 그 밖의 미인식 값 → claude 가 이미 `--dangerously-skip-permissions` 로
 *     폴백하고 codex 도 default 분기에서 bypass 로 떨어지므로 trusted.
 */
const HARNESS_MODE_TIERS: Readonly<Record<string, PermissionTier>> = Object.freeze({
  bypassPermissions: 'trusted',
  plan: 'strict',
  acceptEdits: 'approve',
  auto: 'approve',
  default: 'approve',
  dontAsk: 'approve',
  manual: 'approve',
});

/** harness 문자열을 tier 로 해석한다. 미설정/미인식은 'trusted'(종전 기본). */
export function harnessModeTier(harnessMode?: string | null): PermissionTier {
  const raw = typeof harnessMode === 'string' ? harnessMode.trim() : '';
  if (!raw) return 'trusted';
  return HARNESS_MODE_TIERS[raw] ?? 'trusted';
}

/** Agent trust 값을 tier 로 정규화한다. 미설정/미인식이면 null. */
export function normalizeTrust(trust?: string | null): PermissionTier | null {
  const raw = typeof trust === 'string' ? trust.trim() : '';
  return (PERMISSION_TIERS as readonly string[]).includes(raw)
    ? (raw as PermissionTier)
    : null;
}

/** 진단 로그에 남길 거부 값의 최대 길이 — 원본이 아무리 길어도 로그를 부풀리지
 *  않게 자른다. */
const MAX_INVALID_TRUST_LEN = 64;

/**
 * Agent trust 와 harness permission_mode 를 하나의 effective policy 로 합친다.
 *
 * **Precedence**: Agent trust > harness > 매니저 기본값. Agent trust 가 있으면
 * harness 는 tier 를 바꾸지 못하고, 같은 tier 안에서 어떤 CLI 모드 문자열을
 * 쓸지만 고른다(어댑터가 `harnessMode` 를 그렇게 소비한다). 그래서 trusted
 * 에이전트는 보드가 어떤 harness 값을 걸어도 최고 권한 플래그를 잃지 않는다.
 *
 * Agent trust 가 **아예 없는**(null/undefined/공백) legacy 에이전트는 예전
 * 규칙(harness 문자열 → tier)을 그대로 타므로 이 티켓 이전 동작이 바이트 단위로
 * 보존된다.
 *
 * **fail-closed (리뷰 지적 #3)**: Agent trust 가 비어 있지는 않은데 인식할 수
 * 없는 값이면 "미설정"으로 뭉뚱그리지 않는다. 그렇게 하면 손상된 config 한 줄,
 * 손으로 편집한 DB row, 또는 매니저보다 새 서버가 보낸 미지의 등급 하나가
 * harness/기본값 폴백을 타고 **최고 권한 플래그를 켤 수 있다**. 서버의
 * `validateAgentRuntimeConfig` 가 쓰기 경로에서 이 값을 검증하므로 여기 도달하는
 * 미인식 값은 이미 계약 위반이라는 뜻이고, 그 상태에서 권한을 올려주는 건
 * 정확히 반대 방향이다. 그래서 최소 권한(`strict`)으로 내리고 `source` 를
 * `invalid_trust` 로 표시해 로그에서 즉시 눈에 띄게 한다. spawn 자체를 거부하지
 * 않는 이유는, 그러면 config 한 글자 오타가 티켓을 통째로 멈춰 세우는데 —
 * `strict` 는 이미 이 코드베이스가 정의해 둔 "최소 권한/거부" 경로라 안전
 * 경계로 충분하고 복구도 운영자가 값만 고치면 되기 때문이다.
 */
export function resolveEffectivePermissionPolicy(input: {
  trust?: string | null;
  harnessMode?: string | null;
}): EffectivePermissionPolicy {
  const rawTrust = typeof input.trust === 'string' ? input.trust.trim() : '';
  const trust = normalizeTrust(input.trust);
  const invalidTrust = !trust && rawTrust ? rawTrust.slice(0, MAX_INVALID_TRUST_LEN) : null;
  const rawHarnessMode = typeof input.harnessMode === 'string' ? input.harnessMode.trim() : '';
  const harnessMode = rawHarnessMode || null;
  const harnessTier = harnessModeTier(harnessMode);
  const tier: PermissionTier = trust ?? (invalidTrust ? 'strict' : harnessTier);
  const source: PermissionSource = trust
    ? 'agent_trust'
    : invalidTrust
      ? 'invalid_trust'
      : harnessMode
        ? 'harness'
        : 'default';
  return {
    tier,
    source,
    trust,
    harnessMode,
    harnessTier,
    harnessOverridden: source === 'agent_trust' && !!harnessMode && harnessTier !== tier,
    invalidTrust,
  };
}

/** 정책이 없을 때 쓰는 기본값 — 매니저의 종전 동작(최고 권한)과 동일. */
export function defaultPermissionPolicy(): EffectivePermissionPolicy {
  return resolveEffectivePermissionPolicy({});
}

/**
 * 어댑터가 항상 정책 하나를 손에 쥐게 한다.
 *
 * spawn 사이트는 Agent trust 까지 반영한 완성된 정책을 넘긴다. 정책 없이
 * 어댑터를 직접 부르는 호출자(구버전 경로, 단위 테스트)는 harness
 * `permission_mode` 만으로 legacy 규칙에 따라 해석된다 — 어댑터가
 * `harnessKeys()` 에 `permission_mode` 를 선언해놓고 조용히 무시하는 일이
 * 없어야 하므로, 이 폴백은 방어가 아니라 계약이다. 둘 다 없으면 매니저의
 * 종전 기본값(trusted)이다.
 */
export function permissionPolicyOrDefault(
  policy?: EffectivePermissionPolicy | null,
  harnessMode?: string | null,
): EffectivePermissionPolicy {
  return policy ?? resolveEffectivePermissionPolicy({ harnessMode });
}

/** 어댑터가 각 tier 를 얼마나 충실히 표현할 수 있는가. */
export type PermissionTierSupport =
  /** 해당 제품이 그 tier 를 그대로 표현하는 전용 플래그를 갖고 있다. */
  | 'native'
  /** 전용 플래그는 없지만, 가진 수단 중 가장 가까운 동작으로 근사한다
   *  (예: auto-approve 플래그를 빼서 권한을 낮춘다). */
  | 'approximated'
  /** 표현 수단이 전혀 없다. 조용히 다른 tier 로 낮추지 않고 명시한다. */
  | 'unsupported';

export interface PermissionCapabilities {
  /**
   * CLI 가 실행 중 권한 요청을 프로토콜로 노출해 AWB 승인 경로에 연결할 수
   * 있는가. CLI adapter 들은 전부 false — 승인 브릿지는 ACP 런타임(Hermes)
   * 의 `RuntimeSupervisor.#handlePermission` 만 갖고 있다. `approve` tier 를
   * CLI 에서 쓸 때 무엇이 빠지는지 호출자가 로그로 밝힐 수 있게 노출한다.
   */
  native_approvals: boolean;
  tiers: Readonly<Record<PermissionTier, PermissionTierSupport>>;
}

/**
 * 실행 중 권한 요청을 프로토콜로 노출해 AWB 승인 경로에 연결할 수 있는
 * 런타임(현재 Hermes/ACP 뿐)용. 세 등급 모두 요구된 의미 그대로 구현된다 —
 * `approve` 는 실제로 `RuntimeSupervisor.#requestApproval` 을 통해 AWB 에
 * 승인을 요청하고, `strict` 는 요청을 거부(cancel)한다.
 */
export const NATIVE_APPROVAL_PERMISSION_CAPABILITIES: PermissionCapabilities = Object.freeze({
  native_approvals: true,
  tiers: Object.freeze({ strict: 'native', approve: 'native', trusted: 'native' }),
});

/**
 * 등급마다 전용 플래그는 있지만 승인 요청을 중계할 프로토콜 훅이 없는
 * CLI(claude/deepseek/codex)용.
 *
 * 리뷰 지적 #2: 이전 버전은 이 조합을 `approve: 'native'` 로 선언했는데,
 * 그건 "전용 플래그가 있다"는 뜻으로 쓴 것이지 "요구된 approve 의미(AWB 에
 * 승인을 요청한다)를 구현한다"는 뜻이 아니었다. 두 의미가 한 값에 겹쳐
 * 능력을 과장했다. `claude --print` 와 `codex exec` 는 실행 중 권한 요청을
 * 밖으로 노출하는 훅이 없어(ACP 의 `session/request_permission` 에 해당하는
 * 것이 없다) 어떤 승인도 **발생시키지 않는다** — 권한이 필요한 도구 호출은
 * 물어보지 않고 그냥 거부된다. 그건 실재하는 안전 경계이긴 하지만 승인
 * 경로는 아니므로 `approximated` 로 선언한다.
 */
export const TIER_FLAG_PERMISSION_CAPABILITIES: PermissionCapabilities = Object.freeze({
  native_approvals: false,
  tiers: Object.freeze({ strict: 'native', approve: 'approximated', trusted: 'native' }),
});

/** 최고 권한 플래그 하나만 있고, 나머지는 그 플래그를 빼서 근사하는
 *  어댑터(antigravity/pi)용. */
export const BYPASS_ONLY_PERMISSION_CAPABILITIES: PermissionCapabilities = Object.freeze({
  native_approvals: false,
  tiers: Object.freeze({ strict: 'approximated', approve: 'approximated', trusted: 'native' }),
});

/** 진단 로그 한 줄 — secret 을 담지 않는다(전부 열거형/짧은 모드 문자열). */
export function describePermissionPolicy(policy: EffectivePermissionPolicy): string {
  const parts = [
    `tier=${policy.tier}`,
    `source=${policy.source}`,
    `trust=${policy.trust ?? '-'}`,
    `harness_mode=${policy.harnessMode ?? '-'}`,
  ];
  if (policy.harnessOverridden) parts.push(`harness_tier_overridden=${policy.harnessTier}`);
  // 거부된 값은 열거형이 아니므로 인용해 로그에서 경계가 분명하게 보이게 한다.
  if (policy.invalidTrust) parts.push(`invalid_trust=${JSON.stringify(policy.invalidTrust)}`);
  return parts.join(' ');
}

/**
 * 이 런타임이 요청된 tier 를 얼마나 표현할 수 있는지 요약한다. 'native' 가
 * 아니면 호출자가 로그로 반드시 드러내야 한다 — 조용한 downgrade/upgrade 는
 * 금지(ticket 5851e435 요구사항).
 */
export function describePermissionSupport(
  cliType: string,
  policy: EffectivePermissionPolicy,
  capabilities: PermissionCapabilities,
): string | null {
  const support = capabilities.tiers[policy.tier];
  if (support === 'native') return null;
  if (policy.tier === 'approve' && !capabilities.native_approvals) {
    return (
      `cli=${cliType} tier=approve support=${support} native_approvals=false — 이 런타임은 ` +
      `실행 중 권한 요청을 밖으로 노출하는 훅이 없어 AWB 승인 요청을 아예 발생시키지 ` +
      `못한다. 대신 승인이 필요한 도구 호출이 묻지 않고 거부되는 비대화형 제한 모드로 ` +
      `실행된다. 사람이 승인하는 흐름이 필요하면 Agent 를 native_approvals 런타임으로 ` +
      `옮기고, 무조건 허용/거부가 목적이라면 trust 를 trusted/strict 로 명시하라.`
    );
  }
  return (
    `cli=${cliType} tier=${policy.tier} support=${support} — 이 런타임에는 해당 등급의 ` +
    `전용 옵션이 없다. 조용히 다른 등급으로 바꾸지 않고 가진 수단 중 가장 가까운 ` +
    `동작으로 실행한다.`
  );
}
