import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import type { ChatRoomMessageItem } from '../../types';
import { MentionTextarea, MentionCandidate, MentionTextareaHandle } from '../common/MentionTextarea';
import { formatAgentDisplayName } from '../../utils/agentName';
import { formatBytes, isImageMime, readFileAsBase64 } from './utils/attachments';
import { completeComposerSend } from './utils/composerSend';

// ─── ChatMessageInput ─────────────────────────────────────────────────────────

export interface ChatMessageInputProps {
  roomId: string;
  onSent: (msg: ChatRoomMessageItem) => void;
  isMobile: boolean;
}

// Per-file state for the attachment strip. Once `status === 'done'` we have
// a server-issued `attachment_id` we can hand to send_chat_room_message.
// `previewUrl` is only set for images (object URL revoked on remove/unmount).
interface PendingAttachment {
  localId: string;
  fileName: string;
  fileMimetype: string;
  fileSize: number;
  status: 'uploading' | 'done' | 'error';
  progress: number;
  attachmentId?: string;
  previewUrl?: string;
  errorMsg?: string;
  abort?: AbortController;
}

const MAX_CLIENT_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_CLIENT_ATTACHMENTS = 20;

function makeLocalId(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export default function ChatMessageInput({ roomId, onSent, isMobile }: ChatMessageInputProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  // Composer root — lets handleSend decide whether focus is still "inside the
  // composer" when an async send settles (accessibility: don't yank focus back
  // if the user deliberately Tab'd/clicked to a control outside it).
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Imperative focus handle on the composer textarea — drives auto-focus on
  // room open and refocus after send (see effects/handleSend below).
  const inputHandleRef = useRef<MentionTextareaHandle | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionCandidate[]>([]);
  // Stable ref so async upload callbacks (started from one render) can still
  // mutate the latest pendingAttachments without stale-closure footguns.
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  useEffect(() => { attachmentsRef.current = pendingAttachments; }, [pendingAttachments]);

  // Reset whenever the active room changes — pre-send rows live under the
  // previous room and would otherwise be orphaned in the strip.
  useEffect(() => {
    setPendingAttachments((prev) => {
      prev.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        p.abort?.abort();
      });
      return [];
    });
    setUploadError(null);
    setSendError(null);
    setText('');
  }, [roomId]);

  // Auto-focus the composer whenever a room is opened or switched so the user
  // can start typing immediately without a click (requirements 1 & 3). Desktop
  // only: on mobile a programmatic focus forces the soft keyboard up every time
  // a room is viewed, which is intrusive and reads as the keyboard "repeatedly
  // popping up" (requirement 4) — mobile users tap the field to open it. Runs on
  // mount (first room) and on every roomId change (room switch). preventScroll
  // (handle default) keeps focus from perturbing the message list scroll.
  useEffect(() => {
    if (isMobile) return;
    inputHandleRef.current?.focus();
  }, [roomId, isMobile]);

  // Pull workspace-wide mention candidates once. Role shortcuts require a
  // ticket context we don't have in a free-form chat room, so they're
  // intentionally omitted here.
  useEffect(() => {
    const workspaceId = getActiveWorkspaceId() || '';
    if (!workspaceId) {
      setMentionCandidates([]);
      return;
    }
    api.getMentionCandidates(workspaceId)
      .then(data => {
        setMentionCandidates([
          ...data.users.map(u => ({ type: 'user' as const, id: u.id, name: u.name })),
          ...data.agents.map(a => ({
            type: 'agent' as const,
            id: a.id,
            name: formatAgentDisplayName(a),
          })),
        ]);
      })
      .catch(() => setMentionCandidates([]));
  }, []);

  // Revoke object URLs on unmount to prevent memory leaks
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((p) => {
        if (p.previewUrl) URL.revokeObjectURL(p.previewUrl);
        p.abort?.abort();
      });
    };
  }, []);

  const updateOne = useCallback((localId: string, patch: Partial<PendingAttachment>) => {
    setPendingAttachments((prev) =>
      prev.map((p) => (p.localId === localId ? { ...p, ...patch } : p)),
    );
  }, []);

  const startUpload = useCallback(async (file: File) => {
    const localId = makeLocalId();
    const isImg = isImageMime(file.type);
    const previewUrl = isImg ? URL.createObjectURL(file) : undefined;
    const abort = new AbortController();
    const entry: PendingAttachment = {
      localId,
      fileName: file.name,
      fileMimetype: file.type || 'application/octet-stream',
      fileSize: file.size,
      status: 'uploading',
      progress: 0,
      previewUrl,
      abort,
    };
    setPendingAttachments((prev) => [...prev, entry]);

    try {
      const base64 = await readFileAsBase64(file);
      const meta = await api.uploadChatAttachment(
        roomId,
        { file_name: file.name, file_mimetype: file.type, file_data: base64 },
        (pct) => updateOne(localId, { progress: pct }),
        abort.signal,
      );
      updateOne(localId, {
        status: 'done',
        progress: 100,
        attachmentId: meta.id || meta.attachment_id,
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return; // user removed mid-upload
      updateOne(localId, {
        status: 'error',
        errorMsg: err?.message || 'Upload failed',
      });
    }
  }, [roomId, updateOne]);

  const acceptFiles = useCallback((files: File[]) => {
    setUploadError(null);
    const cur = attachmentsRef.current;
    const remainingSlots = MAX_CLIENT_ATTACHMENTS - cur.length;
    const accepted: File[] = [];
    const rejected: string[] = [];
    for (const f of files) {
      if (accepted.length >= remainingSlots) {
        rejected.push(`${f.name}: too many attachments (max ${MAX_CLIENT_ATTACHMENTS})`);
        continue;
      }
      if (f.size > MAX_CLIENT_ATTACHMENT_BYTES) {
        rejected.push(`${f.name}: exceeds 10 MB limit`);
        continue;
      }
      accepted.push(f);
    }
    if (rejected.length > 0) setUploadError(rejected.join(' · '));
    for (const f of accepted) startUpload(f);
  }, [startUpload]);

  function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    e.target.value = ''; // allow re-selecting the same file after removal
    acceptFiles(files);
  }

  async function handleRemove(localId: string) {
    const entry = attachmentsRef.current.find((p) => p.localId === localId);
    if (!entry) return;
    if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    if (entry.status === 'uploading') {
      entry.abort?.abort();
    } else if (entry.status === 'done' && entry.attachmentId) {
      // Best-effort discard of the pre-send row on the server. If this fails
      // (network, race with send), the server's cleanup query GCs orphaned
      // owner_type='chat_room' rows on its own.
      api.deletePendingChatAttachment(roomId, entry.attachmentId).catch(() => {});
    }
    setPendingAttachments((prev) => prev.filter((p) => p.localId !== localId));
    setUploadError(null);
  }

  async function handleSend() {
    const content = text.trim();
    const cur = attachmentsRef.current;
    if ((!content && cur.length === 0) || sending) return;
    // Block send while uploads are in flight — server would 400 on unknown
    // attachment_ids and the UI should make the wait explicit anyway.
    if (cur.some((p) => p.status === 'uploading')) return;
    // Drop any errored entries; they have no attachment_id and would 400.
    const ready = cur.filter((p) => p.status === 'done' && p.attachmentId);
    const attachmentIds = ready.map((p) => p.attachmentId!) as string[];
    // Snapshot the attachments this send owns. Anything added after this point
    // (a file pasted/dropped during a slow send) is NOT in this set and must
    // survive the success clear below — otherwise its preview URL is revoked and
    // the already-uploaded server row is orphaned.
    const sentLocalIds = new Set(cur.map((p) => p.localId));

    setSending(true);
    setSendError(null);
    // Drop the draft optimistically (restored on failure if still empty). Server
    // accepts empty content when attachment_ids carries the payload.
    setText('');

    // Orchestration (send → settle only this send's attachments → restore focus
    // unless the user moved it away) lives in completeComposerSend so the race /
    // accessibility paths are unit-testable without a DOM. The component only
    // injects the live setters, the send call, and the focus read/restore.
    await completeComposerSend<PendingAttachment>({
      content,
      attachmentIds,
      sentLocalIds,
      send: (c, ids) => api.sendChatRoomMessage(roomId, c, undefined, ids),
      onSent,
      setPendingAttachments,
      revokeObjectURL: (u) => URL.revokeObjectURL(u),
      setSendError,
      setText,
      setSending,
      readFocus: () => ({
        active: document.activeElement,
        composerRoot: rootRef.current,
        body: document.body,
      }),
      restoreFocus: () => inputHandleRef.current?.focus(),
    });
  }

  function handleDragEnter(e: React.DragEvent<HTMLDivElement>) {
    if (!e.dataTransfer?.types?.includes('Files')) return;
    e.preventDefault();
    dragCounterRef.current += 1;
    setIsDragOver(true);
  }
  function handleDragLeave(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);
    if (dragCounterRef.current === 0) setIsDragOver(false);
  }
  function handleDragOver(e: React.DragEvent<HTMLDivElement>) {
    if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
  }
  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    dragCounterRef.current = 0;
    setIsDragOver(false);
    const files = Array.from(e.dataTransfer?.files || []);
    if (files.length > 0) acceptFiles(files);
  }

  // Paste handler is attached to the textarea via the wrapper below so we
  // can grab File items (screenshots, copied files in Finder) and route them
  // through the same upload pipeline.
  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items;
    if (!items || items.length === 0) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind === 'file') {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      acceptFiles(files);
    }
  }

  const hasUploading = pendingAttachments.some((p) => p.status === 'uploading');
  const hasReady = pendingAttachments.some((p) => p.status === 'done');
  const canSend = (text.trim().length > 0 || hasReady) && !sending && !hasUploading;
  const canAttach = pendingAttachments.length < MAX_CLIENT_ATTACHMENTS && !sending;

  return (
    <div
      ref={rootRef}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        background: tokens.colors.surfaceCard,
        borderTop: `1px solid ${tokens.colors.border}`,
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {isDragOver && (
        <div
          aria-hidden
          style={{
            position: 'absolute',
            inset: 0,
            background: `${tokens.colors.accent}1f`,
            border: `2px dashed ${tokens.colors.accent}`,
            borderRadius: tokens.radii.md,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: tokens.colors.accent,
            fontSize: tokens.typography.fontSizeLg,
            fontWeight: 600,
            zIndex: 5,
            pointerEvents: 'none',
          }}
        >
          Drop to attach
        </div>
      )}

      {pendingAttachments.length > 0 && (
        <div
          style={{
            background: tokens.colors.surfaceCard,
            borderTop: `1px solid ${tokens.colors.border}`,
            padding: '8px 16px',
            display: 'flex',
            gap: tokens.spacing.sm,
            overflowX: 'auto',
            alignItems: 'flex-end',
          }}
        >
          {pendingAttachments.map((p) => (
            <PendingAttachmentChip
              key={p.localId}
              entry={p}
              onRemove={() => handleRemove(p.localId)}
            />
          ))}
          <div style={{ marginLeft: 'auto', fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textSecondary, whiteSpace: 'nowrap', alignSelf: 'center' }}>
            {pendingAttachments.length} / {MAX_CLIENT_ATTACHMENTS}
          </div>
        </div>
      )}
      {uploadError && (
        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.danger, padding: '4px 16px' }}>
          {uploadError}
        </div>
      )}

      <div style={{ padding: '16px 16px' }} onPaste={handlePaste}>
        {sendError && (
          <div style={{ fontSize: tokens.typography.fontSizeMd, color: tokens.colors.danger, marginBottom: tokens.spacing.sm }}>
            {sendError}
          </div>
        )}
        <div style={{ display: 'flex', gap: tokens.spacing.sm, alignItems: 'flex-end' }}>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />
          <button
            onClick={() => fileInputRef.current?.click()}
            disabled={!canAttach}
            aria-label="Attach files"
            title="Attach files"
            style={{
              background: 'transparent',
              border: 'none',
              color: canAttach ? tokens.colors.textSecondary : tokens.colors.textMuted,
              fontSize: 18,
              padding: 8,
              cursor: canAttach ? 'pointer' : 'not-allowed',
              flexShrink: 0,
              alignSelf: 'flex-end',
              lineHeight: 1,
              height: 44,
              display: 'flex',
              alignItems: 'center',
            }}
          >
            📎
          </button>
          <MentionTextarea
            ref={inputHandleRef}
            value={text}
            onChange={setText}
            candidates={mentionCandidates}
            onSubmit={handleSend}
            rows={1}
            // Intentionally NOT disabled during send: disabling a focused
            // textarea blurs it, which on mobile dismisses the soft keyboard and
            // then reopening it after send reads as a flicker/"keyboard keeps
            // popping up" (requirement 4). Double-submit is already guarded in
            // handleSend (`|| sending` early-return) and by the Send button's
            // canSend gate, so keeping the field editable is safe.
            ariaLabel="Message"
            placeholder="Type a message… (@ to tag · paste / drop files to attach)"
            style={{
              flex: 1,
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              color: tokens.colors.textPrimary,
              fontSize: tokens.typography.fontSizeLg,
              padding: '8px 16px',
              resize: 'none',
              minHeight: 44,
              maxHeight: 112,
              outline: 'none',
              fontFamily: 'inherit',
              lineHeight: 1.5,
              boxSizing: 'border-box',
              width: '100%',
            }}
          />
          <button
            onClick={handleSend}
            disabled={!canSend}
            aria-label={isMobile ? 'Send message' : undefined}
            title={hasUploading ? 'Wait for uploads to finish' : undefined}
            style={{
              background: tokens.colors.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: tokens.typography.fontSizeMd,
              fontWeight: 600,
              cursor: canSend ? 'pointer' : 'not-allowed',
              opacity: canSend ? 1 : 0.5,
              whiteSpace: 'nowrap',
              flexShrink: 0,
              alignSelf: 'flex-end',
              height: 44,
            }}
          >
            {isMobile ? '▶' : 'Send Message'}
          </button>
        </div>
        <div style={{ fontSize: tokens.typography.fontSizeXs, color: tokens.colors.textMuted, marginTop: tokens.spacing.xs }}>
          Enter to send · Shift+Enter for new line · Drop or paste files to attach
        </div>
      </div>
    </div>
  );
}

