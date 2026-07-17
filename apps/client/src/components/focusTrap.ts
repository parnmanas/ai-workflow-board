// 포커스 트랩 순수 인덱스 계산 (에픽 bf65ca00 · Phase 1 · S4 접근성).
//
// 모바일 모달(role=dialog·aria-modal)에서 Tab/Shift+Tab 이 배경으로 새지 않고 내부
// 포커스 가능한 요소를 순환하도록 다음 인덱스를 계산한다. DOM 질의(querySelectorAll)와
// preventDefault/focus 는 컴포넌트가 담당하고, 여기서는 랩어라운드 인덱스 산술만 —
// node:test 로 직접 검증한다(DOM 불필요).

/**
 * 포커스 가능한 요소가 `count` 개일 때, 현재 포커스 인덱스(`currentIndex`, 목록에
 * 없으면 -1)에서 Tab(정방향) / Shift+Tab(역방향) 시 이동할 다음 인덱스를 반환한다.
 * - 마지막에서 정방향 → 처음(0)으로 랩, 처음에서 역방향 → 마지막으로 랩.
 * - 현재 포커스가 목록 밖(-1)이면 정방향은 0, 역방향은 마지막에서 시작.
 * - count<=0 이면 -1 (트랩할 대상 없음 → 호출부는 no-op).
 */
export function nextFocusableIndex(count: number, currentIndex: number, shiftKey: boolean): number {
  if (count <= 0) return -1;
  if (currentIndex < 0) return shiftKey ? count - 1 : 0;
  return (currentIndex + (shiftKey ? -1 : 1) + count) % count;
}

/** 모달 안에서 포커스 가능한 요소를 뽑는 셀렉터(disabled/tabindex=-1 제외는 호출부에서). */
export const FOCUSABLE_SELECTOR =
  'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
