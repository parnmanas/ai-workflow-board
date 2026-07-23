import React, { useState, useEffect, useRef } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { ChatAttachment, ChatRoomMessageItem } from '../../types';
import { formatClockTime, daySeparatorLabel, sameDay } from './utils/time';
import { renderMarkdown, handleMentionAwareCopy, type MentionParticipant } from './utils/markdown';
import { base64ToBlob, formatBytes, isImageMime, triggerBlobDownload } from './utils/attachments';
import TicketRefCard from './TicketRefCard';
import ArtifactRefCard from './ArtifactRefCard';
import AgentRefCard from './AgentRefCard';
import BoardRefCard from './BoardRefCard';

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
          <div style={{ flex: 1, height: 1, background: tokens.colors.border }} />
          <span
            style={{
              fontSize: tokens.typography.fontSizeXs,
              color: tokens.colors.textMuted,
              letterSpacing: '0.05em',
              textTransform: 'uppercase',
              whiteSpace: 'nowrap',
            }}
          >
            {label}
          </span>
          <div style={{ flex: 1, height: 1, background: tokens.colors.border }} />
        </div>,
      );
    }

    // Progress rows are tool-call heartbeats the agent-manager posts while
    // the spawned CLI works. They share the same chat stream as real
    // messages (so the user can see live activity) but render as a compact
    // muted italic line instead of a bubble — no avatar header, no read
    // receipt, no time-collapse interaction with neighboring bubbles. The
    // server already strips them from agent history replays.
    const isProgress = msg.type === 'progress';
    if (isProgress) {
      // Don't run progress content through renderMarkdown — the emitProgress
      // formatter already wraps the body in `_..._` for italics, and double-
      // markdowning (em inside an italic container) renders unpredictably
      // across browsers. Plain text keeps the muted-line aesthetic clean.
      rendered.push(
        <div
          key={msg.id}
          data-message-id={msg.id}
          data-message-type="progress"
          style={{
            padding: '2px 16px',
            display: 'flex',
            alignItems: 'baseline',
            gap: tokens.spacing.sm,
            color: tokens.colors.textMuted,
            fontSize: tokens.typography.fontSizeXs,
          }}
        >
          <span style={{ fontWeight: 500 }}>{msg.sender_name}</span>
          <span
            style={{
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              flex: 1,
              fontStyle: 'italic',
            }}
          >
            {/* Strip the `_..._` italic wrapper the manager emits — the
             *  container's italic already conveys the same intent. */}
            {msg.content.replace(/^_+|_+$/g, '')}
          </span>
          <span style={{ fontSize: 10, opacity: 0.7 }}>
            {formatClockTime(msg.created_at)}
          </span>
        </div>,
      );
      continue;
    }

    // System notices (ticket bfdd80b7) — e.g. the auto-start "⏳ **Agent** 가 …
    // 자동 시작을 요청했습니다" line the server drops into a room when a user
    // messages a not-started agent. Rendered as a centered, markdown-aware muted
    // pill (NOT a left-aligned agent bubble) so it reads as an out-of-band status
    // line rather than a chat turn.
    const isSystem = msg.sender_type === 'system';
    if (isSystem) {
      rendered.push(
        <div
          key={msg.id}
          data-message-id={msg.id}
          data-message-type="system"
          style={{
            padding: '6px 16px',
            display: 'flex',
            justifyContent: 'center',
          }}
        >
          <div
            style={{
              maxWidth: '75%',
              background: `${tokens.colors.border}40`,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.full,
              padding: '4px 12px',
              fontSize: 12,
              fontStyle: 'italic',
              color: tokens.colors.textSecondary,
              textAlign: 'center',
              lineHeight: 1.5,
              wordBreak: 'break-word',
            }}
            onCopy={handleMentionAwareCopy}
          >
            {renderMarkdown(msg.content, participants)}
          </div>
        </div>,
      );
      continue;
    }

    // Collapse sender info if same sender within 60s.
    // `prev` is skipped for the collapse comparison when it was a progress
    // row, since those don't render a sender header anyway — falling
    // through to the same-window branch would suppress the bubble's
    // header even though there's no preceding bubble to attach to.
    const prevSameWindow =
      prev &&
      prev.type !== 'progress' &&
      prev.sender_type !== 'system' &&
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
                gap: tokens.spacing.sm,
                marginBottom: tokens.spacing.xs,
                justifyContent: isMe ? 'flex-end' : 'flex-start',
              }}
            >
              {isMe ? (
                <>
                  <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                  <span style={{ fontSize: tokens.typography.fontSizeMd, fontWeight: 600, color: tokens.colors.textPrimary }}>
                    {msg.sender_name}
                  </span>
                </>
              ) : (
                <>
                  <span
                    style={{
                      fontSize: tokens.typography.fontSizeMd,
                      fontWeight: 600,
                      color: isAgent ? tokens.colors.accentSubtle : tokens.colors.textPrimary,
                    }}
                  >
                    {msg.sender_name}
                  </span>
                  {isAgent && (
                    <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary }}>(agent)</span>
                  )}
                  <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted }}>
                    {formatClockTime(msg.created_at)}
                  </span>
                </>
              )}
            </div>
          )}
          <div
            style={{
              fontSize: tokens.typography.fontSizeLg,
              color: tokens.colors.textPrimary,
              lineHeight: 1.5,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              background: isMe ? `${tokens.colors.accent}18` : tokens.colors.surfaceCard,
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
            {/* F-1 (ticket 24694916): structured ticket-action cards the
             *  agent-manager captured from mcp__awb__* tool results. Rendered
             *  independently of any @[ticket:...] prose token so an agent ticket
             *  action never fails to surface a reliable, clickable card. */}
            {Array.isArray(msg.metadata?.ticket_refs) && msg.metadata!.ticket_refs!.length > 0 && (
              <div
                data-ticket-refs=""
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
              >
                {msg.metadata!.ticket_refs!.map((ref, idx) => (
                  <TicketRefCard
                    key={`${ref.ticket_id}:${ref.action}:${idx}`}
                    id={ref.ticket_id}
                    title={ref.title || ref.ticket_id}
                    action={ref.action}
                    detail={ref.detail}
                  />
                ))}
              </div>
            )}
            {/* F2-4 ⓒ (ticket d21b28fc): 결과물성 tool 결과(빌드/배포) 카드. ticket_refs 와
             *  독립적으로 방출되므로 별도 블록으로 렌더한다(배포 URL 있으면 링크). */}
            {Array.isArray(msg.metadata?.artifact_refs) && msg.metadata!.artifact_refs!.length > 0 && (
              <div
                data-artifact-refs=""
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
              >
                {msg.metadata!.artifact_refs!.map((ref, idx) => (
                  <ArtifactRefCard key={`${ref.kind}:${ref.title}:${ref.commit || ''}:${idx}`} artifact={ref} />
                ))}
              </div>
            )}
            {/* F-3 (ticket 3ca88253): agent 상태 카드. 다른 refs 채널과 독립적으로
             *  방출되므로 별도 블록으로 렌더한다. */}
            {Array.isArray(msg.metadata?.agent_refs) && msg.metadata!.agent_refs!.length > 0 && (
              <div
                data-agent-refs=""
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
              >
                {msg.metadata!.agent_refs!.map((ref, idx) => (
                  <AgentRefCard key={`${ref.agent_id}:${idx}`} id={ref.agent_id} name={ref.name} />
                ))}
              </div>
            )}
            {/* F-3 (ticket 3ca88253): 보드 현황 카드. 다른 refs 채널과 독립적으로
             *  방출되므로 별도 블록으로 렌더한다. */}
            {Array.isArray(msg.metadata?.board_refs) && msg.metadata!.board_refs!.length > 0 && (
              <div
                data-board-refs=""
                style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}
              >
                {msg.metadata!.board_refs!.map((ref, idx) => (
                  <BoardRefCard key={`${ref.board_id}:${idx}`} id={ref.board_id} title={ref.title} />
                ))}
              </div>
            )}
            {/* Legacy inline image thumbnails (pre-attachment-surface messages). */}
            {msgImages.length > 0 && (
              <div style={{ display: 'flex', gap: tokens.spacing.sm, marginTop: tokens.spacing.sm, flexWrap: 'wrap', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
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
                      border: `1px solid ${tokens.colors.border}`,
                    }}
                    onClick={() => setLightboxImage(`data:${img.mimetype};base64,${img.data}`)}
                  />
                ))}
              </div>
            )}
            {/* Image attachments — fetched on demand into a Blob URL. */}
            {imageAttachments.length > 0 && (
              <div style={{ display: 'flex', gap: tokens.spacing.sm, marginTop: tokens.spacing.sm, flexWrap: 'wrap', justifyContent: isMe ? 'flex-end' : 'flex-start' }}>
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
                        background: tokens.colors.border,
                        border: `1px solid ${tokens.colors.border}`,
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
                        <span style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary }}>…</span>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {/* Non-image attachments — metadata + download button only. */}
            {fileAttachments.length > 0 && (
              <div style={{ display: 'flex', gap: 6, marginTop: tokens.spacing.sm, flexDirection: 'column', alignItems: isMe ? 'flex-end' : 'flex-start' }}>
                {fileAttachments.map((att) => {
                  const id = att.id || att.attachment_id || '';
                  return (
                    <div
                      key={id}
                      style={{
                        display: 'flex',
                        gap: tokens.spacing.sm,
                        alignItems: 'center',
                        background: tokens.colors.surface,
                        border: `1px solid ${tokens.colors.border}`,
                        borderRadius: tokens.radii.sm,
                        padding: '6px 10px',
                        maxWidth: 320,
                      }}
                    >
                      <span style={{ fontSize: 18 }} aria-hidden>📄</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 12, color: tokens.colors.textPrimary, fontWeight: 500, whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
                          {att.filename || att.file_name || 'File'}
                        </div>
                        <div style={{ fontSize: 10, color: tokens.colors.textSecondary }}>
                          {formatBytes(att.size_bytes ?? att.file_size ?? 0)}
                        </div>
                      </div>
                      <button
                        onClick={() => downloadAttachment(att)}
                        aria-label={`Download ${att.filename || 'file'}`}
                        style={{
                          background: 'transparent',
                          border: `1px solid ${tokens.colors.border}`,
                          color: tokens.colors.textSecondary,
                          borderRadius: tokens.radii.sm,
                          padding: '4px 8px',
                          fontSize: tokens.typography.fontSizeXs,
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
            <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted, marginTop: tokens.spacing.xs, textAlign: isMe ? 'right' : 'left' }}>
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
            background: tokens.overlays.scrimStrong,
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
