import React from 'react';
import { tokens } from '../../tokens';
import type { ChatMessageArtifactRef } from '../../types';

/**
 * 결과물(artifact) 카드 (F2-4 ⓒ · ticket d21b28fc).
 *
 * agent-manager 가 결과물성 tool 결과(register_build_artifact·report_build_failure·
 * report_deployment)를 캡처해 message.metadata.artifact_refs 로 방출하면, MessageList 가
 * 이 카드로 렌더한다. 티켓 row 를 바꾸지 않는 이벤트라 TicketRefCard(티켓 열기)와 달리
 * 클릭 대상 티켓이 없다 — 배포 URL 이 있으면 링크, 없으면 비인터랙티브 배지다.
 *
 * 순수 프레젠테이션(부수효과·api 없음) — react-dom/server 로 상태별 마크업을 계약 검증한다.
 */
const KIND_LABEL: Record<string, string> = {
  build: '빌드',
  deploy: '배포',
};
const KIND_ICON: Record<string, string> = {
  build: '🔨',
  deploy: '🚀',
};

// 결과물 상태 → 톤. 실패는 위험, 진행 중은 무음, 성공/배포는 성공 톤.
function statusTone(status?: string): { bg: string; fg: string } {
  if (status === 'failed') return { bg: `${tokens.colors.danger}1A`, fg: tokens.colors.danger };
  if (status === 'building') return { bg: `${tokens.colors.border}60`, fg: tokens.colors.textMuted };
  return { bg: `${tokens.colors.success}22`, fg: tokens.colors.success };
}

export default function ArtifactRefCard({ artifact }: { artifact: ChatMessageArtifactRef }) {
  const { kind, title, status, commit, url } = artifact;
  const kindLabel = KIND_LABEL[kind] || kind || '결과물';
  const icon = KIND_ICON[kind] || '📦';
  const tone = statusTone(status);
  const shortCommit = commit ? commit.slice(0, 7) : '';

  const inner = (
    <>
      <span aria-hidden="true" style={{ fontSize: 12, opacity: 0.85 }}>
        {icon}
      </span>
      <span
        style={{
          fontSize: tokens.typography.fontSizeXs,
          fontWeight: 700,
          padding: '0 5px',
          borderRadius: tokens.radii.sm,
          background: `${tokens.colors.border}60`,
          color: tokens.colors.textMuted,
          flexShrink: 0,
        }}
      >
        {kindLabel}
      </span>
      <span
        style={{
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          maxWidth: 220,
        }}
      >
        {title}
      </span>
      {status && (
        <span
          data-artifact-status={status}
          style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: 700,
            padding: '0 5px',
            borderRadius: tokens.radii.sm,
            background: tone.bg,
            color: tone.fg,
            flexShrink: 0,
            whiteSpace: 'nowrap',
          }}
        >
          {status}
        </span>
      )}
      {shortCommit && (
        <span
          style={{
            fontSize: tokens.typography.fontSizeXs,
            fontFamily: 'monospace',
            color: tokens.colors.textMuted,
            flexShrink: 0,
          }}
        >
          {shortCommit}
        </span>
      )}
    </>
  );

  const baseStyle: React.CSSProperties = {
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
    color: tokens.colors.textSecondary,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    textDecoration: 'none',
    textAlign: 'left',
  };

  // 배포 URL 이 있으면 링크로, 없으면 비인터랙티브 배지로 렌더한다.
  if (url) {
    return (
      <a
        data-artifact-ref={kind}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={`${kindLabel} 결과물: ${title}${status ? ` (${status})` : ''} — 열기`}
        title={`${title}${url ? ` · ${url}` : ''}`}
        style={{ ...baseStyle, cursor: 'pointer' }}
      >
        {inner}
      </a>
    );
  }

  return (
    <span
      data-artifact-ref={kind}
      aria-label={`${kindLabel} 결과물: ${title}${status ? ` (${status})` : ''}`}
      title={title}
      style={baseStyle}
    >
      {inner}
    </span>
  );
}
