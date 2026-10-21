import React from 'react';
import { tokens } from '../tokens';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
}

export default function PageHeader({ title, description, actions }: PageHeaderProps) {
  return (
    <header
      className="awb-page-header"
      style={{
        background: tokens.gradients.surfaceCard,
        borderBottom: `1px solid ${tokens.colors.border}`,
        padding: '16px 24px',
        display: 'flex',
        alignItems: 'center',
        // 제목이 240px 를 못 받으면 액션 묶음이 다음 줄로 내려간다. 사이드바가 보이는 태블릿 폭(본문 480~812px)은
        // 모바일 규칙(≤767px)에 걸리지 않아, 줄바꿈이 없던 동안 액션이 많은 화면(미션)의 제목이 한 글자 폭으로 눌렸다.
        flexWrap: 'wrap',
        gap: '10px 16px',
        flexShrink: 0,
      }}
    >
      <div style={{ minWidth: 0, flex: '1 1 240px' }}>
        <h1 style={{ fontSize: '16px', fontWeight: 700, color: tokens.colors.textPrimary, margin: 0 }}>{title}</h1>
        {description && (
          <p style={{ fontSize: '11px', color: tokens.colors.textSecondary, margin: '2px 0 0 0' }}>{description}</p>
        )}
      </div>
      {actions && (
        <div className="awb-page-actions" style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}
    </header>
  );
}
