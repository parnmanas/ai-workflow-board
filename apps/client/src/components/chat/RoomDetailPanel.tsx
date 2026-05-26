import React, { useState, useEffect, useRef, useCallback } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { tokens } from '../../tokens';
import PageHeader from '../PageHeader';
import type { ChatAttachment, ChatRoomListItem, ChatRoomMessageItem } from '../../types';
import MessageList from './MessageList';
import NewChatModal from './ParticipantPicker';
import { type MentionParticipant } from './utils/markdown';
import { MentionTextarea, MentionCandidate } from '../common/MentionTextarea';
import { formatAgentDisplayName } from '../../utils/agentName';
import { formatBytes, isImageMime, readFileAsBase64 } from './utils/attachments';

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
};

// ─── ChatMessageInput ─────────────────────────────────────────────────────────

interface ChatMessageInputProps {
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

function ChatMessageInput({ roomId, onSent, isMobile }: ChatMessageInputProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
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

    setSending(true);
    setSendError(null);
    setText('');

    try {
      // Server accepts empty content when attachment_ids carries the payload
      // (attachment-only screenshot/file share). Drop the previous ' '
      // placeholder so the rendered bubble doesn't carry a stray space.
      const msg = await api.sendChatRoomMessage(
        roomId,
        content,
        undefined,
        attachmentIds.length > 0 ? attachmentIds : undefined,
      );
      // Only release the strip after the server has bound the attachments
      // to a message id. Clearing optimistically would discard the user's
      // uploaded files on any send failure (network, 409 race, etc.).
      setPendingAttachments((prev) => {
        prev.forEach((p) => p.previewUrl && URL.revokeObjectURL(p.previewUrl));
        return [];
      });
      onSent(msg);
    } catch (err: any) {
      setSendError(err?.message || 'Message not sent. Check your connection.');
      setText(content); // restore draft; pendingAttachments are preserved for retry
    } finally {
      setSending(false);
    }
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
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      style={{
        background: COLORS.secondary,
        borderTop: `1px solid ${COLORS.border}`,
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
            fontSize: 14,
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
            borderTop: `1px solid ${COLORS.border}`,
            padding: '8px 16px',
            display: 'flex',
            gap: 8,
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
          <div style={{ marginLeft: 'auto', fontSize: 11, color: COLORS.textSecondary, whiteSpace: 'nowrap', alignSelf: 'center' }}>
            {pendingAttachments.length} / {MAX_CLIENT_ATTACHMENTS}
          </div>
        </div>
      )}
      {uploadError && (
        <div style={{ fontSize: 11, color: tokens.colors.danger, padding: '4px 16px' }}>
          {uploadError}
        </div>
      )}

      <div style={{ padding: '16px 16px' }} onPaste={handlePaste}>
        {sendError && (
          <div style={{ fontSize: 13, color: COLORS.destructive, marginBottom: 8 }}>
            {sendError}
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
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
              color: canAttach ? COLORS.textSecondary : COLORS.textMuted,
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
            value={text}
            onChange={setText}
            candidates={mentionCandidates}
            onSubmit={handleSend}
            rows={1}
            disabled={sending}
            ariaLabel="Message"
            placeholder="Type a message… (@ to tag · paste / drop files to attach)"
            style={{
              flex: 1,
              background: COLORS.dominant,
              border: `1px solid ${COLORS.border}`,
              borderRadius: tokens.radii.md,
              color: COLORS.textPrimary,
              fontSize: 14,
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
              background: COLORS.accent,
              color: 'white',
              border: 'none',
              borderRadius: tokens.radii.md,
              padding: '8px 16px',
              fontSize: 13,
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
        <div style={{ fontSize: 11, color: COLORS.textMuted, marginTop: 4 }}>
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
            background: 'rgba(0,0,0,0.35)',
            color: '#fff',
            fontSize: 11,
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
            background: 'rgba(0,0,0,0.45)',
            color: tokens.colors.danger,
            fontSize: 11,
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
          background: 'rgba(0,0,0,0.7)',
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

// ─── RoomHeaderActions ────────────────────────────────────────────────────────

interface RoomHeaderActionsProps {
  room: ChatRoomListItem;
  isRenaming: boolean;
  onRenameStart: () => void;
  onRenameCancel: () => void;
  onRenameConfirm: (name: string) => void;
  onLeave: () => void;
  onAddPeople: () => void;
}

function RoomHeaderActions({
  room,
  isRenaming,
  onRenameStart,
  onRenameCancel,
  onRenameConfirm,
  onLeave,
  onAddPeople,
}: RoomHeaderActionsProps) {
  const [renameValue, setRenameValue] = useState(room.name || '');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (isRenaming) {
      setRenameValue(room.name || '');
      setTimeout(() => renameInputRef.current?.focus(), 30);
    }
  }, [isRenaming, room.name]);

  function handleRenameKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      const val = renameValue.trim();
      if (val) onRenameConfirm(val);
    } else if (e.key === 'Escape') {
      onRenameCancel();
    }
  }

  const ghostButton = {
    background: 'transparent',
    border: `1px solid ${COLORS.border}`,
    color: COLORS.textSecondary,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties;

  const destructiveButton = {
    background: 'transparent',
    border: `1px solid ${COLORS.destructive}`,
    color: COLORS.destructive,
    borderRadius: tokens.radii.md,
    padding: '8px 16px',
    fontSize: 13,
    cursor: 'pointer',
  } as React.CSSProperties;

  if (isRenaming) {
    return (
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={renameInputRef}
          type="text"
          placeholder="Room name"
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onKeyDown={handleRenameKeyDown}
          style={{
            background: 'transparent',
            border: 'none',
            borderBottom: `1px solid ${COLORS.accent}`,
            color: COLORS.textPrimary,
            fontSize: 16,
            fontWeight: 600,
            outline: 'none',
            width: 200,
          }}
        />
        <button
          onClick={() => { const v = renameValue.trim(); if (v) onRenameConfirm(v); }}
          style={{ ...ghostButton, borderColor: COLORS.accent, color: COLORS.accent }}
        >
          Rename Room
        </button>
        <button onClick={onRenameCancel} style={ghostButton}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', gap: 8 }}>
      {room.type === 'group' && (
        <>
          <button onClick={onAddPeople} style={ghostButton}>
            Add People
          </button>
          <button onClick={onRenameStart} style={ghostButton}>
            Rename
          </button>
        </>
      )}
      <button
        onClick={onLeave}
        aria-label="Leave room"
        style={destructiveButton}
      >
        Leave
      </button>
    </div>
  );
}

// ─── ChatRoomView (RoomDetailPanel) ───────────────────────────────────────────

export interface ChatRoomViewProps {
  room: ChatRoomListItem | null;
  messages: ChatRoomMessageItem[];
  loadingMessages: boolean;
  onMessageSent: (msg: ChatRoomMessageItem) => void;
  onLeaveRoom: (roomId: string) => void;
  onRoomRenamed: (roomId: string, name: string) => void;
  onParticipantsAdded: (roomId: string) => void;
  isMobile: boolean;
  onBack?: () => void;
  participantCount?: number;
  participants?: MentionParticipant[];
  typingAgents?: Record<string, { name: string; status?: string }>; // agent_id -> { name, status }
  currentUserId?: string;
}

export default function ChatRoomView({
  room,
  messages,
  loadingMessages,
  onMessageSent,
  onLeaveRoom,
  onRoomRenamed,
  onParticipantsAdded,
  isMobile,
  onBack,
  participantCount = 0,
  participants = [],
  typingAgents = {} as Record<string, { name: string; status?: string }>,
  currentUserId,
}: ChatRoomViewProps) {
  const [isRenaming, setIsRenaming] = useState(false);
  const [showAddPeople, setShowAddPeople] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function handleLeave() {
    if (!room) return;
    const confirmed = window.confirm("Leave this room? You'll need to be re-added to rejoin.");
    if (!confirmed) return;
    await api.leaveChatRoom(room.id).catch(() => {});
    onLeaveRoom(room.id);
  }

  async function handleRenameConfirm(name: string) {
    if (!room) return;
    setIsRenaming(false);
    await api.renameChatRoom(room.id, name).catch(() => {});
    onRoomRenamed(room.id, name);
  }

  if (!room) {
    return (
      <div
        style={{
          background: COLORS.dominant,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100%',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, color: COLORS.textPrimary, marginBottom: 8 }}>
            Select a room
          </div>
          <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
            Choose a chat from the list to view messages.
          </div>
        </div>
      </div>
    );
  }

  const roomDisplayName =
    room.type === 'dm'
      ? (room.dm_partner_name || room.name || 'Direct Message')
      : (room.name || 'Unnamed Group');

  const headerActions = isRenaming ? null : (
    <RoomHeaderActions
      room={room}
      isRenaming={isRenaming}
      onRenameStart={() => setIsRenaming(true)}
      onRenameCancel={() => setIsRenaming(false)}
      onRenameConfirm={handleRenameConfirm}
      onLeave={handleLeave}
      onAddPeople={() => setShowAddPeople(true)}
    />
  );

  return (
    <div
      style={{
        background: COLORS.dominant,
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        overflow: 'hidden',
      }}
    >
      {isRenaming ? (
        <div
          style={{
            background: tokens.gradients.surfaceCard,
            borderBottom: `1px solid ${COLORS.border}`,
            padding: '16px 24px',
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            flexShrink: 0,
          }}
        >
          {isMobile && onBack && (
            <button
              onClick={onBack}
              style={{ background: 'transparent', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 18, flexShrink: 0 }}
            >
              ←
            </button>
          )}
          <RoomHeaderActions
            room={room}
            isRenaming={isRenaming}
            onRenameStart={() => setIsRenaming(true)}
            onRenameCancel={() => setIsRenaming(false)}
            onRenameConfirm={handleRenameConfirm}
            onLeave={handleLeave}
            onAddPeople={() => setShowAddPeople(true)}
          />
        </div>
      ) : (
        <PageHeader
          title={roomDisplayName}
          description={undefined}
          actions={
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {isMobile && onBack && (
                <button
                  onClick={onBack}
                  style={{ background: 'transparent', border: 'none', color: COLORS.textSecondary, cursor: 'pointer', fontSize: 18 }}
                  aria-label="Back to room list"
                >
                  ←
                </button>
              )}
              {headerActions}
            </div>
          }
        />
      )}

      {/* Message scroll area */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {loadingMessages ? (
          <div style={{ padding: 24 }}>
            {[1, 2, 3].map((i) => (
              <div key={i} style={{ marginBottom: 16 }}>
                <div style={{ width: 80, height: 12, background: COLORS.border, borderRadius: tokens.radii.sm, marginBottom: 6 }} />
                <div style={{ width: '60%', height: 14, background: COLORS.border, borderRadius: tokens.radii.sm }} />
              </div>
            ))}
          </div>
        ) : messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <div style={{ fontSize: 13, color: COLORS.textSecondary }}>
              No messages yet. Send one to get started.
            </div>
          </div>
        ) : (
          <MessageList messages={messages} participantCount={participantCount} participants={participants} currentUserId={currentUserId} />
        )}
        <div ref={bottomRef} />
      </div>

      {/* Typing indicator */}
      {Object.keys(typingAgents).length > 0 && (
        <div style={{
          padding: '4px 16px',
          fontSize: '13px',
          color: COLORS.textSecondary,
          fontStyle: 'italic',
          flexShrink: 0,
        }}>
          {(() => {
            const entries = Object.values(typingAgents);
            const names = entries.map(e => e.name);
            const statuses = entries.map(e => e.status).filter(Boolean);
            // If any agent has a status message, show it
            if (statuses.length > 0) {
              return `${names.join(', ')} — ${statuses[0]}`;
            }
            return `${names.join(', ')}${entries.length === 1 ? ' is typing' : ' are typing'}`;
          })()}
          <span style={{ display: 'inline-block', width: 20 }}>...</span>
        </div>
      )}

      {/* Message input */}
      <ChatMessageInput
        roomId={room.id}
        onSent={onMessageSent}
        isMobile={isMobile}
      />

      {/* Add People modal */}
      <NewChatModal
        open={showAddPeople}
        onClose={() => setShowAddPeople(false)}
        onCreated={(_result) => {
          setShowAddPeople(false);
          onParticipantsAdded(room.id);
        }}
        addToRoomId={room.id}
      />
    </div>
  );
}
