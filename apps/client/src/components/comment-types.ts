import { CommentType } from '../types';
import { tokens } from '../tokens';

// Visual contract for the typed-comment timeline. Single source of truth so
// CommentList rendering, filter chips, and the compose type-selector all stay
// in sync. Adding a new CommentType only requires registering it here.
export interface CommentTypeStyle {
  label: string;
  icon: string;       // single-character glyph; cheap and resolution-independent
  border: string;     // left-edge accent color
  bg: string;         // subtle surface tint behind the row
  text: string;       // chip / icon text color
  // Whether the chip is on by default in the filter bar. System rows are noisy
  // so they stay off; the rest stay on.
  defaultVisible: boolean;
  // Whether this type is selectable in the compose type-selector. Reserved
  // types ('system', 'answer', 'handoff') are excluded — system is server-only,
  // 'answer' requires reply-context (Phase 3), 'handoff' is agent-only.
  composable: boolean;
}

export const COMMENT_TYPE_STYLES: Record<CommentType, CommentTypeStyle> = {
  note: {
    label: 'Note',
    icon: '\u00B7',
    border: tokens.colors.border,
    bg: tokens.colors.surface,
    text: tokens.colors.textDisabled,
    defaultVisible: true,
    composable: true,
  },
  question: {
    label: 'Question',
    icon: '?',
    border: tokens.colors.warning,
    bg: tokens.colors.surfaceSubtle,
    text: tokens.colors.warningLight,
    defaultVisible: true,
    composable: true,
  },
  answer: {
    label: 'Answer',
    icon: '\u2192',
    border: tokens.colors.info,
    bg: tokens.colors.surfaceSubtle,
    text: tokens.colors.infoLight,
    defaultVisible: true,
    composable: false,
  },
  decision: {
    label: 'Decision',
    icon: '\u2605',
    border: tokens.colors.success,
    bg: tokens.colors.surfaceSubtle,
    text: tokens.colors.successLight,
    defaultVisible: true,
    composable: true,
  },
  chat: {
    label: 'Chat',
    icon: '\u00B7',
    border: tokens.colors.accentMid,
    bg: tokens.colors.surface,
    text: tokens.colors.accentPale,
    defaultVisible: true,
    composable: true,
  },
  system: {
    label: 'System',
    icon: '\u2699',
    border: tokens.colors.badgeSystemBorder,
    bg: tokens.colors.badgeSystemSurface,
    text: tokens.colors.badgeSystemText,
    defaultVisible: false,
    composable: false,
  },
  handoff: {
    label: 'Handoff',
    icon: '\u21C4',
    border: tokens.colors.accentViolet,
    bg: tokens.colors.surfaceSubtle,
    text: tokens.colors.accentLight,
    defaultVisible: true,
    composable: false,
  },
};

export const ALL_COMMENT_TYPES: CommentType[] = ['note', 'question', 'answer', 'decision', 'chat', 'handoff', 'system'];

export function defaultVisibleTypes(): Set<CommentType> {
  return new Set(ALL_COMMENT_TYPES.filter(t => COMMENT_TYPE_STYLES[t].defaultVisible));
}

// Returns the safe-fallback type for legacy rows that may not yet have a value.
export function resolveCommentType(raw: string | null | undefined): CommentType {
  if (raw && (raw in COMMENT_TYPE_STYLES)) return raw as CommentType;
  return 'note';
}
