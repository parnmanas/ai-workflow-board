// ─── 에이전트 credential 공란 fallback 안내 (ticket d2360de6) ───────────────
// 에이전트의 `credential_id`가 비어 있을 때 매니저는 per-agent credential 대신
// "매니저 호스트의 로그인/env"(코드베이스 용어로 "operator HOME") fallback 경로를
// 선택한다 — 그 host 로그인/env 가 실제로 존재하는지는 별개(없으면 turn 이 실패).
// 그 fallback 의미가 어댑터마다 다른데도 admin UI 가 한 문장만 보여줘 공란
// credential 을 "인증 미설정(blocker)"으로 반복 오판하던 일(원 티켓 09a0442f)을
// 막기 위해, credential picker / 읽기전용 표시가 렌더되는 모든 곳이 이 헬퍼
// 하나를 통해 어댑터별 문구를 받는다.
//
// 이 파일은 공개 API(`credentialFallbackCopy`)만 유지한다. 어댑터별 문구 자체는
// UI 전용 표인 `cli/presentation.ts`(CREDENTIAL_FALLBACK_COPY)에 있고, 어떤 CLI 가
// 존재하는지는 `cli/catalog.ts` 가 안다 — 카탈로그에 없는 id 나 문구가 없는
// id(custom, hermes, 미래 CLI)는 특정 어댑터 세부를 단정하지 않는 일반 문구로
// 안전하게 fallback 한다.
import {
  CREDENTIAL_FALLBACK_COPY,
  GENERIC_CREDENTIAL_FALLBACK,
  type CredentialFallbackCopy,
} from '../cli/presentation';

export type { CredentialFallbackCopy };

/**
 * 주어진 CLI(어댑터) 타입에 대한 credential 공란 fallback 문구를 돌려준다.
 * 전용 문구가 없는 id(custom, hermes, 미래 타입, null)는 일반 문구로 안전하게
 * fallback 한다(throw 없음).
 */
export function credentialFallbackCopy(cli: string | null | undefined): CredentialFallbackCopy {
  return (cli && CREDENTIAL_FALLBACK_COPY[cli]) || GENERIC_CREDENTIAL_FALLBACK;
}
