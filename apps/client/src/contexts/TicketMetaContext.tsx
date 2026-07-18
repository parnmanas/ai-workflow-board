import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useBoardStreamEvent } from './BoardStreamContext';
import { createTicketMetaStore, type TicketMeta, type TicketMetaStore } from './ticketMetaStore';

/**
 * F2-4 ⓐ (ticket d21b28fc): 티켓 "상태 카드" 프로바이더.
 *
 * 채팅 메시지 리스트 위(AppLayout, BoardStreamProvider 아래)에 하나만 마운트해,
 * 그 아래 모든 TicketRefCard 가 한 스토어를 공유한다 — 같은 티켓 카드가 여럿 떠도
 * getTicket 은 1회로 합쳐지고(N+1 방지) 결과가 캐시된다. board_update SSE 는 해당
 * 티켓 메타를 무효화해 F2-3 실시간 갱신과 연동한다.
 *
 * 순수 캐시/경합 로직은 ./ticketMetaStore(node:test 로 검증). 여기서는 fetcher 로
 * api.getTicket 을, 무효화 트리거로 useBoardStreamEvent 를 배선한다. 테스트는 `store`
 * prop 으로 DI 스토어를 주입할 수 있다(api·네트워크 없이 칩 렌더 계약 검증).
 */
const TicketMetaContext = createContext<TicketMetaStore | null>(null);

export function TicketMetaProvider({
  children,
  store: injected,
}: {
  children: React.ReactNode;
  store?: TicketMetaStore;
}) {
  const store = useMemo(
    () =>
      injected ??
      createTicketMetaStore(async (id) => {
        const t = await api.getTicket(id);
        if (!t) return null;
        const meta: TicketMeta = {};
        if (typeof t.status === 'string' && t.status) meta.status = t.status;
        if (typeof t.priority === 'string' && t.priority) meta.priority = t.priority;
        return meta;
      }),
    [injected],
  );

  // SSE board_update → 해당 티켓 메타 무효화(F2-3 실시간과 연동). 실 wire 는 flatten 된
  // { ticket_id, ... } JSON 문자열이라 문자열/객체 양쪽을 방어적으로 파싱한다.
  useBoardStreamEvent('board_update', (data) => {
    try {
      const parsed = typeof data === 'string' ? JSON.parse(data) : data;
      const id = parsed?.ticket_id;
      if (typeof id === 'string' && id) store.invalidate(id);
    } catch {
      /* malformed event → skip */
    }
  });

  return <TicketMetaContext.Provider value={store}>{children}</TicketMetaContext.Provider>;
}

/**
 * 티켓 현재 메타(컬럼/우선순위)를 구독한다. 프로바이더 밖에서는 undefined 를 반환하는
 * 안전한 no-op — 순수 SSR 계약 테스트/프로바이더 없는 표면에서도 카드가 그대로 뜬다
 * (칩만 생략). 마운트 시 lazy fetch 를 트리거하고, 갱신되면 리렌더한다.
 */
export function useTicketMeta(id: string): TicketMeta | undefined {
  const store = useContext(TicketMetaContext);
  const [, force] = useState(0);
  useEffect(() => {
    if (!store) return;
    store.ensure(id);
    return store.subscribe(id, () => force((n) => n + 1));
  }, [store, id]);
  return store ? store.get(id) : undefined;
}
