// ─── 에이전트 credential 공란 fallback 안내 (ticket d2360de6) ───────────────
// 에이전트의 `credential_id`가 비어 있을 때 매니저는 per-agent credential 대신
// "매니저 호스트의 로그인/env"(코드베이스 용어로 "operator HOME") fallback 경로를
// 선택한다 — 그 host 로그인/env 가 실제로 존재하는지는 별개(없으면 turn 이 실패).
// 그런데 그 fallback 의미가 어댑터마다 다른데도 admin UI 는
// 모든 CLI 에 대해 똑같이 "None — fall back to operator HOME" 이라는 한 문장만
// 보여줬다. 그 결과 공란 credential 을 "인증 미설정(blocker)"으로 반복 오판해
// 불필요한 운영자 조치를 요청하는 일이 있었다 (원 티켓 09a0442f: Codex
// `credential_id: null` = 호스트 `codex login` fallback 경로 선택 — per-agent
// credential 누락을 뜻하지 않음; host auth(호스트 로그인/env) 존재 여부는 별도).
//
// 이 헬퍼는 credential picker / 읽기전용 표시가 렌더되는 모든 곳에서 어댑터별
// fallback 의미를 한 곳에서 제공한다. 네 개 표시 지점(admin/AgentManager,
// AgentsPage, admin/ManagedAgentDialog, AgentDetailModal)이 예전엔 동일 리터럴을
// 각자 복제하고 있어 문구가 갈라지기 쉬웠으므로, 여기로 단일화해 drift 를 막는다.
//
// 런타임 동작의 source of truth 는 agent-manager 어댑터의 prepareCliHome:
//   - claude      → 호스트 ~/.claude/.credentials.json (`claude login`) symlink/copy
//   - codex       → 호스트 ~/.codex/auth.json (`codex login`) symlink/copy
//   - deepseek    → 호스트 셸 env DEEPSEEK_API_KEY (+ 선택 BASE_URL/MODEL), 로그인 파일 아님
//   - antigravity → 호스트 셸 env GEMINI_API_KEY / GOOGLE_API_KEY, 로그인 파일 아님
// 어댑터 로직을 바꾸면 아래 문구도 같이 갱신할 것.

export interface CredentialFallbackCopy {
  /** credential <select> 의 빈 "None" 옵션 라벨 — 어댑터별로 무엇을 쓰는지 명시. */
  optionLabel: string;
  /**
   * 필드 아래 도움말 한 문장. "공란은 per-agent credential 을 안 붙인 정상 설정
   * (호스트 fallback 경로 선택)이지 그 자체가 인증 실패가 아니다"를 먼저 밝히되,
   * 공란이 인증 가용성을 보장하지는 않는다는 점(해당 host 파일/env 가 실제로
   * 존재해야 함)까지 함께 밝힌다. 설정 의미와 실제 인증 가용성을 구분한다.
   */
  meaning: string;
}

// claude / codex 는 호스트의 CLI 로그인 파일("Host CLI login")을 재사용하고,
// deepseek / antigravity 는 호스트 셸 환경변수로 fallback 한다 — 그래서 전부
// 뭉뚱그려 "Host CLI login" 이라고 쓰면 deepseek/antigravity 에는 틀린다.
const FALLBACK_BY_CLI: Record<string, CredentialFallbackCopy> = {
  claude: {
    optionLabel: 'None — use the host Claude CLI login (claude login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager points this agent at the host Claude CLI login — the claude login credential at ~/.claude/.credentials.json (a.k.a. "operator HOME") on the manager host — on every spawn. Authentication still requires that host login to actually exist; if it is absent the adapter injects no auth and turns fail.',
  },
  codex: {
    optionLabel: 'None — use the host Codex CLI login (codex login)',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager points this agent at the host Codex CLI login — the codex login credential at ~/.codex/auth.json (a.k.a. "operator HOME") on the manager host — on every spawn. Authentication still requires that host login to actually exist; if it is absent the adapter injects no auth and turns fail.',
  },
  deepseek: {
    optionLabel: 'None — use the host DEEPSEEK_API_KEY env',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the DEEPSEEK_API_KEY (and optional DEEPSEEK_BASE_URL / DEEPSEEK_MODEL) shell environment on the manager host on every spawn. Authentication still requires DEEPSEEK_API_KEY to actually be set in that environment; if it is unset no key is injected and turns fail.',
  },
  antigravity: {
    optionLabel: 'None — use the host GEMINI_API_KEY env',
    meaning:
      'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the GEMINI_API_KEY / GOOGLE_API_KEY shell environment on the manager host on every spawn. Authentication still requires that env var to actually be set on the host; if it is unset no key is injected and turns fail.',
  },
};

// 알 수 없는/custom CLI 용 일반 문구 — 특정 어댑터 세부를 단정하지 않는다.
const GENERIC_FALLBACK: CredentialFallbackCopy = {
  optionLabel: 'None — use the operator login on the manager host',
  meaning:
    'Leaving this empty is a valid fallback configuration, not a per-agent credential gap: the manager falls back to the operator login stored on the manager host ("operator HOME") on every spawn. Authentication still requires that host credential to actually exist.',
};

/**
 * 주어진 CLI(어댑터) 타입에 대한 credential 공란 fallback 문구를 돌려준다.
 * 매칭되는 어댑터가 없으면(예: custom, 미래 타입) 일반 문구로 안전하게 fallback.
 */
export function credentialFallbackCopy(cli: string | null | undefined): CredentialFallbackCopy {
  return (cli && FALLBACK_BY_CLI[cli]) || GENERIC_FALLBACK;
}
