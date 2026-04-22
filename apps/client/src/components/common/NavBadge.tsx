import React from 'react';
import { tokens } from '../../tokens';

/**
 * Small red count badge shown on sidebar nav items, tab buttons, etc.
 *
 * - count === 0 renders nothing (returns null so callers don't need a
 *   conditional wrapper).
 * - count > max renders `${max}+` so a 247-notif inbox doesn't blow out
 *   the nav line height.
 * - `dot` forces a simple dot indicator regardless of count — useful when
 *   the exact number doesn't matter (e.g. "there's something here").
 */
export interface NavBadgeProps {
  count?: number;
  max?: number;
  dot?: boolean;
  // Override variant when we want non-red (e.g. admin-warn style).
  variant?: 'danger' | 'warning' | 'info';
  // Inline-adjust size for tiny spots (nav icon corner vs. a wider row).
  size?: 'sm' | 'md';
}

const variantStyles: Record<NonNullable<NavBadgeProps['variant']>, { bg: string; fg: string }> = {
  danger: { bg: tokens.colors.dangerMid, fg: '#fff' },
  warning: { bg: tokens.colors.warningLight, fg: '#000' },
  info: { bg: tokens.colors.accent, fg: '#fff' },
};

export function NavBadge({
  count = 0,
  max = 99,
  dot,
  variant = 'danger',
  size = 'md',
}: NavBadgeProps) {
  if (!dot && count <= 0) return null;
  const colors = variantStyles[variant];
  if (dot) {
    return (
      <span
        aria-hidden
        style={{
          width: size === 'sm' ? 6 : 8,
          height: size === 'sm' ? 6 : 8,
          borderRadius: tokens.radii.full,
          background: colors.bg,
          display: 'inline-block',
          flexShrink: 0,
        }}
      />
    );
  }
  const label = count > max ? `${max}+` : String(count);
  return (
    <span
      aria-label={`${count} unread`}
      style={{
        minWidth: size === 'sm' ? 14 : 16,
        height: size === 'sm' ? 14 : 16,
        padding: '0 5px',
        borderRadius: tokens.radii.full,
        background: colors.bg,
        color: colors.fg,
        fontSize: size === 'sm' ? 9 : 10,
        fontWeight: 700,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 1,
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}
