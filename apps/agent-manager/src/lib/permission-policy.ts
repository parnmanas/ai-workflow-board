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
  | 'default';

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

/**
 * Agent trust 와 harness permission_mode 를 하나의 effective policy 로 합친다.
 *
 * **Precedence**: Agent trust > harness > 매니저 기본값. Agent trust 가 있으면
 * harness 는 tier 를 바꾸지 못하고, 같은 tier 안에서 어떤 CLI 모드 문자열을
 * 쓸지만 고른다(어댑터가 `harnessMode` 를 그렇게 소비한다). 그래서 trusted
 * 에이전트는 보드가 어떤 harness 값을 걸어도 최고 권한 플래그를 잃지 않는다.
 *
 * Agent trust 가 없는 legacy 에이전트는 예전 규칙(harness 문자열 → tier)을
 * 그대로 타므로, 이 티켓 이전 동작이 바이트 단위로 보존된다.
 */
export function resolveEffectivePermissionPolicy(input: {
  trust?: string | null;
  harnessMode?: string | null;
}): EffectivePermissionPolicy {
  const trust = normalizeTrust(input.trust);
  const rawHarnessMode = typeof input.harnessMode === 'string' ? input.harnessMode.trim() : '';
  const harnessMode = rawHarnessMode || null;
  const harnessTier = harnessModeTier(harnessMode);
  const tier = trust ?? harnessTier;
  const source: PermissionSource = trust
    ? 'agent_trust'
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

/** 세 tier 를 모두 전용 플래그로 표현하는 어댑터(claude/deepseek/codex)용. */
export const FULL_PERMISSION_CAPABILITIES: PermissionCapabilities = Object.freeze({
  native_approvals: false,
  tiers: Object.freeze({ strict: 'native', approve: 'native', trusted: 'native' }),
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
  return parts.join(' ');
}

/**
 * 이 어댑터가 요청된 tier 를 얼마나 표현할 수 있는지 요약한다. 'native' 가
 * 아니면 호출자가 로그로 반드시 드러내야 한다 — 조용한 downgrade/upgrade 는
 * 금지(ticket 5851e435 요구사항).
 */
export function describePermissionSupport(
  cliType: string,
  policy: EffectivePermissionPolicy,
  capabilities: PermissionCapabilities,
): string | null {
  const support = capabilities.tiers[policy.tier];
  if (support === 'native') {
    if (policy.tier !== 'approve' || capabilities.native_approvals) return null;
    return (
      `cli=${cliType} tier=approve — 이 CLI 는 실행 중 권한 요청을 AWB 승인 경로로 ` +
      `중계하지 못한다(native_approvals=false). 승인 대신 비대화형 제한 모드로 실행된다.`
    );
  }
  return (
    `cli=${cliType} tier=${policy.tier} support=${support} — 이 CLI 에는 해당 등급의 ` +
    `전용 옵션이 없다. 조용히 다른 등급으로 바꾸지 않고 가진 수단 중 가장 가까운 ` +
    `동작으로 실행한다.`
  );
}
