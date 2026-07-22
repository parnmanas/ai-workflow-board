import React, { useState } from 'react';
import { tokens } from '../../tokens';
import { useOpenArtifactPanel } from '../../contexts/ArtifactPanelContext';
import AgentArtifact from '../AgentArtifact';

/**
 * Agent 상태 참조 카드 (F-3 · ticket 3ca88253).
 *
 * 채팅에서 "이 티켓 개발자 뭐하고 있어?" 류 질문에 agent-manager 가 get_agent 결과를
 * 캡처해 message.metadata.agent_refs 로 방출하면, MessageList 가 이 카드로 렌더한다.
 * TicketRefCard 와 동일한 패턴: 카드 자체는 id(+표시용 name)만 들고 있고, 클릭하면
 * 우측 Artifact 패널에 AgentArtifact 가 열려 AI Agents 화면과 동일한 최신 상세를
 * 다시 fetch 해서 보여준다. 새 오프너 컨텍스트는 만들지 않는다 — ArtifactPanelContext
 * 가 노출하는 useOpenArtifactPanel() (openArtifact 전용 안전 접근자)을 바로 쓴다.
 * useArtifactPanel() 은 프로바이더 밖에서 throw 하므로 직접 쓰면 안 된다 — 이 카드는
 * TicketRefCard 처럼 채팅 메시지 트리 여러 곳에 흩어져 렌더되는 리프 컴포넌트라
 * SSR 계약 테스트를 포함한 어느 표면에서도 안전히 렌더돼야 한다.
 */
export default function AgentRefCard({ id, name }: { id: string; name?: string }) {
  const openArtifact = useOpenArtifactPanel();
  const [hover, setHover] = useState(false);

  const label = name || 'Agent';

  const handleOpen = () => {
    openArtifact({
      key: `agent:${id}`,
      title: label,
      node: <AgentArtifact agentId={id} />,
    });
  };

  return (
    <button
      type="button"
      data-agent-ref={id}
      onClick={handleOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      aria-label={`Agent 상세 열기: ${label}`}
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
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.85 }}>🤖</span>
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
