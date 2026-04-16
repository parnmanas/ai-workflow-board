import React from 'react';
import { tokens } from '../../tokens';

interface BadgeProps {
  variant?: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  size?: 'sm' | 'md';
  dot?: boolean;
  children?: React.ReactNode;
}

const variantPillStyles: Record<string, React.CSSProperties> = {
  success: {
    background: `${tokens.colors.successBg}30`,
    color: tokens.colors.successLight,
  },
  danger: {
    background: `${tokens.colors.dangerBg}30`,
    color: tokens.colors.dangerLight,
  },
  warning: {
    background: `${tokens.colors.warningBg}30`,
    color: tokens.colors.warningLight,
  },
  info: {
    background: `${tokens.colors.accent}20`,
    color: tokens.colors.accentLight,
  },
  neutral: {
    background: `${tokens.colors.border}40`,
    color: tokens.colors.textSecondary,
  },
};

const variantDotColors: Record<string, string> = {
  success: tokens.colors.successLight,
  danger: tokens.colors.dangerLight,
  warning: tokens.colors.warningLight,
  info: tokens.colors.accentLight,
  neutral: tokens.colors.textMuted,
};

export function Badge({ variant = 'neutral', size = 'md', dot, children }: BadgeProps) {
  const isDot = dot || size === 'sm';

  if (isDot) {
    return (
      <span
        style={{
          width: 8,
          height: 8,
          borderRadius: tokens.radii.full,
          background: variantDotColors[variant],
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    );
  }

  return (
    <span
      style={{
        fontSize: tokens.typography.fontSizeXs,
        fontWeight: tokens.typography.fontWeightSemibold,
        padding: '2px 8px',
        borderRadius: tokens.radii.sm,
        textTransform: 'uppercase',
        display: 'inline-block',
        lineHeight: tokens.typography.lineHeightCaption,
        ...variantPillStyles[variant],
      }}
    >
      {children}
    </span>
  );
}
