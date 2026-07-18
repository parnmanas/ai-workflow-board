import React from 'react';
import { tokens } from '../../tokens';

/**
 * 권한 부족 안내 공통 컴포넌트 (종합 상태 설계 · F2-3 · 98d0936e).
 *
 * 관리자 전용 화면 등에서 권한이 없을 때 인라인으로 흩어져 있던 "Admin access is
 * required…" 류 문구를 단일 표현으로 수렴한다. 오류(ErrorState)가 아니라 정상적인
 * 접근 제어 결과이므로 `role="note"` 로 알린다(경보 아님).
 */
export function PermissionNotice({
  title = '접근 권한이 없습니다',
  message,
}: {
  title?: string;
  message?: string;
}) {
  return (
    <div
      role="note"
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
      <div style={{ fontSize: tokens.typography.fontSizeXl, opacity: 0.7 }} aria-hidden="true">🔒</div>
      <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.textPrimary }}>
        {title}
      </div>
      {message && (
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, lineHeight: 1.5, maxWidth: 320 }}>
          {message}
        </div>
      )}
    </div>
  );
}
