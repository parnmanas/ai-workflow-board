import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { tokens } from '../../tokens';
import { useMentions } from '../../hooks/useMentions';
import { useToast } from '../../contexts/ToastContext';
import { api, UserMentionItem } from '../../api';
import { renderMentionPreview } from '../../utils/mentionPreview';
import { NavBadge } from './NavBadge';

interface Props {
  workspaceId: string | null;
}

/** Where the mention came from. Anything unrecognised says so rather than
 *  silently being labelled "chat" — the old ternary called every non-comment
 *  source "chat", so a row whose source_type never arrived claimed to be a
 *  chat message and then navigated nowhere. */
function sourceLabel(sourceType: string | null | undefined): string {
  if (sourceType === 'comment') return '티켓 코멘트';
  if (sourceType === 'chat_message') return '채팅';
  return '알 수 없음';
}

/** Empty string for a missing/uninterpretable timestamp so the row omits the
 *  segment instead of printing "Invalid Date". */
function formatMentionTime(value: string | null | undefined): string {
  if (!value) return '';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/**
 * Sidebar unread-mentions badge + inbox drop-down.
 *
 * Clicking the badge toggles a drop-down that lists unread mentions newest
 * first. Clicking an item navigates to the source (ticket or chat room) and
 * marks the single mention as read. A "Clear all" button marks the whole set.
 *
 * Every row must be navigable — an unread mention you cannot open is just a
 * number that will not go away.
 */
export function MentionInboxBadge({ workspaceId }: Props) {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const { unreadCount, unreadItems, hasMoreThanListed, refresh, markRead, markAllRead } = useMentions(workspaceId);
  const [open, setOpen] = useState(false);

  // Re-fetch the list every time the drop-down opens.
  //
  // The badge count and this list are cleared by different things: reading a
  // ticket thread or a chat room clears the mentions pointing into it
  // server-side (the count follows via `mentions_cleared`), but this locally
  // held list has no way to know which rows those were. Refreshing at open
  // time means the rows on screen are always the rows the server still counts
  // as unread — no "badge says 1, list shows 4" drift, whatever cleared them.
  const openInbox = () => {
    setOpen((v) => {
      const next = !v;
      if (next) void refresh();
      return next;
    });
  };

  const navigateTo = async (item: UserMentionItem) => {
    setOpen(false);
    void markRead(item.id);

    if (item.source_type === 'chat_message' && item.room_id && workspaceId) {
      // Chat deep link: the canonical route selects the room and `?message=`
      // scrolls to and highlights the targeted message.
      const roomParam = encodeURIComponent(item.room_id);
      const messageParam = encodeURIComponent(item.source_id);
      navigate(`/ws/${workspaceId}/chat/${roomParam}?message=${messageParam}`);
      return;
    }

    if (item.source_type === 'comment' && item.ticket_id && workspaceId) {
      const ticketParam = encodeURIComponent(item.ticket_id);
      const commentParam = encodeURIComponent(item.source_id);
      // `board_id` is best-effort: rows delivered live over SSE from the MCP
      // comment paths carry none, and a ticket can be moved to another board
      // after the mention was stored. Resolve it at click time from the
      // ticket itself (GET /tickets/:id walks the parent chain server-side)
      // rather than routing to a board-less URL, which no page consumed —
      // the click silently did nothing.
      let boardId = item.board_id;
      if (!boardId) {
        try {
          const ticket: any = await api.getTicket(item.ticket_id);
          boardId = ticket?.board_id ?? null;
        } catch {
          boardId = null;
        }
      }
      if (!boardId) {
        showToast('이 멘션이 가리키는 티켓을 찾을 수 없습니다 (삭제되었거나 접근 권한이 없습니다)', 'error');
        return;
      }
      navigate(
        `/ws/${workspaceId}/boards/${encodeURIComponent(boardId)}?ticket=${ticketParam}&comment=${commentParam}`,
      );
      return;
    }

    showToast('이 멘션은 연결된 대상이 없습니다', 'error');
  };

  return (
    <div style={{ position: 'relative' }}>
      <button
        onClick={openInbox}
        aria-label={unreadCount > 0 ? `읽지 않은 멘션 ${unreadCount}건` : '멘션 함 (읽지 않은 항목 없음)'}
        title={unreadCount > 0 ? `읽지 않은 멘션 ${unreadCount}건` : '멘션'}
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 4,
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
        <span aria-hidden="true">@</span>
        {/* Same NavBadge every other nav count uses, so "3" here and "3" in
            the nav rows are visually the same object — and it caps at 99+
            instead of stretching the sidebar header. */}
        {unreadCount > 0 && <NavBadge count={unreadCount} label={`읽지 않은 멘션 ${unreadCount}건`} />}
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
              <>
              {/* The list is server-capped; say so instead of letting the
                  header count silently disagree with the rows below it. */}
              {hasMoreThanListed && (
                <div style={{ padding: '4px 8px 6px', fontSize: 10, color: tokens.colors.textMuted }}>
                  최근 {unreadItems.length}건만 표시 · 전체 {unreadCount}건
                </div>
              )}
              {unreadItems.map(item => (
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
                    {item.actor_name || '누군가'} · {sourceLabel(item.source_type)}
                    {formatMentionTime(item.created_at) && ` · ${formatMentionTime(item.created_at)}`}
                  </div>
                  <div style={{
                    fontSize: 12,
                    color: tokens.colors.textStrong,
                    overflow: 'hidden',
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                  }}>
                    {/* The stored preview is a raw slice of the comment /
                        message and still contains `@[user:<uuid>|이름]`
                        tokens, which used to render literally here. */}
                    {renderMentionPreview(item.preview) || '(내용 없음)'}
                  </div>
                </button>
              ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
