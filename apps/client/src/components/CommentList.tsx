import React, { useRef } from 'react';
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
}

export default function CommentList({ comments, onImagePreview, onSetCommentStatus }: CommentListProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: comments.length,
    getScrollElement: () => parentRef.current,
    // Rough initial estimate — real heights come from measureElement. Short
    // one-liner comments are ~50px; agent comments with code blocks easily
    // hit 400+. A mid-range estimate minimizes the post-measure correction.
    estimateSize: () => 120,
    // CRITICAL: track measurements by comment id rather than positional index.
    // Without this, prepending a new comment shifts every index by one and
    // the virtualizer reuses the OLD item's measured height for the NEW item,
    // leaving large blank gaps between cards.
    getItemKey: (index) => comments[index].id,
    overscan: 5,
  });

  if (comments.length === 0) {
    return (
      <div style={{ padding: '12px 0', color: tokens.colors.borderStrong, fontSize: '12px', textAlign: 'center' }}>
        No comments yet.
      </div>
    );
  }

  return (
    <div ref={parentRef} style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
      <div style={{ height: `${virtualizer.getTotalSize()}px`, position: 'relative' }}>
        {virtualizer.getVirtualItems().map(virtualItem => {
          const c = comments[virtualItem.index];
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

          return (
            <div
              key={`comment-${c.id}`}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute', top: virtualItem.start, left: 0, right: 0,
                background: tstyle.bg,
                border: `1px solid ${tokens.colors.border}`,
                borderLeft: `3px solid ${tstyle.border}`,
                borderRadius: tokens.radii.lg,
                padding: isCompact ? '8px 12px' : 10,
                marginBottom: 6,
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
