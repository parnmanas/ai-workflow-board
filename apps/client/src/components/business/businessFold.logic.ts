// Business 업무 상세의 섹션 접기/펼치기 — 저장과 복원 (순수 함수).
//
// 업무 상세는 결과 · 결정 · 요청 · 작성란 · 에이전트 작업 대화 · 진행 내역이 한 페이지에 세로로
// 쌓여 있어, 대화와 진행 내역이 길어지면 아래 섹션까지 한참 스크롤해야 했다. 섹션마다 접을 수
// 있게 하고, 접은 상태는 사이드바 폴드(sidebarFold.ts)처럼 localStorage 에 둔다 — 서버가 알
// 필요가 없는 화면 상태이고, 업무를 오갈 때마다 다시 접고 싶지 않다. 섹션 키 단위로 저장하므로
// 모든 업무에 같은 접힘이 적용된다(업무마다 따로 저장하면 처음 여는 업무가 늘 펼쳐진 채 시작한다).
//
// 값의 의미: `true` = 접힘. **기본값은 저장하지 않는다** — 저장된 적 없는 키는 아래
// `DEFAULT_FOLDED` 를 따르고, 사용자가 기본값과 같은 상태로 되돌리면 키를 지운다.

export const BUSINESS_FOLD_STORAGE_KEY = 'awb_business_fold';

/** 접을 수 있는 섹션. 새 섹션을 만들면 여기에 키를 더한다 — 저장 키의 목록이 곧 계약이다. */
export type BusinessFoldKey = 'result' | 'decision' | 'requests' | 'compose' | 'conversation' | 'history';

/**
 * 기본으로 접혀 있는 섹션. 에이전트 작업 대화는 도구 진행 메시지까지 전부 실리는 가장 긴
 * 섹션이고 정리된 결과는 위의 "최신 결과" 에 따로 있으므로 접힌 채 시작한다. 나머지는 펼쳐 둔다 —
 * 결과 · 결정 · 요청은 업무를 열자마자 봐야 하는 것들이다.
 */
export const DEFAULT_FOLDED: Readonly<Record<BusinessFoldKey, boolean>> = {
  result: false,
  decision: false,
  requests: false,
  compose: false,
  conversation: true,
  history: false,
};

export type BusinessFoldSnapshot = Partial<Record<BusinessFoldKey, boolean>>;

/** storage 의 모양이 무엇이든 불리언 레코드로 만든다 — 깨진 JSON · 다른 타입은 빈 스냅샷. */
export function parseBusinessFold(raw: string | null | undefined): BusinessFoldSnapshot {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: BusinessFoldSnapshot = {};
    for (const key of Object.keys(DEFAULT_FOLDED) as BusinessFoldKey[]) {
      const value = (parsed as Record<string, unknown>)[key];
      if (typeof value === 'boolean') out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function isBusinessFolded(snapshot: BusinessFoldSnapshot, key: BusinessFoldKey): boolean {
  return snapshot[key] ?? DEFAULT_FOLDED[key];
}

/** 접힘을 바꾼 새 스냅샷. 기본값과 같아지면 키를 지워 저장본을 작게 유지한다. */
export function withBusinessFold(snapshot: BusinessFoldSnapshot, key: BusinessFoldKey, folded: boolean): BusinessFoldSnapshot {
  const next = { ...snapshot };
  if (folded === DEFAULT_FOLDED[key]) delete next[key];
  else next[key] = folded;
  return next;
}

interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function storage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readBusinessFold(store: StorageLike | null = storage()): BusinessFoldSnapshot {
  try {
    return parseBusinessFold(store?.getItem(BUSINESS_FOLD_STORAGE_KEY));
  } catch {
    return {};
  }
}

export function writeBusinessFold(snapshot: BusinessFoldSnapshot, store: StorageLike | null = storage()): void {
  try {
    if (Object.keys(snapshot).length) store?.setItem(BUSINESS_FOLD_STORAGE_KEY, JSON.stringify(snapshot));
    else store?.removeItem(BUSINESS_FOLD_STORAGE_KEY);
  } catch {
    /* 저장 실패(프라이빗 모드 · 용량)는 화면을 막지 않는다 — 이번 세션 동안만 유지된다. */
  }
}
