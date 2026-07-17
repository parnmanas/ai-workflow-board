import React, { useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useArtifactPanel } from '../contexts/ArtifactPanelContext';
import { TicketArtifactOpenerProvider } from '../contexts/ticketArtifactOpener';
import TicketArtifact from './TicketArtifact';

/**
 * 티켓 Artifact 컨트롤러 (에픽 bf65ca00 · Phase 1 · S3).
 *
 * 티켓 카드→우측 Artifact 패널 오픈의 실제 배선. 셸(AppLayout)의 ArtifactPanelProvider
 * 하위에 마운트되어 (1) TicketRefCard 가 소비하는 오프너에 "TicketArtifact 노드를 만들어
 * openArtifact 로 여는" 실동작을 주입하고, (2) `?ticket=<id>` 딥링크를 관찰해 같은 경로로
 * 패널을 연다. 노드 생성 로직을 한 곳에 모아 카드·딥링크가 동일하게 동작하게 한다.
 */
export default function TicketArtifactController({ children }: { children: React.ReactNode }) {
  const { openArtifact } = useArtifactPanel();

  const openTicket = useCallback(
    (ticketId: string, title?: string) => {
      openArtifact({
        key: `ticket:${ticketId}`,
        title: title || '티켓',
        node: <TicketArtifact ticketId={ticketId} />,
      });
    },
    [openArtifact],
  );

  // `?ticket=<id>` 딥링크 → 패널 오픈 후 파라미터 제거(뒤로가기 재발화 방지).
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const ticketId = searchParams.get('ticket');
    if (!ticketId) return;
    openTicket(ticketId);
    const next = new URLSearchParams(searchParams);
    next.delete('ticket');
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams, openTicket]);

  return <TicketArtifactOpenerProvider value={openTicket}>{children}</TicketArtifactOpenerProvider>;
}
