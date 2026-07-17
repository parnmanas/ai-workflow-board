/**
 * ViewMode 순수 로직 (에픽 bf65ca00 · Phase 1 · S1 공통 셸).
 *
 * 컴포넌트/컨텍스트에서 분리해 node:test 로 직접 구동 가능하게 둔다
 * (chat/utils/composerSend.ts 선례와 동일한 DI-추출 규약, 루트 CLAUDE.md: 레포에
 * jsdom 없음). 라우팅·토글이 defaultSectionForMode() 한 곳을 참조하므로 랜딩 섹션
 * 문자열이 중복되지 않는다.
 */

export type ViewMode = 'chat' | 'advanced';

export const STORAGE_KEY = 'awb.viewMode';

/** 기본 모드 = Chat-first. 저장된 값이 유효하면 복원, window 없으면(SSR/노드) 기본값. */
export function readInitialMode(): ViewMode {
  if (typeof window === 'undefined') return 'chat';
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    if (v === 'chat' || v === 'advanced') return v;
  } catch {
    /* localStorage 접근 불가(프라이빗 모드 등) → 기본값 */
  }
  return 'chat';
}

/** best-effort 지속. */
export function persistMode(mode: ViewMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* best-effort */
  }
}

/**
 * 주어진 모드의 기본 랜딩 섹션 — 라우팅과 토글이 공유하는 단일 진실.
 * chat → 'assistant'(Chat-first 홈), advanced → 'boards'(기존 Board 경험).
 */
export function defaultSectionForMode(mode: ViewMode): 'assistant' | 'boards' {
  return mode === 'chat' ? 'assistant' : 'boards';
}
