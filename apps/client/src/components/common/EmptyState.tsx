import React from 'react';
import { tokens } from '../../tokens';

/**
 * 빈 상태 공통 컴포넌트 (종합 상태 설계 · F2-3 · 98d0936e).
 *
 * 목록·패널이 "표시할 항목 없음"을 알릴 때 쓰는 중립 표현. 오류(ErrorState)·권한
 * (PermissionNotice)과 달리 경보 시맨틱이 없다 — 조용한 안내 문구 + 선택적 액션.
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
}: {
  title: string;
  description?: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing.sm,
        padding: tokens.spacing.xl,
        textAlign: 'center',
        color: tokens.colors.textSecondary,
      }}
    >
      {icon && <div style={{ fontSize: tokens.typography.fontSizeXl, opacity: 0.7 }}>{icon}</div>}
      <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textPrimary }}>
        {title}
      </div>
      {description && (
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, lineHeight: 1.5, maxWidth: 320 }}>
          {description}
        </div>
      )}
      {action && <div style={{ marginTop: tokens.spacing.xs }}>{action}</div>}
    </div>
  );
}
