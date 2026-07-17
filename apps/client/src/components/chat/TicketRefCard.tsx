import React, { useState } from 'react';
import { tokens } from '../../tokens';
import { useOpenTicketArtifact } from '../../contexts/ticketArtifactOpener';

/**
 * 티켓 참조 카드 (에픽 bf65ca00 · Phase 1 · S2).
 *
 * 채팅/코멘트 본문의 `@[ticket:<id>|title]` 토큰이 renderMarkdown 을 통해 이 카드로
 * 렌더된다(멘션 pill 선례 확장, 마이그레이션 0). 어시스턴트가 티켓을 만들거나 참조하면
 * 답장 안에서 인터랙티브 카드로 나타나고, 클릭 시 우측 Artifact 패널에 상세가 열린다(S3).
 *
 * 오프너는 useOpenTicketArtifact() 로 주입받는다 — 프로바이더 밖에서는 no-op 이라
 * 어느 표면(SSR 계약 테스트 포함)에서도 안전하게 렌더된다. 카드 자체는 api 를 모른다.
 */
export default function TicketRefCard({ id, title }: { id: string; title: string }) {
  const openTicket = useOpenTicketArtifact();
  const [hover, setHover] = useState(false);

  const label = title || '티켓';

  return (
    <button
      type="button"
      data-ticket-ref={id}
      onClick={() => openTicket(id, title)}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`티켓 열기: ${label}`}
      title={label}
      style={{
        // 메시지 텍스트 흐름 안에 자연스럽게 놓이는 인라인 카드.
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        verticalAlign: 'baseline',
        maxWidth: '100%',
        margin: '0 1px',
        padding: '1px 8px 1px 6px',
        fontFamily: 'inherit',
        fontSize: 13,
        fontWeight: 600,
        lineHeight: 1.4,
        color: tokens.colors.accentSubtle,
        background: hover ? 'rgba(99,102,241,0.20)' : 'rgba(99,102,241,0.12)',
        border: `1px solid ${hover ? tokens.colors.accent : 'rgba(99,102,241,0.30)'}`,
        borderRadius: tokens.radii.md,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.85 }}>
        {'🎫'}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 260,
        }}
      >
        {label}
      </span>
    </button>
  );
}
