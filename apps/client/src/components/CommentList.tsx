import React, { useRef, useMemo } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Comment } from '../types';
import { tokens } from '../tokens';
import { renderMarkdown, handleMentionAwareCopy } from './chat/utils/markdown';
import { COMMENT_TYPE_STYLES, resolveCommentType } from './comment-types';

interface CommentListProps {
  comments: Comment[];
  onImagePreview?: (src: string) => void;
  // Phase 2B: lets the question OPEN/RESOLVED pill double as a toggle.
  // Optional so embeddings without question support can omit it.
  onSetCommentStatus?: (commentId: string, status: 'open' | 'resolved') => void;
  // Phase 2C: "Answer" button on open questions. Parent owns the reply state
  // (which question is being answered) so compose-area UX can show a banner.
  onReply?: (commentId: string) => void;
  // Highlight the row currently being replied to so the reply banner doesn't
  // feel disconnected from the question card.
  replyingToCommentId?: string | null;
}

export default function CommentList({ comments, onImagePreview, onSetCommentStatus, onReply, replyingToCommentId }: CommentListProps) {
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
          const images = c.images || [];

          const isReplyTarget = replyingToCommentId === c.id;
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
                </div>
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                  {new Date(c.created_at).toLocaleString()}
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
              {images.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                  {images.map((img, idx) => (
                    <img
                      key={idx}
                      src={`data:${img.mimetype};base64,${img.data}`}
                      alt={img.filename}
                      onClick={() => onImagePreview?.(`data:${img.mimetype};base64,${img.data}`)}
                      style={{
                        width: 70, height: 70, objectFit: 'cover', borderRadius: tokens.radii.sm,
                        cursor: onImagePreview ? 'pointer' : 'default',
                        border: `1px solid ${tokens.colors.border}`,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
