import React, { useRef, useMemo, useCallback } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Comment, CommentType } from '../types';
import { tokens } from '../tokens';
import { renderMarkdown, handleMentionAwareCopy } from './chat/utils/markdown';
import { COMMENT_TYPE_STYLES, resolveCommentType } from './comment-types';

interface CommentListProps {
  comments: Comment[];
  // src + mimetype so the modal can pick <img> vs <video>. mimetype is
  // optional so legacy callers (image-only flows) still type-check.
  onImagePreview?: (src: string, mimetype?: string) => void;
  // Phase 2B: lets the question OPEN/RESOLVED pill double as a toggle.
  // Optional so embeddings without question support can omit it.
  onSetCommentStatus?: (commentId: string, status: 'open' | 'resolved') => void;
  // Phase 2C: "Answer" button on open questions. Parent owns the reply state
  // (which question is being answered) so compose-area UX can show a banner.
  onReply?: (commentId: string) => void;
  // Highlight the row currently being replied to so the reply banner doesn't
  // feel disconnected from the question card.
  replyingToCommentId?: string | null;
  // Tier-1 F: comments with created_at > lastReadAt render with an unread
  // cue (small dot + slight tint). Snapshotted by the parent on mount so
  // the cutoff stays stable while the user reads.
  lastReadAt?: string | null;
  // Tier-1 H: per-type notification mute. Comments whose type is in this
  // set keep showing in the list (filter chip controls visibility) but
  // their unread dot is suppressed — "I see this exists, just don't ping me".
  mutedTypes?: Set<CommentType>;
}

