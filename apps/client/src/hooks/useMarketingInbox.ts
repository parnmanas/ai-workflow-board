import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MarketingInboxSummary } from '../types';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';

/**
 * Marketing 승인 대기 수(docs/marketing.md) — 사이드바 "Marketing" 배지와 캠페인 목록이 같은 응답을 쓴다.
 * 서버(GET /api/marketing/inbox)가 접근 가능한 계정을 합쳐 **이 사용자가 처리할 수 있는 것만** 세 주므로 화면은
 * 더하지 않는다. 처음 한 번 읽고, `marketing_update` 가 오면(사이클 한 번에 여러 개가 몰려 온다) 잠시 모았다가
 * 다시 읽는다. 동시에 마운트된 소비자(사이드바 + 목록)는 진행 중인 요청 하나를 같이 기다린다.
 */
export const MARKETING_INBOX_REFRESH_DEBOUNCE_MS = 1000;

let inflight: Promise<MarketingInboxSummary> | null = null;

function fetchInbox(): Promise<MarketingInboxSummary> {
  if (inflight) return inflight;
  inflight = api.getMarketingInbox().finally(() => { inflight = null; });
  return inflight;
}

export function useMarketingInbox(enabled: boolean): { summary: MarketingInboxSummary | null; reload(): void } {
  const [summary, setSummary] = useState<MarketingInboxSummary | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => {
    if (!enabled) return;
    const mine = ++seq.current;
    fetchInbox()
      .then((next) => { if (mine === seq.current) setSummary(next); })
      // 실패는 조용히 — 배지는 마지막으로 받은 값을 유지한다(다음 이벤트에 다시 묻는다).
      .catch(() => {});
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      seq.current += 1;
      setSummary(null);
      return;
    }
    reload();
  }, [enabled, reload]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  useBoardStreamEvent('marketing_update', () => {
    if (!enabled) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; reload(); }, MARKETING_INBOX_REFRESH_DEBOUNCE_MS);
  });

  return { summary, reload };
}
