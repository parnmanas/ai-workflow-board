import React from 'react';
import { tokens } from '../../tokens';
import TicketRefCard from '../chat/TicketRefCard';
import ResolvedArtifactRef from '../chat/ResolvedArtifactRef';
import { ARTIFACT_TOKEN_RE, type ArtifactRefType } from '../../utils/artifactRef';

const ROLE_SHORTCUTS = new Set(['reviewer', 'assignee', 'reporter']);
const ARTIFACT_REF = new RegExp(`^${ARTIFACT_TOKEN_RE.source}$`);
const STRUCTURED_REF = /^@\[(user|agent|role|ticket):([\w-]+)(?:\|([^\]]*))?\]$/;

export interface MentionParticipant {
  id: string;
  name: string;
  type: string;
}

function renderMentionPill(
  display: string,
  variant: 'agent' | 'user' | 'role',
  key: number,
  raw?: string,
): React.ReactNode {
  // agent = stronger tint; user/role = softer
  const bgColor = variant === 'agent' ? tokens.overlays.accentTint : tokens.overlays.accentSoft;
  const textColor = variant === 'agent' ? tokens.colors.accentSubtle : tokens.colors.accentPale;
  return (
    <span
      key={key}
      aria-label={`Mention: ${display}`}
      // data-mention-raw lets handleMentionAwareCopy swap the visible "@Name"
      // back to the structured `@[type:id|Name]` token on copy, so pasted
      // text is round-trippable through MentionTextarea.
      data-mention-raw={raw}
      style={{
        background: bgColor,
        color: textColor,
        borderRadius: tokens.radii.sm,
        padding: '0 4px',
        display: 'inline',
      }}
    >
      {display}
    </span>
  );
}

/**
 * Clipboard handler for any container that renders mention pills via
 * `renderMarkdown`. Rewrites selected pill spans to their structured
 * `@[type:id|Name]` form so users pasting a copied comment/message
 * preserve dispatchable mention tokens instead of losing them to plain
 * `@Name` text.
 *
 * No-op when the selection contains no pill spans — we only preventDefault
 * and rewrite when a swap is actually needed, so plain-text copy stays
 * plain.
 */
export function handleMentionAwareCopy(e: React.ClipboardEvent<HTMLElement>): void {
  const selection = typeof window !== 'undefined' ? window.getSelection() : null;
  if (!selection || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const fragment = range.cloneContents();
  const host = document.createElement('div');
  host.appendChild(fragment);
  const pills = host.querySelectorAll('[data-mention-raw]');
  if (pills.length === 0) return;
  pills.forEach((el) => {
    const raw = el.getAttribute('data-mention-raw');
    if (raw) el.textContent = raw;
  });
  e.clipboardData.setData('text/plain', host.innerText);
  e.preventDefault();
}

/** Render only AWB references; all Markdown parsing belongs to Markdown.tsx. */
export function renderMarkdownRef(raw: string, participants?: MentionParticipant[]): React.ReactNode {
  const artifact = ARTIFACT_REF.exec(raw);
  if (artifact) return <ResolvedArtifactRef type={artifact[1] as ArtifactRefType} id={artifact[2]} claimedLabel={artifact[3]} />;
  const structured = STRUCTURED_REF.exec(raw);
  if (structured) {
    const [, type, id, display] = structured;
    if (type === 'ticket') return <TicketRefCard id={id} title={display || id} />;
    return renderMentionPill(`@${display || id}`, type as 'agent' | 'user' | 'role', 0, raw);
  }
  const name = raw.slice(1).toLowerCase();
  const participant = participants?.find(p => p.name.toLowerCase() === name);
  if (participant || ROLE_SHORTCUTS.has(name)) return renderMentionPill(raw, participant?.type === 'agent' ? 'agent' : 'user', 0);
  return <span style={{ color: tokens.colors.textSecondary }}>{raw}</span>;
}
