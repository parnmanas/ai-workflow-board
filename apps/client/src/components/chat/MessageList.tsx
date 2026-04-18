import React, { useState, useEffect } from 'react';
import { tokens } from '../../tokens';
import type { ChatRoomMessageItem } from '../../types';
import { formatClockTime, daySeparatorLabel, sameDay } from './utils/time';
import { renderMarkdown, handleMentionAwareCopy, type MentionParticipant } from './utils/markdown';

// ─── Style constants (mirror ChatPage.tsx COLORS) ────────────────────────────

const COLORS = {
  dominant: tokens.colors.surface,
  secondary: tokens.colors.surfaceCard,
  accent: tokens.colors.accent,
  border: tokens.colors.border,
  textPrimary: tokens.colors.textPrimary,
  textSecondary: tokens.colors.textSecondary,
  textMuted: tokens.colors.borderStrong,
  destructive: tokens.colors.danger,
  agentName: tokens.colors.accentSubtle,
};

// ─── MessageList ──────────────────────────────────────────────────────────────

export interface MessageListProps {
  messages: ChatRoomMessageItem[];
  participantCount: number;
  participants?: MentionParticipant[];
  currentUserId?: string;
}

export default function MessageList({ messages, participantCount, participants = [], currentUserId }: MessageListProps) {
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Close lightbox on Escape key
  useEffect(() => {
    if (!lightboxImage) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxImage(null);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightboxImage]);

  const rendered: React.ReactNode[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const prev = i > 0 ? messages[i - 1] : null;

    // Day separator
    if (!prev || !sameDay(prev.created_at, msg.created_at)) {
      const label = daySeparatorLabel(msg.created_at);
      rendered.push(
        <div
          key={`day-${msg.id}`}
          role="separator"
          aria-label={label}
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '16px 16px',
            gap: 12,
          }}
        >
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
          <span
            style={{
              fontSize: 11,
              color: COLORS.textMuted,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          <div style={{ flex: 1, height: 1, background: COLORS.border }} />
        </div>,
      );
    }

    // Collapse sender info if same sender within 60s
    const prevSameWindow =
      prev &&
      prev.sender_id === msg.sender_id &&
      sameDay(prev.created_at, msg.created_at) &&
      new Date(msg.created_at).getTime() - new Date(prev.created_at).getTime() < 60000;

    const isAgent = msg.sender_type === 'agent';
    const isLast = i === messages.length - 1;

    // Parse images JSON (stored as string from server)
    let msgImages: Array<{ data: string; filename: string; mimetype: string }> = [];
    if (msg.images) {
      try {
        const parsed = typeof msg.images === 'string' ? JSON.parse(msg.images) : msg.images;
        if (Array.isArray(parsed)) msgImages = parsed;
      } catch {
        // malformed images field — skip silently
      }
    }

    const isMe = msg.sender_type === 'user' && msg.sender_id === currentUserId;

    rendered.push(
      <div
        key={msg.id}
        data-message-id={msg.id}
        style={{
          padding: '3px 16px',
          display: 'flex',
          justifyContent: isMe ? 'flex-end' : 'flex-start',
        }}
      >
        <div style={{ maxWidth: '75%' }}>
          {!prevSameWindow && (
            <div
              style={{
                display: 'flex',
                alignItems: 'baseline',
                gap: 8,
                marginBottom: 4,
                justifyContent: isMe ? 'flex-end' : 'flex-start',
              }}
            >
              {isMe ? (
                <>
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: COLORS.textPrimary }}>
                    {msg.sender_name}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: isAgent ? COLORS.agentName : COLORS.textPrimary,
                    }}
                  >
                    {msg.sender_name}
                  </span>
                  {isAgent && (
                    <span style={{ fontSize: 11, color: COLORS.textSecondary }}>(agent)</span>
                  )}
                  <span style={{ fontSize: 11, color: COLORS.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                </>
              )}
            </div>
          )}
          <div
            style={{
              fontSize: 14,
              color: COLORS.textPrimary,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: isMe ? `${tokens.colors.accent}18` : COLORS.secondary,
              padding: '8px 12px',
              borderRadius: prevSameWindow
                ? '12px'
                : isMe
                  ? '12px 12px 2px 12px'
                  : '12px 12px 12px 2px',
            }}
            onCopy={handleMentionAwareCopy}
          >
            {renderMarkdown(msg.content, participants)}
            {/* Inline image thumbnails */}
            {msgImages.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                {msgImages.map((img, idx) => (
                  <img
                    key={idx}
                    src={`data:${img.mimetype};base64,${img.data}`}
                    alt={img.filename || `Image ${idx + 1}`}
                    style={{
                      width: 64,
                      height: 64,
                      borderRadius: tokens.radii.sm,
                      objectFit: 'cover',
                      cursor: 'pointer',
                      border: `1px solid ${COLORS.border}`,
                    }}
                    onClick={() => setLightboxImage(`data:${img.mimetype};base64,${img.data}`)}
                  />
                ))}
              </div>
            )}
          </div>
          {/* Read receipt below last message */}
          {isLast && participantCount > 1 && (
            <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4, textAlign: isMe ? 'right' : 'left' }}>
              Read by {participantCount - 1}
            </div>
          )}
        </div>
      </div>,
    );
  }

  return (
    <>
      <div>{rendered}</div>
      {/* Image lightbox */}
      {lightboxImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Image preview"
          onClick={() => setLightboxImage(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.85)',
            zIndex: 2000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <img
            src={lightboxImage}
            alt="Full size preview"
            style={{ maxWidth: '90vw', maxHeight: '90vh', borderRadius: tokens.radii.sm }}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}
