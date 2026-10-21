import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Comment, Ticket } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { useAuth } from '../../contexts/AuthContext';
import { useToast } from '../../contexts/ToastContext';
import CommentList from '../CommentList';
import { MentionTextarea, type MentionCandidate } from '../common/MentionTextarea';
import { formatAgentDisplayName } from '../../utils/agentName';
import { panelButton, wrapText } from './panelStyles';

// Mirrors the server's raw-upload cap (main.ts): a clear toast at pick time
// instead of a 413 after the upload (ticket ff3e7337).
const MAX_ATTACHMENT_BYTES = 200 * 1024 * 1024;
const MAX_ATTACHMENTS = 5;
const COMMENT_PAGE = 50;

type CommentOptions = { type?: string; parent_id?: string | null; attachment_resource_ids?: string[] };

export interface TicketConversationProps {
  ticket: Ticket;
  accountId: string;
  /** Snapshot of the reader's last visit — newer comments get the unread cue. */
  lastReadAt: string | null;
  scrollToCommentId?: string | null;
  onScrollToCommentConsumed?: () => void;
  onAddComment(ticketId: string, content: string, attachments?: undefined, options?: CommentOptions): void | Promise<void>;
  onSetCommentStatus?(ticketId: string, commentId: string, status: 'open' | 'resolved'): void;
  onPreview(src: string, mimetype?: string): void;
}

const byNewest = (a: Comment, b: Comment) => {
  const d = new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
  return d !== 0 ? d : (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
};

/**
 * The ticket detail carries only the newest comments; older pages load as the
 * reader scrolls down. Once an older page arrived, every comment seen so far is
 * kept — the server window slides as new comments land, and dropping it would
 * lose the comments at the boundary.
 */
function useTicketComments(ticket: Ticket) {
  const [accumulated, setAccumulated] = useState<Comment[] | null>(null);
  const [hasMore, setHasMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);

  useEffect(() => {
    setAccumulated(null);
    setHasMore(null);
    setLoadingOlder(false);
  }, [ticket.id]);

  const fresh = ticket.comments || [];
  const comments = useMemo(() => {
    if (!accumulated) return fresh;
    const map = new Map<string, Comment>();
    for (const c of accumulated) map.set(c.id, c);
    for (const c of fresh) map.set(c.id, c as Comment);
    return Array.from(map.values()).sort(byNewest);
  }, [accumulated, fresh]);

  const loadOlder = useCallback(async () => {
    if (loadingOlder) return;
    const oldest = comments[comments.length - 1];
    if (!oldest) return;
    const ticketId = ticket.id;
    setLoadingOlder(true);
    try {
      const page = await api.getTicketComments(ticketId, { limit: COMMENT_PAGE, before: oldest.id });
      setAccumulated(prev => {
        const map = new Map((prev || comments).map(c => [c.id, c]));
        for (const c of page) if (!map.has(c.id)) map.set(c.id, c as Comment);
        return Array.from(map.values());
      });
      setHasMore(page.length >= COMMENT_PAGE);
    } catch {
      /* keep what is shown — the next scroll retries */
    } finally {
      setLoadingOlder(false);
    }
  }, [comments, loadingOlder, ticket.id]);

  return {
    comments,
    hasMore: hasMore ?? (ticket.comments_has_more ?? false),
    loadingOlder,
    loadOlder,
  };
}

function useMentionCandidates(accountId: string, ticketId: string): MentionCandidate[] {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);
  useEffect(() => {
    if (!accountId) return;
    let cancelled = false;
    api.getMentionCandidates(accountId, ticketId)
      .then(data => {
        if (cancelled) return;
        const seen = new Set<string>();
        const next: MentionCandidate[] = [
          ...data.users.map(u => ({ type: 'user' as const, id: u.id, name: u.name })),
          ...data.agents.map(a => ({ type: 'agent' as const, id: a.id, name: formatAgentDisplayName(a) })),
        ];
        setCandidates(next.filter(c => !seen.has(`${c.type}:${c.id}`) && !!seen.add(`${c.type}:${c.id}`)));
      })
      .catch(() => { if (!cancelled) setCandidates([]); });
    return () => { cancelled = true; };
  }, [accountId, ticketId]);
  return candidates;
}

type Staged = { key: string; file: File; previewUrl: string };

