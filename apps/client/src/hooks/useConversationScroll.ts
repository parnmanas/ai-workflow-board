import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * 대화창 스크롤 동작의 **단일 구현**. chat 방 · mission 대화 · mission step 세션 ·
 * Agent Session 전사가 전부 이 훅을 쓴다.
 *
 * 네 화면이 각자 구현하고 있었고, 각자 다른 부분집합만 구현해 실제로 증상이 갈렸다:
 * mission 대화는 "근접했을 때만 따라간다" 규칙만 있고 **첫 진입 고정**이 없어서 열면
 * 항상 맨 위(가장 오래된 메시지)에 머물렀다. step 세션·전사에는 이미지가 나중에
 * 디코딩되며 높이가 자라는 경우의 재고정이 없었다. 읽는 내용은 화면마다 다르지만
 * (채팅 메시지 / 미션 타임라인 / CLI 전사 블록) **스크롤 규칙은 같아야 한다**.
 *
 * 규칙 네 가지 — 우선순위 순으로 한 layout effect 안에서 판정한다(그림 전에 끝나
 * 눈에 보이는 점프가 없다):
 *   1. 과거 prepend: 앞에 붙은 높이만큼 보정해 읽던 자리를 지킨다.
 *   2. 첫 진입(대화가 바뀔 때마다 다시): 애니메이션 없이 즉시 바닥.
 *   3. 새 항목이 아래에 붙음: **바닥 근처일 때만** 부드럽게 따라간다. 위에서 이력을
 *      읽는 중이면 끌어내리지 않는다.
 *   4. 비동기 높이 성장(이미지 디코딩·마크다운 리플로우): 바닥 근처면 다시 고정.
 *      이력을 읽는 중이면 브라우저 native scroll anchoring 에 맡긴다.
 *
 * 이 파일을 고칠 때는 네 화면 모두를 고치는 것임을 기억할 것.
 */

/** 이 거리(px) 안이면 "바닥에 붙어 있다"로 본다. */
export const NEAR_BOTTOM_PX = 80;
/** 위쪽 이 거리(px) 안으로 올리면 과거를 부른다. */
export const LOAD_OLDER_PX = 120;

export interface ConversationScrollOptions {
  /** `overflowY:auto` 인 뷰포트 요소. */
  scrollRef: RefObject<HTMLElement | null>;
  /**
   * 내용 래퍼 — 이 요소의 높이 변화를 ResizeObserver 로 지켜본다(이미지 디코딩).
   * 없으면 규칙 4 를 건너뛴다.
   */
  contentRef?: RefObject<HTMLElement | null>;
  /**
   * 대화의 경계(방 id / 미션 key / 세션 id / step id). 바뀌면 추종 상태를 초기화해
   * 새 대화를 다시 "첫 진입"처럼 바닥에 고정한다. 이걸 빼먹으면 이전 대화의 래치가
   * 남아 새 대화가 맨 위에서 열린다.
   */
  resetKey: string | null;
  /**
   * 마지막 항목의 정체성(보통 마지막 id). 바뀌면 "아래에 새 항목이 붙었다"로 본다.
   * 과거를 앞에 붙였을 때는 바뀌지 않아야 한다 — 그건 규칙 1 의 일이다.
   */
  tailKey: string | number | null;
  /**
   * 내용이 바뀔 때마다 바뀌는 값(보통 항목 수). 규칙 1 을 판정할 계기다 — `tailKey`
   * 만 보면 **앞에** 붙은 과거 페이지는 끝이 그대로여서 보정이 돌지 않고, 화면이
   * 맨 위로 튄 채 남는다.
   */
  contentKey: string | number;
  /** 첫 내용이 커밋됐는가(로딩 끝 + 항목 있음). false 면 첫 진입 고정을 미룬다. */
  ready: boolean;
  /**
   * 위쪽 영역에 닿았을 때 과거를 부른다. 훅이 호출 직전에 앵커를 잡아 두므로
   * 콜백 쪽에서 스크롤을 보정할 필요가 없다. 중복 호출 방지(hasMore/loading)는
   * 호출자 쪽 책임이다 — 그 상태는 호출자만 안다.
   */
  onLoadOlder?: () => void;
  /**
   * 추종을 잠시 멈춘다. 바닥 근접과는 다른 축의 래치가 필요한 화면을 위한 것 —
   * 미션 대화는 과거 이벤트 페이지를 보고 있는 동안(`eventWindowEdge==='history'`)
   * 새 이벤트가 와도 내려가면 안 된다.
   */
  followPaused?: boolean;
}

