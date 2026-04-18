import React, { useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Comment } from '../types';
import { tokens } from '../tokens';
import { renderMarkdown, handleMentionAwareCopy } from './chat/utils/markdown';

interface CommentListProps {
  comments: Comment[];
  onImagePreview?: (src: string) => void;
}

export default function CommentList({ comments, onImagePreview }: CommentListProps) {
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
          const isSystem = c.author_type === 'system';
          const isAgent = c.author_type === 'agent';
          const badgeConfig = isSystem
            ? { bg: tokens.colors.badgeSystemBg, color: tokens.colors.badgeSystemText, label: 'System' }
            : isAgent
            ? { bg: tokens.colors.badgeAgentBg, color: tokens.colors.accentLight, label: 'Agent' }
            : { bg: tokens.colors.badgeUserBg, color: tokens.colors.infoLight, label: 'User' };
          const images = c.images || [];

          return (
            <div
              key={`comment-${c.id}`}
              ref={virtualizer.measureElement}
              data-index={virtualItem.index}
              style={{
                position: 'absolute', top: virtualItem.start, left: 0, right: 0,
                background: isSystem ? tokens.colors.badgeSystemSurface : isAgent ? tokens.colors.surfaceSubtle : tokens.colors.surface,
                border: `1px solid ${isSystem ? tokens.colors.badgeSystemBorder : tokens.colors.border}`,
                borderRadius: tokens.radii.lg,
                padding: isSystem ? '8px 12px' : 10,
                marginBottom: 6,
                ...(isSystem ? { borderLeft: `3px solid ${tokens.colors.badgeSystemText}` } : {}),
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: isSystem ? 2 : 5 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <span style={{
                    fontSize: '10px', fontWeight: 700, padding: '1px 6px', borderRadius: tokens.radii.sm,
                    background: badgeConfig.bg, color: badgeConfig.color, textTransform: 'uppercase',
                  }}>{badgeConfig.label}</span>
                  {!isSystem && (
                    <span style={{ fontSize: '12px', fontWeight: 600, color: badgeConfig.color }}>{c.author}</span>
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
                  fontSize: isSystem ? '12px' : '13px',
                  color: isSystem ? tokens.colors.badgeSystemText : tokens.colors.textDisabled,
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
