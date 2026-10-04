import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import type { Ticket, TicketAttachmentMeta } from '../../types';

interface TicketAttachmentsSectionProps {
  ticket: Pick<Ticket, 'id' | 'attachments' | 'updated_at'>;
  onPreview(src: string, mimetype?: string): void;
  labelStyle: React.CSSProperties;
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

/**
 * Ticket-level attachments. Distinct from comment attachments — files added
 * here live on the ticket itself and cascade-delete with it; they do NOT pass
 * through the Resource indirection the comment composer uses. Render keyed by
 * ticket id so busy/error state never bleeds across tickets.
 */
export default function TicketAttachmentsSection({ ticket, onPreview, labelStyle }: TicketAttachmentsSectionProps) {
  const confirm = useConfirm();
  // Ticket-level attachments — file_data is fetched on demand (download/preview)
  // so the metadata list can stay cheap. Seeded from the ticket payload, then
  // refreshed via api.listTicketAttachments after each mutation so concurrent
  // edits across tabs converge.
  const [ticketAttachments, setTicketAttachments] = useState<TicketAttachmentMeta[]>(ticket.attachments || []);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  // The attachment list is an authoritative server-side fact with no draft
  // concept — keep refreshing it on updated_at. Seed from the ticket payload
  // (only the full ticket read populates it), then fetch fresh metadata so the
  // list is authoritative regardless of which load path supplied the prop.
  useEffect(() => {
    setTicketAttachments(ticket.attachments || []);
    setAttachmentError(null);
    let cancelled = false;
    api.listTicketAttachments(ticket.id)
      .then(rows => { if (!cancelled) setTicketAttachments(rows || []); })
      .catch(() => { /* keep seeded list — non-blocking */ });
    return () => { cancelled = true; };
  }, [ticket.id, ticket.updated_at]);

  // Cross-tab sync — board_update fires on every activity event, so refresh
  // the attachments list when our ticket is the target. Filtering by
  // field_changed='attachment' avoids refetching on unrelated updates
  // (assignee change, comment add, etc.).
  useBoardStreamEvent('board_update', useCallback((data: any) => {
    if (!data || data.ticket_id !== ticket.id) return;
    if (data.field_changed !== 'attachment') return;
    api.listTicketAttachments(ticket.id)
      .then(rows => setTicketAttachments(rows || []))
      .catch(() => { /* non-blocking */ });
  }, [ticket.id]));

  // ─── Ticket-level attachments ────────────────────────────────
  const TICKET_ATTACHMENT_MAX = 20;
  const TICKET_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024;

  const handleAddTicketAttachments = useCallback(() => {
    setAttachmentError(null);
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = async (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (!files || files.length === 0) return;
      const remaining = TICKET_ATTACHMENT_MAX - ticketAttachments.length;
      if (remaining <= 0) {
        setAttachmentError(`Maximum ${TICKET_ATTACHMENT_MAX} attachments per ticket`);
        return;
      }
      const payload: { file_name: string; file_mimetype: string; file_data: string }[] = [];
      const oversized: string[] = [];
      for (let i = 0; i < files.length && payload.length < remaining; i++) {
        const file = files[i];
        if (file.size > TICKET_ATTACHMENT_SIZE_BYTES) {
          oversized.push(file.name);
          continue;
        }
        const data = await fileToBase64(file);
        payload.push({
          file_name: file.name,
          file_mimetype: file.type || 'application/octet-stream',
          file_data: data,
        });
      }
      if (payload.length === 0) {
        if (oversized.length > 0) {
          setAttachmentError(`Skipped — exceeds 10MB: ${oversized.join(', ')}`);
        }
        return;
      }
      setAttachmentBusy(true);
      try {
        const saved = await api.addTicketAttachments(ticket.id, payload);
        setTicketAttachments(prev => [...saved, ...prev]);
        if (oversized.length > 0) {
          setAttachmentError(`Skipped — exceeds 10MB: ${oversized.join(', ')}`);
        }
      } catch (err: any) {
        setAttachmentError(err?.message || 'Upload failed');
      } finally {
        setAttachmentBusy(false);
      }
    };
    input.click();
  }, [ticket.id, ticketAttachments.length]);

  const handleDeleteTicketAttachment = useCallback(async (attachmentId: string, fileName: string) => {
    const ok = await confirm({ title: 'Delete attachment', message: `Delete attachment "${fileName}"?` });
    if (!ok) return;
    setAttachmentBusy(true);
    setAttachmentError(null);
    const prev = ticketAttachments;
    setTicketAttachments(prev.filter(a => a.id !== attachmentId));
    try {
      await api.deleteTicketAttachment(ticket.id, attachmentId);
    } catch (err: any) {
      setTicketAttachments(prev);
      setAttachmentError(err?.message || 'Delete failed');
    } finally {
      setAttachmentBusy(false);
    }
  }, [ticket.id, ticketAttachments, confirm]);

  const handleDownloadTicketAttachment = useCallback(async (attachment: TicketAttachmentMeta) => {
    setAttachmentError(null);
    try {
      const full = await api.getTicketAttachment(ticket.id, attachment.id);
      if (!full?.file_data) {
        setAttachmentError('Attachment has no data');
        return;
      }
      const link = document.createElement('a');
      link.href = `data:${full.file_mimetype || 'application/octet-stream'};base64,${full.file_data}`;
      link.download = full.file_name;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    } catch (err: any) {
      setAttachmentError(err?.message || 'Download failed');
    }
  }, [ticket.id]);

  const handlePreviewTicketAttachment = useCallback(async (attachment: TicketAttachmentMeta) => {
    const mt = attachment.file_mimetype || '';
    const isImage = mt.startsWith('image/');
    const isVideo = mt.startsWith('video/');
    if (!isImage && !isVideo) {
      handleDownloadTicketAttachment(attachment);
      return;
    }
    setAttachmentError(null);
    try {
      const full = await api.getTicketAttachment(ticket.id, attachment.id);
      if (full?.file_data) {
        onPreview(`data:${full.file_mimetype};base64,${full.file_data}`, full.file_mimetype);
      }
    } catch (err: any) {
      setAttachmentError(err?.message || 'Preview failed');
    }
  }, [ticket.id, handleDownloadTicketAttachment, onPreview]);

  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <label style={{ ...labelStyle, marginBottom: 0 }}>
          Attachments
          {ticketAttachments.length > 0 && (
            <span style={{ marginLeft: 6, color: tokens.colors.textDisabled, fontWeight: 500 }}>
              ({ticketAttachments.length}/{TICKET_ATTACHMENT_MAX})
            </span>
          )}
        </label>
        <button
          type="button"
          onClick={handleAddTicketAttachments}
          disabled={attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX}
          style={{
            background: 'transparent',
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            color: tokens.colors.textStrong,
            fontSize: '11px',
            padding: '4px 10px',
            cursor: (attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX) ? 'not-allowed' : 'pointer',
            opacity: (attachmentBusy || ticketAttachments.length >= TICKET_ATTACHMENT_MAX) ? 0.5 : 1,
          }}
          title="Attach files (10MB each, max 20 per ticket)"
        >
          + Attach files
        </button>
      </div>
      {attachmentError && (
        <div style={{
          fontSize: '11px', color: tokens.colors.dangerLight, padding: '4px 6px',
          background: tokens.colors.dangerBg, borderRadius: tokens.radii.sm, marginBottom: 4,
        }}>
          {attachmentError}
        </div>
      )}
      {ticketAttachments.length === 0 ? (
        <div style={{
          fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic',
          padding: '6px 10px', background: tokens.colors.surfaceCard,
          border: `1px dashed ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
        }}>
          No files attached.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {ticketAttachments.map(att => {
            const mt = att.file_mimetype || '';
            const isImage = mt.startsWith('image/');
            const isVideo = mt.startsWith('video/');
            const sizeKb = att.file_size > 0 ? Math.max(1, Math.round(att.file_size / 1024)) : null;
            return (
              <div
                key={att.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '6px 10px',
                  background: tokens.colors.surfaceCard,
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                }}
              >
                <button
                  type="button"
                  onClick={() => handlePreviewTicketAttachment(att)}
                  style={{
                    background: 'transparent', border: 'none', padding: 0, cursor: 'pointer',
                    color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 500,
                    textAlign: 'left', flex: 1, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}
                  title={isImage || isVideo ? 'Click to preview' : 'Click to download'}
                >
                  {isImage ? '🖼️' : isVideo ? '🎬' : '📎'} {att.file_name}
                </button>
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted, fontVariantNumeric: 'tabular-nums' }}>
                  {sizeKb !== null ? `${sizeKb} KB` : ''}
                  {att.uploaded_by ? ` · ${att.uploaded_by}` : ''}
                </span>
                <button
                  type="button"
                  onClick={() => handleDownloadTicketAttachment(att)}
                  title="Download"
                  style={{
                    background: 'transparent', border: 'none', cursor: 'pointer',
                    color: tokens.colors.textSecondary, fontSize: '12px', padding: '0 4px',
                  }}
                >⬇</button>
                <button
                  type="button"
                  onClick={() => handleDeleteTicketAttachment(att.id, att.file_name)}
                  disabled={attachmentBusy}
                  title="Delete"
                  style={{
                    background: 'transparent', border: 'none', cursor: attachmentBusy ? 'not-allowed' : 'pointer',
                    color: tokens.colors.dangerLight, fontSize: '12px', padding: '0 4px',
                  }}
                >✕</button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
