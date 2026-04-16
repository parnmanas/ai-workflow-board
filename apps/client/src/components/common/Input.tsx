import React, { useState } from 'react';
import { tokens } from '../../tokens';

interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'> {
  label?: string;
  error?: string;
}

export function Input({ label, error, disabled, onFocus, onBlur, ...rest }: InputProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  const borderColor = error
    ? tokens.colors.danger
    : isFocused
    ? tokens.colors.accent
    : tokens.colors.border;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
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
      <input
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
          fontFamily: 'inherit',
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