export default function TicketConversation({
  ticket, accountId, lastReadAt, scrollToCommentId, onScrollToCommentConsumed,
  onAddComment, onSetCommentStatus, onPreview,
}: TicketConversationProps) {
  const { user } = useAuth();
  const { showToast } = useToast();
  const { comments, hasMore, loadingOlder, loadOlder } = useTicketComments(ticket);
  const candidates = useMentionCandidates(accountId, ticket.id);
  const [showSystem, setShowSystem] = useState(false);
  const [content, setContent] = useState('');
  const [staged, setStaged] = useState<Staged[]>([]);
  const [sending, setSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<{ id: string; author: string; preview: string } | null>(null);

  useEffect(() => {
    setContent('');
    setReplyingTo(null);
    setStaged(prev => {
      for (const s of prev) URL.revokeObjectURL(s.previewUrl);
      return [];
    });
  }, [ticket.id]);

  // A reply stays with its question: hiding system rows never hides a thread.
  const visible = useMemo(
    () => (showSystem ? comments : comments.filter(c => c.author_type !== 'system')),
    [comments, showSystem],
  );
  const systemCount = comments.length - comments.filter(c => c.author_type !== 'system').length;

  const pickFiles = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () => {
      const files = Array.from(input.files || []);
      const rejected: string[] = [];
      const next: Staged[] = [];
      let room = MAX_ATTACHMENTS - staged.length;
      for (const file of files) {
        if (room <= 0) { rejected.push(`${file.name} (최대 ${MAX_ATTACHMENTS}개)`); continue; }
        if (file.size > MAX_ATTACHMENT_BYTES) { rejected.push(`${file.name} (200MB 초과)`); continue; }
        next.push({ key: `${Date.now()}-${file.name}-${next.length}`, file, previewUrl: URL.createObjectURL(file) });
        room -= 1;
      }
      if (next.length) setStaged(prev => [...prev, ...next]);
      if (rejected.length) showToast(`첨부할 수 없습니다: ${rejected.join(', ')}`, 'error');
    };
    input.click();
  };

  const unstage = (key: string) => setStaged(prev => {
    const target = prev.find(s => s.key === key);
    if (target) URL.revokeObjectURL(target.previewUrl);
    return prev.filter(s => s.key !== key);
  });

  const send = async () => {
    const text = content.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      // Upload first; the comment then carries only resource ids, never bytes.
      const resourceIds: string[] = [];
      for (const s of staged) {
        const uploaded = await api.uploadResourceFile(s.file, { account_id: accountId, type: 'comment_attachment' });
        resourceIds.push(uploaded.id);
      }
      const options: CommentOptions = {
        ...(replyingTo ? { type: 'answer', parent_id: replyingTo.id } : {}),
        ...(resourceIds.length ? { attachment_resource_ids: resourceIds } : {}),
      };
      await Promise.resolve(onAddComment(ticket.id, text, undefined, Object.keys(options).length ? options : undefined));
      for (const s of staged) URL.revokeObjectURL(s.previewUrl);
      setStaged([]);
      setContent('');
      setReplyingTo(null);
    } catch (err: any) {
      // Keep the text and the files so nothing typed is lost.
      showToast(`보내지 못했습니다: ${err?.message || 'unknown error'}`, 'error');
    } finally {
      setSending(false);
    }
  };

  const startReply = (commentId: string) => {
    const target = comments.find(c => c.id === commentId);
    if (target) setReplyingTo({ id: target.id, author: target.author || '', preview: (target.content || '').slice(0, 120) });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, flex: 1 }}>
      {systemCount > 0 && (
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 8, cursor: 'pointer', alignSelf: 'flex-end' }}>
          <input type="checkbox" checked={showSystem} onChange={e => setShowSystem(e.target.checked)} />
          시스템 메시지 {systemCount}개 보기
        </label>
      )}

      {/* Constrain the virtualized list so only comments scroll, not the composer. */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <CommentList
          comments={visible}
          onImagePreview={onPreview}
          onSetCommentStatus={onSetCommentStatus ? (commentId, status) => onSetCommentStatus(ticket.id, commentId, status) : undefined}
          onReply={startReply}
          replyingToCommentId={replyingTo?.id || null}
          lastReadAt={lastReadAt}
          scrollToCommentId={scrollToCommentId ?? null}
          onScrollToCommentConsumed={onScrollToCommentConsumed}
          onLoadOlder={loadOlder}
          hasMoreOlder={hasMore}
          loadingOlder={loadingOlder}
          ticketIdForMentions={ticket.id}
        />
      </div>

      <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10, marginTop: 8, minWidth: 0, flexShrink: 0 }}>
        {replyingTo && (
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, padding: '5px 8px',
            borderLeft: `3px solid ${tokens.colors.info}`, background: tokens.colors.surfaceSubtle,
            borderRadius: tokens.radii.md, fontSize: '11px', color: tokens.colors.textMuted,
          }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              ↪ {replyingTo.author}: {replyingTo.preview}
            </span>
            <button type="button" onClick={() => setReplyingTo(null)} aria-label="답변 취소" style={{ background: 'none', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer' }}>✕</button>
          </div>
        )}
        {staged.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 6 }}>
            {staged.map(s => (
              <span key={s.key} style={{
                display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
                background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '3px 6px', fontSize: '11px', color: tokens.colors.textSecondary,
              }}>
                {s.file.type.startsWith('image/')
                  ? <img src={s.previewUrl} alt="" style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: tokens.radii.sm }} />
                  : <span aria-hidden="true">📎</span>}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>{s.file.name}</span>
                <button type="button" onClick={() => unstage(s.key)} aria-label={`${s.file.name} 빼기`} style={{ background: 'none', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer', padding: 0 }}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', minWidth: 0 }}>
          <button type="button" onClick={pickFiles} disabled={sending} title="파일 첨부" aria-label="파일 첨부" style={{ ...panelButton('plain', sending), padding: '6px 9px' }}>📎</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <MentionTextarea
              rows={2}
              value={content}
              onChange={setContent}
              candidates={candidates}
              onSubmit={() => void send()}
              placeholder={replyingTo ? '답변을 적으세요…' : `${user?.name ? `${user.name}(으)로 ` : ''}코멘트 작성… (@로 멘션)`}
              ariaLabel="코멘트"
              style={{
                width: '100%', boxSizing: 'border-box', background: tokens.colors.surfaceCard,
                border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                padding: '6px 10px', color: tokens.colors.textStrong, fontSize: '13px',
                resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5, outline: 'none', ...wrapText,
              }}
            />
          </div>
          <button type="button" onClick={() => void send()} disabled={!content.trim() || sending} style={panelButton('primary', !content.trim() || sending)}>
            {sending ? '보내는 중…' : '보내기'}
          </button>
        </div>
      </div>
    </div>
  );
}
