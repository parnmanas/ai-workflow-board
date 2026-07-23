import React, { useState } from 'react';
import { tokens } from '../../tokens';
import { useOpenArtifactPanel } from '../../contexts/ArtifactPanelContext';
import BoardArtifact from '../BoardArtifact';

/**
 * 보드 현황 참조 카드 (F-3 · ticket 3ca88253).
 *
 * 채팅에서 "보드 상황 알려줘" 류 질문에 agent-manager 가 get_board_summary 결과를
 * 캡처해 message.metadata.board_refs 로 방출하면, MessageList 가 이 카드로 렌더한다.
 * AgentRefCard 와 동일한 패턴 — id(+title)만 들고 있고, 클릭하면 우측 Artifact 패널에
 * BoardArtifact 가 열려 실제 보드 화면과 같은 데이터(GET /api/boards/:id)를 다시
 * fetch 해서 컬럼/티켓 구조로 보여준다. useOpenArtifactPanel() 을 쓰는 이유(SSR 안전)는
 * AgentRefCard 와 동일.
 */
export default function BoardRefCard({ id, title }: { id: string; title?: string }) {
  const openArtifact = useOpenArtifactPanel();
  const [hover, setHover] = useState(false);

  const label = title || '보드';

  const handleOpen = () => {
    openArtifact({
      key: `board:${id}`,
      title: label,
      node: <BoardArtifact boardId={id} />,
    });
  };

  return (
    <button
      type="button"
      data-board-ref={id}
      onClick={handleOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`보드 현황 열기: ${label}`}
      title={label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        verticalAlign: 'baseline',
        maxWidth: '100%',
        margin: '0 1px',
        padding: '1px 8px 1px 6px',
        fontFamily: 'inherit',
        fontSize: tokens.typography.fontSizeMd,
        fontWeight: 600,
        lineHeight: 1.4,
        color: tokens.colors.accentSubtle,
        background: hover ? tokens.overlays.accentStrong : tokens.overlays.accentSoft,
        border: `1px solid ${hover ? tokens.colors.accent : 'rgba(99,102,241,0.30)'}`,
        borderRadius: tokens.radii.md,
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.85 }}>📊</span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 220,
        }}
      >
        {label}
      </span>
    </button>
  );
}
