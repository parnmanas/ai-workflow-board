import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { ChatAttachment, ChatRoomMessageItem } from '../../types';
import { formatClockTime, daySeparatorLabel, sameDay } from './utils/time';
import { renderMarkdown, handleMentionAwareCopy, type MentionParticipant } from './utils/markdown';
import { base64ToBlob, formatBytes, isImageMime, triggerBlobDownload } from './utils/attachments';

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
  // Object URL cache keyed by attachment id. We never put base64 data URLs in
  // <img src> because that re-renders the entire base64 string on every diff;
  // the Blob → ObjectURL indirection lets the browser cache the decoded bytes
  // and lets us revoke them when the component unmounts.
  const [previewUrls, setPreviewUrls] = useState<Record<string, string>>({});
  const inflightRef = useRef<Set<string>>(new Set());
  const previewUrlsRef = useRef<Record<string, string>>({});
  useEffect(() => { previewUrlsRef.current = previewUrls; }, [previewUrls]);
  useEffect(() => {
    return () => {
      for (const url of Object.values(previewUrlsRef.current)) {
        try { URL.revokeObjectURL(url); } catch { /* ignore */ }
      }
    };
  }, []);

  // Close lightbox on Escape key
  useEffect(() => {
    if (!lightboxImage) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setLightboxImage(null);
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [lightboxImage]);

  function ensureImagePreview(att: ChatAttachment) {
    const id = att.id || att.attachment_id || '';
    const roomId = att.room_id || '';
    if (!id || !roomId) return;
    if (previewUrlsRef.current[id]) return;
    if (inflightRef.current.has(id)) return;
    inflightRef.current.add(id);
    api.getChatAttachment(roomId, id)
      .then((full) => {
        if (!full?.file_data) return;
        const blob = base64ToBlob(full.file_data, full.mime_type || att.mime_type || '');
        const url = URL.createObjectURL(blob);
        setPreviewUrls((prev) => {
          // Concurrent fetches shouldn't leak URLs.
          if (prev[id]) {
            try { URL.revokeObjectURL(url); } catch { /* ignore */ }
            return prev;
          }
          return { ...prev, [id]: url };
        });
      })
      .catch(() => { /* leave thumbnail in placeholder state */ })
      .finally(() => { inflightRef.current.delete(id); });
  }

  async function downloadAttachment(att: ChatAttachment) {
    const id = att.id || att.attachment_id || '';
    const roomId = att.room_id || '';
    if (!id || !roomId) return;
    try {
      const full = await api.getChatAttachment(roomId, id);
      if (!full?.file_data) throw new Error('No data');
      const blob = base64ToBlob(full.file_data, full.mime_type || att.mime_type || '');
      triggerBlobDownload(blob, full.filename || att.filename || 'download');
    } catch {
      // surfacing a per-attachment error inline would be noisy; the click
      // button stays clickable so the user can retry.
    }
  }

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

    // Parse images JSON (stored as string from server) — legacy inline path.
    let msgImages: Array<{ data: string; filename: string; mimetype: string }> = [];
    if (msg.images) {
      try {
        const parsed = typeof msg.images === 'string' ? JSON.parse(msg.images) : msg.images;
        if (Array.isArray(parsed)) msgImages = parsed;
      } catch {
        // malformed images field — skip silently
      }
    }
    // New uniform attachment surface — split for image-inline vs file-button.
    const attachments: ChatAttachment[] = Array.isArray(msg.attachments) ? msg.attachments : [];
    const imageAttachments = attachments.filter((a) => isImageMime(a.mime_type || a.file_mimetype));
    const fileAttachments = attachments.filter((a) => !isImageMime(a.mime_type || a.file_mimetype));

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
            {/* Legacy inline image thumbnails (pre-attachment-surface messages). */}
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
            {/* Image attachments — fetched on demand into a Blob URL. */}
            {imageAttachments.length > 0 && (
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
                {imageAttachments.map((att) => {
                  const id = att.id || att.attachment_id || '';
                  const url = previewUrls[id];
                  if (!url) ensureImagePreview(att);
                  return (
                    <div
                      key={id}
                      title={att.filename}
                      style={{
                        width: 96,
                        height: 96,
                        borderRadius: tokens.radii.sm,
                        background: COLORS.border,
                        border: `1px solid ${COLORS.border}`,
                        cursor: url ? 'pointer' : 'default',
                        overflow: 'hidden',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                      onClick={() => { if (url) setLightboxImage(url); }}
                    >
                      {url ? (
                        <img
                          src={url}
                          alt={att.filename || 'Image'}
                          style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                        />
                      ) : (
                        <span style={{ fontSize: 11, color: COLORS.textSecondary }}>…</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Non-image attachments — metadata + download button only. */}
            {fileAttachments.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: 8, flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                {fileAttachments.map((att) => {
                  const id = att.id || att.attachment_id || '';
                  return (
                    <div
                      key={id}
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'center',
                        background: COLORS.dominant,
                        border: `1px solid ${COLORS.border}`,
                        borderRadius: tokens.radii.sm,
                        padding: '6px 10px',
                        maxWidth: 320,
                      }}
                    >
                      <span style={{ fontSize: 18 }} aria-hidden>📄</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: COLORS.textPrimary, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                          {att.filename || att.file_name || 'File'}
                        </div>
                        <div style={{ fontSize: 10, color: COLORS.textSecondary }}>
                          {formatBytes(att.size_bytes ?? att.file_size ?? 0)}
                        </div>
                      </div>
                      <button
                        onClick={() => downloadAttachment(att)}
                        aria-label={`Download ${att.filename || 'file'}`}
                        style={{
                          background: 'transparent',
                          border: `1px solid ${COLORS.border}`,
                          color: COLORS.textSecondary,
                          borderRadius: tokens.radii.sm,
                          padding: '4px 8px',
                          fontSize: 11,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        Download
                      </button>
                    </div>
                  );
                })}
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