export default function CommentList({ comments, onImagePreview, onSetCommentStatus, onReply, replyingToCommentId, lastReadAt, mutedTypes }: CommentListProps) {
  const lastReadMs = lastReadAt ? new Date(lastReadAt).getTime() : null;
  const parentRef = useRef<HTMLDivElement>(null);

  // Phase 2D — visual threading. Comments arrive newest-first from the server.
  // We split them into top-level (no parent_id) and replies (parent_id set),
  // then re-flatten so each top-level row is immediately followed by its
  // replies in chronological (oldest-first) order. This reads naturally:
  //
  //   Q (newest top-level)
  //     ↳ A1 (oldest reply to Q)
  //     ↳ A2 (newer reply to Q)
  //   Q (older top-level)
  //     ↳ A3 …
  //
  // Replies whose parent isn't in the visible set (e.g., the question's type
  // chip is filtered off) fall through as orphan top-level rows so they're
  // never silently dropped.
  const flatRows = useMemo(() => {
    const repliesByParent = new Map<string, Comment[]>();
    const topLevel: Comment[] = [];
    for (const c of comments) {
      if (c.parent_id) {
        const arr = repliesByParent.get(c.parent_id) || [];
        arr.push(c);
        repliesByParent.set(c.parent_id, arr);
      } else {
        topLevel.push(c);
      }
    }
    const out: Array<{ comment: Comment; indent: 0 | 1; orphan?: boolean }> = [];
    const consumed = new Set<string>();
    for (const c of topLevel) {
      out.push({ comment: c, indent: 0 });
      consumed.add(c.id);
      const replies = repliesByParent.get(c.id);
      if (replies) {
        replies
          .slice()
          .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
          .forEach(r => {
            out.push({ comment: r, indent: 1 });
            consumed.add(r.id);
          });
      }
    }
    // Pick up orphans: a reply whose parent is hidden by the current filter.
    for (const c of comments) {
      if (!consumed.has(c.id)) out.push({ comment: c, indent: 0, orphan: true });
    }
    return out;
  }, [comments]);

  const virtualizer = useVirtualizer({
    count: flatRows.length,
    getScrollElement: () => parentRef.current,
    // Rough initial estimate — real heights come from measureElement. Short
    // one-liner comments are ~50px; agent comments with code blocks easily
    // hit 400+. A mid-range estimate minimizes the post-measure correction.
    estimateSize: () => 120,
    // CRITICAL: track measurements by comment id rather than positional index.
    // Without this, prepending a new comment shifts every index by one and
    // the virtualizer reuses the OLD item's measured height for the NEW item,
    // leaving large blank gaps between cards.
    getItemKey: (index) => flatRows[index].comment.id,
    overscan: 5,
  });

  // Internal jump-to-comment for decision reference chips. Lives on the
  // virtualizer so we don't have to plumb scroll state out to TicketPanel —
  // the reference is always inside the same CommentList instance, so a
  // self-contained scrollToIndex is enough. Falls back to no-op if the
  // referenced id isn't currently in the visible (filtered) list.
  const handleJumpToComment = useCallback((commentId: string) => {
    const index = flatRows.findIndex(r => r.comment.id === commentId);
    if (index < 0) return;
    virtualizer.scrollToIndex(index, { align: 'center', behavior: 'smooth' });
  }, [flatRows, virtualizer]);

  if (comments.length === 0) {
    // Same flex: 1 footprint as the populated state so the parent column
    // doesn't collapse and yank the compose input up to the top of the panel.
    // Without this, an empty Comments tab looks visually broken (input glued
    // under the filter chips instead of pinned to the bottom).
    return (
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: tokens.colors.borderStrong, fontSize: '12px', textAlign: 'center',
      }}>
        No comments yet.
      </div>
    );
  }

  return (
    <div ref={parentRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => {
          const row = flatRows[virtualItem.index];
          const c = row.comment;
          const isIndented = row.indent === 1;
          // Indent reply rows under their parent question. left:0/right:0
          // positioning is preserved so the virtualizer's vertical math stays
          // intact; the visual offset comes from paddingLeft on the row wrapper.
          const indentPx = isIndented ? 24 : 0;
          const isAgent = c.author_type === 'agent';
          // Author badge stays driven by author_type so the user/agent/system
          // axis remains visible. Type styling is layered on top (left border,
          // type chip), which means a single comment communicates both axes:
          //   "who said it"  +  "what kind of thing they said".
          const authorBadge = c.author_type === 'system'
            ? { bg: tokens.colors.badgeSystemBg, color: tokens.colors.badgeSystemText, label: 'System' }
            : isAgent
            ? { bg: tokens.colors.badgeAgentBg, color: tokens.colors.accentLight, label: 'Agent' }
            : { bg: tokens.colors.badgeUserBg, color: tokens.colors.infoLight, label: 'User' };
          const ctype = resolveCommentType(c.type as string | null | undefined);
          const tstyle = COMMENT_TYPE_STYLES[ctype];
          const isCompact = ctype === 'system';
          const status = c.status;
          const attachments = c.attachments || [];

          const isReplyTarget = replyingToCommentId === c.id;
          // Tier-1 F: row is unread if created after the user's last read
          // marker. NULL marker means "never read" → everything is unread.
          // Tier-1 H: muted types suppress the unread dot — the user
          // explicitly opted out of being signaled about this type.
          const createdMs = new Date(c.created_at).getTime();
          const isUnreadByTime = lastReadMs === null ? true : createdMs > lastReadMs;
          const isUnread = isUnreadByTime && !(mutedTypes && mutedTypes.has(ctype));
          return (
            <div
              key={`comment-${c.id}`}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute', top: virtualItem.start, left: indentPx, right: 0,
                background: tstyle.bg,
                border: `1px solid ${isReplyTarget ? tstyle.border : tokens.colors.border}`,
                borderLeft: `3px solid ${tstyle.border}`,
                borderRadius: tokens.radii.lg,
                padding: isCompact ? '8px 12px' : 10,
                marginBottom: 6,
                // Subtle outer ring while a reply is being composed for this
                // question, so the user keeps the link in view as they type.
                boxShadow: isReplyTarget ? `0 0 0 2px ${tstyle.border}` : undefined,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isCompact ? 2 : 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                    background: authorBadge.bg, color: authorBadge.color, textTransform: 'uppercase',
                  }}>{authorBadge.label}</span>
                  {/* Type chip — only render for non-default types so the common
                     'note' case stays visually quiet. */}
                  {ctype !== 'note' && (
                    <span title={tstyle.label} style={{
                      fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                      background: 'transparent', color: tstyle.text,
                      border: `1px solid ${tstyle.border}`, textTransform: 'uppercase', letterSpacing: 0.4,
                      display: 'inline-flex', alignItems: 'center', gap: 3,
                    }}>
                      <span aria-hidden="true">{tstyle.icon}</span>
                      <span>{tstyle.label}</span>
                    </span>
                  )}
                  {ctype === 'question' && status === 'open' && onReply && (
                    <button
                      type="button"
                      onClick={() => onReply(c.id)}
                      title="Write an answer to this question"
                      style={{
                        fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                        background: 'transparent', color: tokens.colors.infoLight,
                        border: `1px solid ${tokens.colors.info}`, cursor: 'pointer', textTransform: 'uppercase', letterSpacing: 0.4,
                      }}
                    >{'\u2192'} Answer</button>
                  )}
                  {ctype === 'question' && status && (
                    onSetCommentStatus ? (
                      <button
                        type="button"
                        onClick={() => onSetCommentStatus(c.id, status === 'resolved' ? 'open' : 'resolved')}
                        title={status === 'resolved' ? 'Reopen this question' : 'Mark this question as resolved'}
                        style={{
                          fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                          background: status === 'resolved' ? tokens.colors.successBg : tokens.colors.warningBg,
                          color: status === 'resolved' ? tokens.colors.successPale : tokens.colors.warningLight,
                          border: 'none', cursor: 'pointer', textTransform: 'uppercase',
                        }}
                      >{status === 'resolved' ? '\u2713 Resolved' : 'Open'}</button>
                    ) : (
                      <span style={{
                        fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                        background: status === 'resolved' ? tokens.colors.successBg : tokens.colors.warningBg,
                        color: status === 'resolved' ? tokens.colors.successPale : tokens.colors.warningLight,
                        textTransform: 'uppercase',
                      }}>{status === 'resolved' ? '\u2713 Resolved' : 'Open'}</span>
                    )
                  )}
                  {!isCompact && (
                    <span style={{ fontSize: '12px', fontWeight: 600, color: authorBadge.color }}>{c.author}</span>
                  )}
                  {/* Role badge — surfaces which role an agent commented as
                     when the same agent holds multiple roles on the ticket
                     (e.g. assignee + reviewer). Server stores
                     metadata.author_role on save (see comment-tools.ts
                     resolveAuthorRole); accepts a string slug or an array
                     when the role was ambiguous at write time. */}
                  {!isCompact && isAgent && (() => {
                    const raw = (c.metadata as any)?.author_role;
                    const roles: string[] = Array.isArray(raw)
                      ? raw.filter((s): s is string => typeof s === 'string' && !!s)
                      : typeof raw === 'string' && raw
                        ? [raw]
                        : [];
                    if (roles.length === 0) return null;
                    return roles.map((slug) => (
                      <span
                        key={slug}
                        title={`as ${slug}`}
                        style={{
                          fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                          background: 'transparent', color: tokens.colors.textPrimary,
                          border: `1px solid ${tokens.colors.border}`, textTransform: 'uppercase', letterSpacing: 0.4,
                        }}
                      >as {slug}</span>
                    ));
                  })()}
                </div>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  {/* Tier-1 F unread cue — small accent dot beside the timestamp.
                     Conservative: shown for every unread row, but only when a
                     read marker exists at all (a brand-new ticket with NULL
                     marker would otherwise paint every row as "new", which is
                     just noise on first load). */}
                  {isUnread && lastReadMs !== null && (
                    <span title="Unread" style={{
                      width: 6, height: 6, borderRadius: '50%',
                      background: tokens.colors.accentMid,
                      display: 'inline-block',
                    }} />
                  )}
                  <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                </span>
              </div>
              {/* Comment content — renderMarkdown keeps XSS-safe JSX construction (T-05-02-01)
                 and pills @-mentions (both structured @[type:id|name] tokens and legacy @name). */}
              <p
                onCopy={handleMentionAwareCopy}
                style={{
                  fontSize: isCompact ? '12px' : '13px',
                  color: isCompact ? tstyle.text : tokens.colors.textDisabled,
                  lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0,
                }}
              >{renderMarkdown(c.content)}</p>
              {attachments.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {attachments.map((att) => {
                    const mt = att.file_mimetype || '';
                    const isImage = mt.startsWith('image/');
                    const isVideo = mt.startsWith('video/');
                    const src = `data:${mt || 'application/octet-stream'};base64,${att.file_data}`;
                    if (isImage) {
                      return (
                        <img
                          key={att.id}
                          src={src}
                          alt={att.file_name}
                          onClick={() => onImagePreview?.(src, mt)}
                          title={att.file_name}
                          style={{
                            width: 70, height: 70, objectFit: 'cover', borderRadius: tokens.radii.sm,
                            cursor: onImagePreview ? 'pointer' : 'default',
                            border: `1px solid ${tokens.colors.border}`,
                          }}
                        />
                      );
                    }
                    if (isVideo) {
                      // Inline <video> preview — agents and users get the same
                      // first-class playback affordance as images, no download
                      // round-trip. Click-through opens the modal viewer for
                      // a larger surface.
                      return (
                        <div
                          key={att.id}
                          onClick={() => onImagePreview?.(src, mt)}
                          title={att.file_name}
                          style={{
                            width: 120, height: 70, borderRadius: tokens.radii.sm,
                            cursor: onImagePreview ? 'pointer' : 'default',
                            border: `1px solid ${tokens.colors.border}`,
                            overflow: 'hidden', position: 'relative',
                            background: '#000',
                          }}
                        >
                          <video
                            src={src}
                            muted
                            playsInline
                            preload="metadata"
                            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }}
                          />
                          <span
                            aria-hidden="true"
                            style={{
                              position: 'absolute', inset: 0, display: 'flex',
                              alignItems: 'center', justifyContent: 'center',
                              color: 'rgba(255,255,255,0.85)', fontSize: '24px',
                              textShadow: '0 0 4px rgba(0,0,0,0.7)', pointerEvents: 'none',
                            }}
                          >▶</span>
                        </div>
                      );
                    }
                    return (
                      <a
                        key={att.id}
                        href={src}
                        download={att.file_name}
                        title={att.file_name}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 6,
                          maxWidth: 240, padding: '6px 10px',
                          borderRadius: tokens.radii.sm,
                          background: tokens.colors.surfaceCard,
                          border: `1px solid ${tokens.colors.border}`,
                          color: tokens.colors.textSecondary,
                          fontSize: '12px', textDecoration: 'none',
                        }}
                      >
                        <span aria-hidden="true">📎</span>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.file_name}</span>
                      </a>
                    );
                  })}
                </div>
              )}
              {/* Tier-1 A: decision references footer.
                 record_decision MCP tool stashes referenced comment ids in
                 metadata.references; render them as click-through chips so
                 the curated decision links back to the discussion it draws
                 from. Falls back to a non-clickable "ref:abcd1234" pill when
                 the parent doesn't pass onJumpToComment. */}
              {ctype === 'decision' && Array.isArray((c.metadata as any)?.references) && (c.metadata as any).references.length > 0 && (
                <div style={{
                  marginTop: 8, paddingTop: 6, borderTop: `1px dashed ${tokens.colors.border}`,
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                }}>
                  <span style={{ fontSize: '10px', fontWeight: 700, color: tokens.colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    References:
                  </span>
                  {((c.metadata as any).references as unknown[]).map((rawId, idx) => {
                    if (typeof rawId !== 'string') return null;
                    const refId = rawId;
                    // Show a short suffix so chips stay readable. Full id is
                    // accessible via title/hover for debugging.
                    const label = `ref:${refId.slice(-6)}`;
                    // Disable click when the referenced comment isn't in the
                    // current visible list (filtered out, deleted, or never
                    // existed). Visual cue: muted opacity + default cursor.
                    const inList = flatRows.some(r => r.comment.id === refId);
                    return (
                      <button
                        key={`ref-${refId}-${idx}`}
                        type="button"
                        title={inList ? `Jump to ${refId}` : `${refId} (not in current view)`}
                        disabled={!inList}
                        onClick={inList ? () => handleJumpToComment(refId) : undefined}
                        style={{
                          fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: tokens.radii.sm,
                          background: 'transparent', color: tokens.colors.textDisabled,
                          border: `1px solid ${tokens.colors.border}`,
                          cursor: inList ? 'pointer' : 'default',
                          opacity: inList ? 1 : 0.5,
                          fontFamily: 'monospace',
                        }}
                      >{label}</button>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