export interface ConversationScrollApi {
  /** 지금 바닥에 붙어 있는가 — "↓ 최신으로" 버튼의 표시 조건. */
  atBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
}

export function useConversationScroll({
  scrollRef,
  contentRef,
  resetKey,
  tailKey,
  contentKey,
  ready,
  onLoadOlder,
  followPaused = false,
}: ConversationScrollOptions): ConversationScrollApi {
  const didInitialRef = useRef(false);
  const lastTailRef = useRef<string | number | null>(null);
  const nearBottomRef = useRef(true);
  const anchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const setNearBottom = useCallback((value: boolean) => {
    nearBottomRef.current = value;
    setAtBottom((prev) => (prev === value ? prev : value));
  }, []);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = 'auto') => {
      const el = scrollRef.current;
      if (!el) return;
      // smooth 는 새 항목을 따라갈 때만. 첫 진입에 쓰면 이미지가 디코딩되며 높이가
      // 자라는 동안 애니메이션이 "중간에서" 멈춘다(chat 의 티켓 abd1ce81).
      if (behavior === 'smooth' && typeof el.scrollTo === 'function') {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      } else {
        el.scrollTop = el.scrollHeight;
      }
      setNearBottom(true);
    },
    [scrollRef, setNearBottom],
  );

  // 대화가 바뀌면 전부 초기화한다 — 남은 래치가 새 대화의 첫 고정을 삼킨다.
  //
  // **렌더 단계**에서 해야 한다. `useEffect` 로 하면 마운트 때도 한 번 돌고, 그 순서가
  // layout effect **뒤**라서 방금 세운 "첫 고정 완료" 래치를 곧바로 지운다 — 다음에
  // 새 항목이 하나 도착하면 그때 다시 "첫 진입"으로 취급해 followPaused·이력 열람을
  // 무시하고 바닥으로 끌어내린다. (이 훅을 만들면서 실제로 그렇게 동작했다.)
  const renderedResetRef = useRef(resetKey);
  if (renderedResetRef.current !== resetKey) {
    renderedResetRef.current = resetKey;
    didInitialRef.current = false;
    lastTailRef.current = null;
    anchorRef.current = null;
    nearBottomRef.current = true;
    setAtBottom(true);
  }

  // 규칙 1~3.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const anchor = anchorRef.current;
    if (anchor) {
      const delta = el.scrollHeight - anchor.scrollHeight;
      anchorRef.current = null;
      if (delta > 0) {
        el.scrollTop = anchor.scrollTop + delta;
        return;
      }
      // 앞에 붙은 것이 없다(빈 페이지·실패). 앵커만 버리고 아래 판정을 그대로 태운다 —
      // 앵커를 들고 있으면 다음에 실제로 도착한 새 항목의 추종이 조용히 삼켜진다.
    }

    if (!ready) return;

    if (!didInitialRef.current) {
      didInitialRef.current = true;
      lastTailRef.current = tailKey;
      scrollToBottom('auto');
      return;
    }

    if (tailKey !== lastTailRef.current) {
      lastTailRef.current = tailKey;
      if (nearBottomRef.current && !followPaused) scrollToBottom('smooth');
    }
  }, [scrollRef, ready, tailKey, contentKey, followPaused, scrollToBottom]);

  // 규칙 4 — 이미지/마크다운이 높이를 키우는 동안 바닥 유지.
  useEffect(() => {
    const content = contentRef?.current;
    const el = scrollRef.current;
    if (!content || !el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (anchorRef.current) return; // 진행 중인 prepend 보정과 싸우지 않는다.
      if (nearBottomRef.current && !followPaused) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [contentRef, scrollRef, resetKey, ready, followPaused]);

  // 바닥 근접 추적 + 과거 로드 트리거. 컨테이너에 직접 붙여 호출자가 onScroll 을
  // 배선하지 않게 한다(배선을 잊어 추종이 죽는 전례를 없앤다).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      setNearBottom(el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX);
      if (!onLoadOlder) return;
      if (el.scrollTop > LOAD_OLDER_PX) return;
      anchorRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      onLoadOlder();
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollRef, onLoadOlder, setNearBottom, resetKey]);

  return { atBottom, scrollToBottom };
}
