import React from 'react';
import { tokens } from '../../tokens';
import { Button } from './Button';

/**
 * 오류 상태 공통 컴포넌트 (종합 상태 설계 · F2-3 · 98d0936e).
 *
 * fetch 실패·예외를 사용자에게 알리는 표준 표현. `role="alert"` 로 보조기술에
 * 즉시 통지되며(F2-5 aria-live 심화의 기반), onRetry 가 주어지면 재시도 버튼을
 * 노출한다. 상세 message 는 원문 유지(스크린리더가 읽되 시각적으론 약하게).
 */
export function ErrorState({
  title = '문제가 발생했습니다',
  message,
  onRetry,
  retryLabel = '다시 시도',
}: {
  title?: string;
  message?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: tokens.spacing.sm,
        padding: tokens.spacing.xl,
        textAlign: 'center',
      }}
    >
      <div style={{ fontSize: tokens.typography.fontSizeLg, fontWeight: tokens.typography.fontWeightSemibold, color: tokens.colors.danger }}>
        {title}
      </div>
      {message && (
        <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.textMuted, lineHeight: 1.5, maxWidth: 320, wordBreak: 'break-word' }}>
          {message}
        </div>
      )}
      {onRetry && (
        <div style={{ marginTop: tokens.spacing.xs }}>
          <Button variant="secondary" onClick={onRetry}>{retryLabel}</Button>
        </div>
      )}
    </div>
  );
}
