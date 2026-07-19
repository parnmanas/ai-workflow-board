// F2-4 ⓐ (ticket d21b28fc): 티켓 "상태 카드"용 lazy fetch + 캐시 + 무효화 스토어.
//
// 채팅에는 같은 ticket_id 를 참조하는 카드가 여럿 뜰 수 있다. 각 카드가 제 손으로
// getTicket 을 부르면 N+1 폭주가 나므로(티켓 스펙 "N+1 주의"), 이 스토어가:
//   • 동일 id 의 동시 fetch 를 1건으로 합치고(inflight dedupe),
//   • 결과(현재 컬럼/우선순위)를 캐시해 이후 카드는 즉시 그린다,
//   • SSE board_update 로 해당 id 를 무효화해 F2-3 실시간 갱신과 연동한다.
//
// React 를 모르는 순수 로직 — 경합/무효화 계약을 node:test 로 커밋 검증한다(jsdom 불요,
// board memory: client 로직 DI-extract node:test). context 래퍼가 fetcher 로 api.getTicket 을,
// 무효화 트리거로 useBoardStreamEvent('board_update') 를 주입한다.

export interface TicketMeta {
  status?: string; // 현재 컬럼(표시명 또는 id)
  priority?: string; // 우선순위
}

type Fetcher = (id: string) => Promise<TicketMeta | null>;
type Listener = () => void;

export interface TicketMetaStore {
  /** 캐시된 메타(없으면 undefined). 렌더 경로에서 동기 조회. */
  get(id: string): TicketMeta | undefined;
  /** lazy fetch — 이미 캐시됐거나 진행 중이면 no-op(동시 fetch 합침 = N+1 방지). */
  ensure(id: string): void;
  /** 캐시 무효화(SSE board_update). 화면에 남은 구독자가 있으면 즉시 재조회,
   *  없으면 다음 ensure 로 lazy 재조회한다. */
  invalidate(id: string): void;
  /** 이 id 의 메타 변화를 구독(카드 리렌더용). 해지 함수를 반환한다. */
  subscribe(id: string, cb: Listener): () => void;
}

export function createTicketMetaStore(fetcher: Fetcher): TicketMetaStore {
  const cache = new Map<string, TicketMeta>();
  const inflight = new Set<string>();
  const listeners = new Map<string, Set<Listener>>();

  const notify = (id: string): void => {
    const set = listeners.get(id);
    if (set) for (const cb of [...set]) cb();
  };

  const load = (id: string): void => {
    if (inflight.has(id)) return; // 동일 id 동시 fetch 합침
    inflight.add(id);
    Promise.resolve()
      .then(() => fetcher(id))
      .then(
        (meta) => {
          inflight.delete(id);
          if (meta) {
            cache.set(id, meta);
            notify(id);
          }
        },
        () => {
          // fetch 실패 → 캐시 없음(칩 미표시). 카드 본체는 그대로 뜨므로 조용히 무시.
          inflight.delete(id);
        },
      );
  };

  return {
    get: (id) => cache.get(id),
    ensure: (id) => {
      if (!cache.has(id) && !inflight.has(id)) load(id);
    },
    invalidate: (id) => {
      cache.delete(id);
      // 아직 화면에 있는 카드(구독자 존재)만 즉시 재조회 — 없으면 다음 ensure 로 lazy.
      if (listeners.get(id)?.size) load(id);
      notify(id);
    },
    subscribe: (id, cb) => {
      let set = listeners.get(id);
      if (!set) {
        set = new Set();
        listeners.set(id, set);
      }
      set.add(cb);
      return () => {
        const s = listeners.get(id);
        if (s) {
          s.delete(cb);
          if (s.size === 0) listeners.delete(id);
        }
      };
    },
  };
}