// ─── PendingAttachmentChip ────────────────────────────────────────────────────

interface PendingAttachmentChipProps {
  entry: PendingAttachment;
  onRemove: () => void;
}

function PendingAttachmentChip({ entry, onRemove }: PendingAttachmentChipProps) {
  const isImg = !!entry.previewUrl;
  return (
    <div
      style={{
        position: 'relative',
        flexShrink: 0,
        width: isImg ? 72 : 180,
        height: isImg ? 72 : 56,
        borderRadius: tokens.radii.sm,
        border: `1px solid ${entry.status === 'error' ? tokens.colors.danger : tokens.colors.border}`,
        background: isImg ? 'transparent' : tokens.colors.surface,
        display: 'flex',
        flexDirection: isImg ? 'row' : 'column',
        alignItems: isImg ? 'stretch' : 'flex-start',
        justifyContent: isImg ? 'center' : 'center',
        padding: isImg ? 0 : '6px 10px',
        overflow: 'hidden',
      }}
    >
      {isImg ? (
        <img
          src={entry.previewUrl}
          alt={entry.fileName}
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            display: 'block',
            opacity: entry.status === 'uploading' ? 0.6 : 1,
          }}
        />
      ) : (
        <>
          <div
            title={entry.fileName}
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: tokens.colors.textPrimary,
              whiteSpace: 'nowrap',
              textOverflow: 'ellipsis',
              overflow: 'hidden',
              maxWidth: '100%',
            }}
          >
            📄 {entry.fileName}
          </div>
          <div style={{ fontSize: 10, color: tokens.colors.textSecondary, marginTop: 2 }}>
            {entry.status === 'error'
              ? entry.errorMsg || 'Upload failed'
              : entry.status === 'uploading'
                ? `${entry.progress}%`
                : formatBytes(entry.fileSize)}
          </div>
        </>
      )}
      {/* Progress bar overlay for uploading state */}
      {entry.status === 'uploading' && (
        <div
          aria-label={`Uploading ${entry.fileName} (${entry.progress}%)`}
          style={{
            position: 'absolute',
            left: 0,
            bottom: 0,
            height: 3,
            width: `${entry.progress}%`,
            background: tokens.colors.accent,
            transition: 'width 80ms linear',
          }}
        />
      )}
      {/* Image overlay caption with progress when image upload is in flight */}
      {isImg && entry.status === 'uploading' && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tokens.overlays.imageBarSubtle,
            color: tokens.colors.textInverse,
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: 600,
          }}
        >
          {entry.progress}%
        </div>
      )}
      {isImg && entry.status === 'error' && (
        <div
          title={entry.errorMsg || 'Upload failed'}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: tokens.overlays.imageBar,
            color: tokens.colors.danger,
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: 600,
          }}
        >
          !
        </div>
      )}
      <button
        onClick={onRemove}
        aria-label={`Remove ${entry.fileName}`}
        style={{
          position: 'absolute',
          top: -6,
          right: -6,
          width: 18,
          height: 18,
          background: tokens.overlays.imageBarStrong,
          color: tokens.colors.textPrimary,
          border: 'none',
          borderRadius: tokens.radii.lg,
          fontSize: 12,
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          lineHeight: 1,
          padding: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
