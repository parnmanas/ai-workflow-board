import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tokens } from '../../tokens';
import { useMentions } from '../../hooks/useMentions';
import { UserMentionItem } from '../../api';

interface Props {
  workspaceId: string | null;
}

/**
 * Sidebar unread-mentions badge + inbox drop-down.
 *
 * Clicking the badge toggles a drop-down that lists unread mentions newest
 * first. Clicking an item navigates to the source (ticket or chat room) and
 * marks the single mention as read. A "Clear all" button marks the whole set.
 */
export function MentionInboxBadge({ workspaceId }: Props) {
  const navigate = useNavigate();
  const { unreadCount, unreadItems, markRead, markAllRead } = useMentions(workspaceId);
  const [open, setOpen] = useState(false);

  const navigateTo = async (item: UserMentionItem) => {
    await markRead(item.id);
    setOpen(false);
    if (item.source_type === 'comment' && item.ticket_id && workspaceId) {
      // Ticket detail panel opens via query param on the board view.
      // We don't know the board id here, so surface the ticket via the
      // workspace default — Board.tsx reads `?ticket=<id>` and opens the panel.
      navigate(`/ws/${workspaceId}/boards?ticket=${encodeURIComponent(item.ticket_id)}`);
    } else if (item.source_type === 'chat_message' && item.room_id && workspaceId) {
      navigate(`/ws/${workspaceId}/chat?room=${encodeURIComponent(item.room_id)}`);
    }
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={() => setOpen(v => !v)}
        aria-label={`${unreadCount} unread mentions`}
        style={{
          position: 'relative',
          background: unreadCount > 0 ? tokens.colors.accent : 'transparent',
          color: unreadCount > 0 ? 'white' : tokens.colors.textSecondary,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          padding: '4px 8px',
          fontSize: 12,
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        @ {unreadCount > 0 ? unreadCount : ''}
      </button>

      {open && (
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 1199 }}
          />
          <div
            role="menu"
            style={{
              position: 'absolute',
              top: 'calc(100% + 6px)',
              left: 0,
              zIndex: 1200,
              minWidth: 320,
              maxWidth: 420,
              maxHeight: 420,
              overflowY: 'auto',
              background: tokens.colors.surfaceCard,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              boxShadow: tokens.shadows.panel,
              padding: 8,
            }}
          >
            <div style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '4px 8px', marginBottom: 6,
            }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textStrong }}>
                Mentions ({unreadCount})
              </span>
              {unreadCount > 0 && (
                <button
                  onClick={markAllRead}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: tokens.colors.accent,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Mark all read
                </button>
              )}
            </div>

            {unreadItems.length === 0 ? (
              <div style={{ padding: 16, textAlign: 'center', color: tokens.colors.textMuted, fontSize: 12 }}>
                No unread mentions.
              </div>
            ) : (
              unreadItems.map(item => (
                <button
                  key={item.id}
                  onClick={() => navigateTo(item)}
                  style={{
                    width: '100%',
                    padding: 8,
                    background: 'transparent',
                    border: 'none',
                    borderRadius: tokens.radii.sm,
                    textAlign: 'left',
                    cursor: 'pointer',
                    fontFamily: 'inherit',
                    color: tokens.colors.textStrong,
                    display: 'block',
                    marginBottom: 2,
                  }}
                  onMouseEnter={e => { (e.currentTarget as HTMLButtonElement).style.background = tokens.colors.surface; }}
                  onMouseLeave={e => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                >
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 2 }}>
                    {item.actor_name || 'someone'} · {item.source_type === 'comment' ? 'comment' : 'chat'}
                    {' · '}
                    {new Date(item.created_at).toLocaleString()}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: tokens.colors.textStrong,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {item.preview || '(no preview)'}
                  </div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
