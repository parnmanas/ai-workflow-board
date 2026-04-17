import React, { useState } from 'react';
import { tokens } from '../../../tokens';

// ─── renderMarkdown — XSS-safe inline markdown ───────────────────────────────
// T-07-12: No dangerouslySetInnerHTML. React JSX element construction only.
// URL scheme validation: only http:// and https:// are allowed in <a> href.
// Phase 8: @mention tokens rendered as accent-colored pills (CHAT-17).

const ROLE_SHORTCUTS = new Set(['reviewer', 'assignee', 'reporter']);

export interface MentionParticipant {
  id: string;
  name: string;
  type: string;
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
            fontSize: 13,
            background: tokens.colors.surfaceCard,
            padding: '1px 4px',
            borderRadius: tokens.radii.xs,
          }}
        >
          {code}
        </code>,
      );
    } else {
      // Step 1b: Split on @mention tokens before applying other formatting
      const mentionParts = part.split(/(@[a-zA-Z0-9_-]+)/g);
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
            // Render as pill: agent = accentSubtle bg, user/role = accentPale bg
            const bgColor = isAgent ? 'rgba(99,102,241,0.15)' : 'rgba(99,102,241,0.12)';
            const textColor = isAgent ? tokens.colors.accentSubtle : tokens.colors.accentPale;
            nodes.push(
              <span
                key={keyIdx++}
                aria-label={`Mention: ${mp}`}
                style={{
                  background: bgColor,
                  color: textColor,
                  borderRadius: tokens.radii.sm,
                  padding: '0 4px',
                  display: 'inline',
                }}
              >
                {mp}
              </span>,
            );
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
