// 다이얼로그류 포커스 관리 통일 훅 (에픽 bf65ca00 · F2-5 접근성 심화).
//
// 모달/슬라이드오버/드로어가 제각각 인라인으로 갖고 있던 "열 때 초기 포커스 · Tab 트랩 ·
// 닫을 때 opener 복귀" 부수효과를 한 곳으로 수렴한다. 순수 인덱스 산술은 focusTrap.ts
// (nextFocusableIndex)를 재사용하고, 여기서는 DOM 부수효과(querySelectorAll/focus/
// preventDefault)만 담당한다. 모든 로직이 effect 안이라 SSR(renderToStaticMarkup)에선
// 아무것도 실행되지 않는다(컨텍스트/렌더 계약 불변).
import { useEffect, useRef, type RefObject } from 'react';
import { nextFocusableIndex, FOCUSABLE_SELECTOR } from './focusTrap';

/** 컨테이너 안에서 실제로 포커스 가능한 요소만 추린다(disabled/tabindex=-1 제외). */
function collectFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (n) => !n.hasAttribute('disabled') && n.tabIndex !== -1,
  );
}

interface DialogFocusOptions {
  /** 다이얼로그 열림 여부. */
  active: boolean;
  /** true 면 Tab/Shift+Tab 이 컨테이너 밖으로 새지 않고 내부를 순환한다(모달용). */
  trap: boolean;
  /** 트랩 대상이자 초기 포커스 폴백 컨테이너. */
  containerRef: RefObject<HTMLElement | null>;
  /** 열릴 때 우선 포커스할 요소(없으면 컨테이너 내 첫 포커스 요소, 그것도 없으면 컨테이너 자신). */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** 열린 채로 값이 바뀌면 opener 는 유지한 채 초기 포커스만 다시 적용(대상 전환). */
  focusKey?: unknown;
}

/**
 * 다이얼로그(모달/슬라이드오버/드로어)의 포커스 라이프사이클을 통일한다:
 *  - 열릴 때 opener(현재 활성 요소)를 1회 기억하고 initialFocusRef → 컨테이너 내 첫
 *    포커스 요소 → 컨테이너 자신 순으로 포커스를 옮긴다.
 *  - focusKey 가 열린 채로 바뀌면 opener 는 유지한 채 초기 포커스만 다시 적용한다.
 *  - trap=true 면 Tab 을 컨테이너 내부에 가둔다(nextFocusableIndex 로 랩어라운드).
 *  - 닫힐 때 기억해 둔 opener 로 포커스를 되돌린다.
 * Esc/backdrop 로 닫는 동작은 다이얼로그마다 정책이 달라 호출부가 소유한다(여기선 미관여).
 */
export function useDialogFocus({ active, trap, containerRef, initialFocusRef, focusKey }: DialogFocusOptions) {
  // 다이얼로그를 연 요소를 기억해 두었다가 닫힐 때 포커스를 되돌린다.
  const openerRef = useRef<HTMLElement | null>(null);

  // 열림/닫힘(및 대상 전환) 시 초기 포커스 이동과 opener 복귀.
  useEffect(() => {
    if (active) {
      // opener 는 최초 열림에만 기억한다(대상 전환 시 초기 포커스 요소로 덮어쓰지 않도록).
      if (!openerRef.current && typeof document !== 'undefined') {
        openerRef.current = document.activeElement as HTMLElement | null;
      }
      const container = containerRef.current;
      const target =
        initialFocusRef?.current ??
        (container ? collectFocusable(container)[0] : null) ??
        container;
      target?.focus?.();
    } else {
      const opener = openerRef.current;
      openerRef.current = null;
      opener?.focus?.();
    }
    // focusKey 로 대상 전환 시 재포커스; containerRef/initialFocusRef 는 안정적 ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, focusKey]);

  // Tab 포커스 트랩 — 활성 + trap 일 때만 컨테이너에 바인딩한다.
  useEffect(() => {
    if (!active || !trap) return;
    const el = containerRef.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const nodes = collectFocusable(el);
      if (nodes.length === 0) return;
      const current = nodes.indexOf(document.activeElement as HTMLElement);
      const next = nextFocusableIndex(nodes.length, current, e.shiftKey);
      e.preventDefault();
      nodes[next]?.focus();
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, trap, focusKey]);
}
