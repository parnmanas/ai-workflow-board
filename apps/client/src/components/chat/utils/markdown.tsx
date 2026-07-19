import React, { useState } from 'react';
import { tokens } from '../../../tokens';
import TicketRefCard from '../TicketRefCard';

// ─── renderMarkdown — XSS-safe inline markdown ───────────────────────────────
// T-07-12: No dangerouslySetInnerHTML. React JSX element construction only.
// URL scheme validation: only http:// and https:// are allowed in <a> href.
// Mentions: structured tokens `@[user|agent|role:id|display]` render as pills
// (authoritative — id is attached). Bare `@name` tokens render as plain text;
// they are no longer a dispatch surface server-side.
// Ticket refs (에픽 bf65ca00 · S2): `@[ticket:id|title]` render as interactive
// cards (TicketRefCard) — click opens the ticket in the right Artifact panel.
// Same content-token mechanism as mentions (마이그레이션 0, 확장 not 분기 복제).

const ROLE_SHORTCUTS = new Set(['reviewer', 'assignee', 'reporter']);
const STRUCTURED_TOKEN_RE = /@\[(user|agent|role|ticket):([\w-]+)(?:\|([^\]]*))?\]/g;

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

export function renderMarkdown(text: string, participants?: MentionParticipant[]): React.ReactNode[] {
  if (!text) return [];

  // Step 1: Split on backtick code spans
  const parts = text.split(/(`[^`]*`)/g);
  const nodes: React.ReactNode[] = [];
  let keyIdx = 0;

  for (const part of parts) {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 1) {
      // Code span
      const code = part.slice(1, -1);
      nodes.push(
        <code
          key={keyIdx++}
          style={{
            fontFamily: 'monospace',
            fontSize: tokens.typography.fontSizeMd,
            background: tokens.colors.surfaceCard,
            padding: '1px 4px',
            borderRadius: tokens.radii.xs,
          }}
        >
          {code}
        </code>,
      );
    } else {
      // Step 1a: First, split out structured mention tokens. These are
      // authoritative (they ship an ID), so they render as pills regardless
      // of whether the name collides with another entity.
      const structuredParts: Array<{
        token: string;
        pill?: { variant: 'agent' | 'user' | 'role'; display: string };
        ticket?: { id: string; title: string };
      }> = [];
      let cursor = 0;
      STRUCTURED_TOKEN_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = STRUCTURED_TOKEN_RE.exec(part)) !== null) {
        if (m.index > cursor) {
          structuredParts.push({ token: part.slice(cursor, m.index) });
        }
        const type = m[1] as 'user' | 'agent' | 'role' | 'ticket';
        const rawId = m[2];
        const display = m[3];
        if (type === 'ticket') {
          // 티켓 참조 → 인터랙티브 카드. title 이 없으면 id 를 라벨로 폴백.
          structuredParts.push({ token: m[0], ticket: { id: rawId, title: display || rawId } });
        } else {
          structuredParts.push({ token: m[0], pill: { variant: type, display: `@${display || rawId}` } });
        }
        cursor = m.index + m[0].length;
      }
      if (cursor < part.length) {
        structuredParts.push({ token: part.slice(cursor) });
      }
      if (structuredParts.length === 0) structuredParts.push({ token: part });

      for (const sp of structuredParts) {
        if (sp.ticket) {
          nodes.push(<TicketRefCard key={keyIdx++} id={sp.ticket.id} title={sp.ticket.title} />);
          continue;
        }
        if (sp.pill) {
          nodes.push(renderMentionPill(sp.pill.display, sp.pill.variant, keyIdx++, sp.token));
          continue;
        }

      // Step 1b: Split on bare @mention tokens. After the structured-token
      // migration these are legacy or unresolvable — render as muted text
      // unless a participant/role shortcut matches (kept for backward compat).
      const mentionParts = sp.token.split(/(@[a-zA-Z0-9_-]+)/g);
      for (const mp of mentionParts) {
        if (mp.startsWith('@') && mp.length > 1) {
          const name = mp.slice(1);
          const lower = name.toLowerCase();
          const isRoleShortcut = ROLE_SHORTCUTS.has(lower);
          const matchedParticipant = participants?.find(
            (p) => p.name.toLowerCase() === lower,
          );
          const isAgent = matchedParticipant?.type === 'agent';
          const isResolved = isRoleShortcut || !!matchedParticipant;

          if (isResolved) {
            nodes.push(renderMentionPill(mp, isAgent ? 'agent' : 'user', keyIdx++));
          } else {
            // Unresolved mention: plain muted text
            nodes.push(
              <span key={keyIdx++} style={{ color: tokens.colors.textSecondary }}>{mp}</span>,
            );
          }
          continue;
        }

        // Step 2: Apply bold, italic, links to non-mention, non-code segments
        const segments = mp.split(/(\*\*[^*]+\*\*|\*[^*]+\*|https?:\/\/[^\s]+)/g);
        for (const seg of segments) {
          if (!seg) continue;
          if (seg.startsWith('**') && seg.endsWith('**') && seg.length > 4) {
            nodes.push(
              <strong key={keyIdx++} style={{ fontWeight: 600 }}>
                {seg.slice(2, -2)}
              </strong>,
            );
          } else if (seg.startsWith('*') && seg.endsWith('*') && seg.length > 2) {
            nodes.push(<em key={keyIdx++}>{seg.slice(1, -1)}</em>);
          } else if (/^https?:\/\//.test(seg)) {
            // T-07-12: Only allow http/https — reject javascript: and data: schemes
            nodes.push(
              <InlineLink key={keyIdx++} href={seg} />,
            );
          } else {
            nodes.push(<React.Fragment key={keyIdx++}>{seg}</React.Fragment>);
          }
        }
      }
      }
    }
  }

  return nodes;
}

// Separate component to hold hover state for link underline without global CSS
function InlineLink({ href }: { href: string }) {
  const [hovered, setHovered] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        color: tokens.colors.accent,
        textDecoration: hovered ? 'underline' : 'none',
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {href}
    </a>
  );
}
