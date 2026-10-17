import { useEffect, useRef } from 'react';

const STATE_KEY = 'awbOverlay';

/**
 * 열려 있는 동안 history 에 같은 주소의 항목 하나를 얹어, 뒤로 가기가 화면을 떠나는 대신 이
 * 오버레이를 닫게 한다. 안드로이드 앱의 뒤로 버튼은 `WebView.goBack()` 이라 이 항목을 먼저 지운다 —
 * 사진을 크게 보다가 뒤로를 누르면 세션 · 채팅 화면이 통째로 사라지던 것을 막는다.
 *
 * 항목은 현재 history.state 를 그대로 복사하고 표시 하나만 더한다 — React Router 가 보는 key/idx 가
 * 같으므로 뒤로 가기는 라우터에게 "같은 위치" 다. 오버레이를 버튼 · Esc 로 닫으면 얹은 항목을 직접
 * 걷어낸다. 그 사이 다른 화면으로 이동해 맨 위가 내 항목이 아니면 건드리지 않는다(사용자의 이동을
 * 되돌리면 안 된다).
 */
export function useCloseOnBack(onClose: () => void): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const tokenRef = useRef<string | null>(null);
  const aliveRef = useRef(false);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.history?.pushState !== 'function') return;
    const history = window.history;
    aliveRef.current = true;
    // StrictMode 는 effect 를 정리한 뒤 곧바로 다시 돌린다 — 그때는 얹어 둔 항목을 물려 쓴다.
    if (!tokenRef.current) {
      tokenRef.current = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
      const current = history.state && typeof history.state === 'object' ? history.state : {};
      history.pushState({ ...current, [STATE_KEY]: tokenRef.current }, '');
    }
    const token = tokenRef.current;
    const onPop = () => {
      if (history.state?.[STATE_KEY] === token) return;
      onCloseRef.current();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      aliveRef.current = false;
      window.removeEventListener('popstate', onPop);
      setTimeout(() => {
        if (aliveRef.current) return;
        try {
          if (history.state?.[STATE_KEY] === token) history.back();
        } catch {
          // 창이 이미 닫혔다(테스트 정리 등) — 걷어낼 history 가 없다.
        }
      }, 0);
    };
  }, []);
}
