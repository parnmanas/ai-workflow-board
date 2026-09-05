import React, { useState } from 'react';
import { tokens } from '../../tokens';

interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  /** 코드/JSON 입력용 고정폭 글꼴. 기본 false. */
  monospace?: boolean;
}

/**
 * 여러 줄 입력 공통 컴포넌트. Input 과 같은 라벨·포커스·오류 표현을 쓰되
 * 세로 리사이즈만 허용해 가로 넘침을 만들지 않는다(티켓 e616dbfc — 관리 화면이
 * 저마다 인라인 style 로 textarea 를 그리던 것을 여기로 모았다).
 */
export function Textarea({ label, error, disabled, monospace, onFocus, onBlur, ...rest }: TextareaProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLTextAreaElement>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  const borderColor = error
    ? tokens.colors.danger
    : isFocused
    ? tokens.colors.accent
    : tokens.colors.border;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
      {label && (
        <label
          style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: tokens.typography.fontWeightSemibold,
            color: tokens.colors.textMuted,
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: tokens.spacing.xs,
          }}
        >
          {label}
        </label>
      )}
      <textarea
        disabled={disabled}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={{
          background: tokens.colors.surface,
          border: `1px solid ${borderColor}`,
          borderRadius: tokens.radii.md,
          padding: '8px 10px',
          color: tokens.colors.textStrong,
          fontSize: tokens.typography.fontSizeMd,
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
          // 가로 리사이즈를 막아 좁은 폭에서 컨테이너를 밀어내지 않게 한다.
          resize: 'vertical',
          fontFamily: monospace ? 'monospace' : 'inherit',
          opacity: disabled ? 0.5 : 1,
          cursor: disabled ? 'not-allowed' : 'text',
          transition: 'border-color 0.15s ease',
        }}
        {...rest}
      />
      {error && (
        <span
          style={{
            fontSize: tokens.typography.fontSizeXs,
            color: tokens.colors.danger,
            marginTop: tokens.spacing.xs,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
