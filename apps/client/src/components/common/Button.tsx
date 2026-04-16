import React, { useState } from 'react';
import { tokens } from '../../tokens';

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
}

const variantStyles: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  primary: {
    background: tokens.gradients.accent,
    color: 'white',
    border: 'none',
  },
  secondary: {
    background: tokens.colors.surface,
    color: tokens.colors.textSecondary,
    border: `1px solid ${tokens.colors.border}`,
  },
  danger: {
    background: tokens.colors.dangerBg,
    color: tokens.colors.dangerLight,
    border: 'none',
  },
  ghost: {
    background: 'transparent',
    color: tokens.colors.textSecondary,
    border: 'none',
  },
};

const variantHoverStyles: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
  primary: {
    filter: 'brightness(1.1)',
  },
  secondary: {
    background: tokens.colors.surfaceHover,
  },
  danger: {
    background: tokens.colors.danger,
  },
  ghost: {
    background: tokens.colors.surfaceHover,
  },
};

const sizeStyles: Record<NonNullable<ButtonProps['size']>, React.CSSProperties> = {
  sm: {
    padding: '4px 10px',
    fontSize: tokens.typography.fontSizeXs,
  },
  md: {
    padding: '6px 14px',
    fontSize: tokens.typography.fontSizeMd,
  },
  lg: {
    padding: '8px 18px',
    fontSize: tokens.typography.fontSizeLg,
  },
};

const spinnerStyle: React.CSSProperties = {
  display: 'inline-block',
  width: 14,
  height: 14,
  border: '2px solid currentColor',
  borderTopColor: 'transparent',
  borderRadius: '50%',
  animation: 'button-spin 0.6s linear infinite',
};

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled,
  children,
  onMouseEnter,
  onMouseLeave,
  style,
  ...rest
}: ButtonProps) {
  const [isHovered, setIsHovered] = useState(false);

  const isDisabled = disabled || loading;

  const baseStyle: React.CSSProperties = {
    borderRadius: tokens.radii.md,
    fontWeight: tokens.typography.fontWeightSemibold,
    cursor: 'pointer',
    fontFamily: 'inherit',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: tokens.spacing.xs,
    transition: 'background 0.15s, filter 0.15s, opacity 0.15s',
    ...variantStyles[variant],
    ...sizeStyles[size],
    ...(isHovered && !isDisabled ? variantHoverStyles[variant] : {}),
    ...(isDisabled ? { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' } : {}),
    ...style,
  };

  return (
    <>
      <style>{`@keyframes button-spin { to { transform: rotate(360deg); } }`}</style>
      <button
        disabled={isDisabled}
        style={baseStyle}
        onMouseEnter={(e) => {
          setIsHovered(true);
          onMouseEnter?.(e);
        }}
        onMouseLeave={(e) => {
          setIsHovered(false);
          onMouseLeave?.(e);
        }}
        {...rest}
      >
        {loading && <span style={spinnerStyle} aria-hidden="true" />}
        {children}
      </button>
    </>
  );
}
