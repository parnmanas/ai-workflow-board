import type React from 'react';
import { tokens } from '../../tokens';

// Shared look of the ticket detail panel. Every layout rule here has to hold
// from a phone-width drawer up to a wide split pane: grids auto-fit instead of
// fixing column counts, and long text wraps instead of widening the panel.

/** Small caps label above a field. */
export const fieldLabel: React.CSSProperties = {
  fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
  textTransform: 'uppercase', letterSpacing: 0.3, display: 'block', marginBottom: 4,
};

/** Two columns when the panel has room, one when it does not. */
export const fieldGrid: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 180px), 1fr))',
  gap: 12,
};

/** Vertical rhythm between panel sections. */
export const section: React.CSSProperties = { marginBottom: 16, minWidth: 0 };

export const controlStyle: React.CSSProperties = {
  width: '100%', boxSizing: 'border-box', minWidth: 0,
  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md, padding: '6px 8px',
  color: tokens.colors.textStrong, fontSize: '12px', fontFamily: 'inherit',
};

/** Text that may contain unbroken URLs, ids or code. */
export const wrapText: React.CSSProperties = {
  overflowWrap: 'anywhere', wordBreak: 'break-word', minWidth: 0,
};

export type PanelButtonVariant = 'primary' | 'plain' | 'danger' | 'success' | 'warning';

export function panelButton(variant: PanelButtonVariant, disabled = false): React.CSSProperties {
  const palette: Record<PanelButtonVariant, { bg: string; fg: string; border: string }> = {
    primary: { bg: tokens.colors.accent, fg: 'white', border: tokens.colors.accent },
    plain: { bg: tokens.colors.surfaceCard, fg: tokens.colors.textSecondary, border: tokens.colors.border },
    danger: { bg: tokens.colors.dangerBg, fg: tokens.colors.dangerLight, border: tokens.colors.danger },
    success: { bg: tokens.colors.successBg, fg: tokens.colors.successLight, border: tokens.colors.successLight },
    warning: { bg: tokens.colors.warningBg, fg: tokens.colors.warningLight, border: tokens.colors.warning },
  };
  const p = palette[variant];
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 4,
    background: p.bg, color: p.fg, border: `1px solid ${p.border}`,
    borderRadius: tokens.radii.md, padding: '5px 12px',
    fontSize: '12px', fontWeight: 600, fontFamily: 'inherit', whiteSpace: 'nowrap',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.55 : 1,
  };
}
