import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Comment } from '../types';
import { tokens } from '../tokens';

interface CommentGroup {
  key: string;
  author: string;
  author_type: 'user' | 'agent' | 'system';
  comments: Comment[];
  isCollapsed: boolean; // default: true for agent groups with >1 comment
}

type FlatItem =
  | { kind: 'group-header'; group: CommentGroup; groupIndex: number }
  | { kind: 'comment'; comment: Comment; groupIndex: number; isLastInGroup: boolean };

interface CommentListProps {
  comments: Comment[];
  onImagePreview?: (src: string) => void;
}

function groupComments(comments: Comment[]): CommentGroup[] {
  const groups: CommentGroup[] = [];
  for (const c of comments) {
    const last = groups[groups.length - 1];
    if (last && last.author === c.author && last.author_type === c.author_type) {
      last.comments.push(c);
    } else {
      groups.push({
        key: `${c.author}-${groups.length}`,
        author: c.author,
        author_type: c.author_type,
        comments: [c],
        isCollapsed: c.author_type === 'agent',
      });
    }
  }
  return groups;
}

export default function CommentList({ comments, onImagePreview }: CommentListProps) {
  const groups = useMemo(() => groupComments(comments), [comments]);

  // Parallel boolean array — tracks collapsed state per group
  const [groupStates, setGroupStates] = useState<boolean[]>(() =>
    groups.map(g => g.isCollapsed)
  );

  // Re-initialize when comments change (ticket switches or new comments)
  useEffect(() => {
    setGroupStates(groups.map(g => g.isCollapsed));
  }, [comments]);

  const toggleGroup = (groupIndex: number) => {
    setGroupStates(prev => prev.map((v, i) => i === groupIndex ? !v : v));
  };

  // Build flat items for virtualizer
  const flatItems = useMemo<FlatItem[]>(() => {
    const items: FlatItem[] = [];
    groups.forEach((group, groupIndex) => {
      const isCollapsed = groupStates[groupIndex] ?? group.isCollapsed;
      const isAgentMulti = group.author_type === 'agent' && group.comments.length > 1;

      if (isAgentMulti) {
        // Emit group header
        items.push({ kind: 'group-header', group, groupIndex });
        if (isCollapsed) {
          // Show only the last comment
          const last = group.comments[group.comments.length - 1];
          items.push({ kind: 'comment', comment: last, groupIndex, isLastInGroup: true });
        } else {
          // Show all comments
          group.comments.forEach((c, ci) => {
            items.push({ kind: 'comment', comment: c, groupIndex, isLastInGroup: ci === group.comments.length - 1 });
          });
        }
      } else {
        // Human / system / single-comment agent — no header, show all
        group.comments.forEach((c, ci) => {
          items.push({ kind: 'comment', comment: c, groupIndex, isLastInGroup: ci === group.comments.length - 1 });
        });
      }
    });
    return items;
  }, [groups, groupStates]);

  const parentRef = useRef<HTMLDivElement>(null);

  const virtualizer = useVirtualizer({
    count: flatItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 60,
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
          const item = flatItems[virtualItem.index];

          if (item.kind === 'group-header') {
            const isCollapsed = groupStates[item.groupIndex] ?? item.group.isCollapsed;
            return (
              <div
                key={`header-${item.groupIndex}`}
                ref={virtualizer.measureElement}
                data-index={virtualItem.index}
                onClick={() => toggleGroup(item.groupIndex)}
                style={{
                  position: 'absolute', top: virtualItem.start, left: 0, right: 0,
                  background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                  padding: '6px 10px', cursor: 'pointer',
                  display: 'flex', justifyContent: 'space-between', marginBottom: 4,
                }}
              >
                <span style={{ fontSize: '11px', color: tokens.colors.accentLight, fontWeight: 600 }}>
                  {item.group.author} — {item.group.comments.length} messages
                </span>
                <span style={{ fontSize: '10px', color: tokens.colors.textMuted }}>
                  {isCollapsed ? 'expand' : 'collapse'}
                </span>
              </div>
            );
          }

          // kind === 'comment'
          const c = item.comment;
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
              {/* Comment content rendered as text node — never dangerouslySetInnerHTML (T-05-02-01) */}
              <p style={{
                fontSize: isSystem ? '12px' : '13px',
                color: isSystem ? tokens.colors.badgeSystemText : tokens.colors.textDisabled,
                lineHeight: 1.5, whiteSpace: 'pre-wrap', margin: 0,
              }}>{c.content}</p>
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
