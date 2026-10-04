import React, { useMemo, useState } from 'react';
import type { TicketCard } from '../../types';
import { tokens } from '../../tokens';
import { TICKET_PRIORITY_LABELS, ticketStatusColor, ticketStatusLabel } from '../../tickets/status';
import {
  DEFAULT_TICKET_SORT,
  nextSort,
  sortTickets,
  type TicketSort,
  type TicketSortKey,
} from '../../tickets/ticketList';
import { relativeTime } from '../../utils/time';
import { NavBadge } from '../common/NavBadge';

interface TicketListViewProps {
  tickets: TicketCard[];
  activeTicketId: string | null;
  onOpen(ticket: TicketCard): void;
  unreadFor(ticket: TicketCard): number;
  assigneeLabelFor(ticket: TicketCard): string;
  projectNames: Record<string, string>;
  hostNames: Record<string, string>;
  onTagClick?(tag: string): void;
}

const COLUMNS: Array<{ key: TicketSortKey; label: string; width?: string | number }> = [
  { key: 'title', label: 'Title' },
  { key: 'status', label: 'Status', width: 120 },
  { key: 'priority', label: 'Priority', width: 90 },
  { key: 'tags', label: 'Tags', width: '18%' },
  { key: 'project', label: 'Project', width: 140 },
  { key: 'assignee', label: 'Assignee', width: 180 },
  { key: 'updated', label: 'Updated', width: 100 },
];

const cell: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 12,
  color: tokens.colors.textSecondary,
  borderBottom: `1px solid ${tokens.colors.border}`,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  verticalAlign: 'middle',
};

/** Sortable table of the filtered pool (root tickets). Click a row to open it. */
export default function TicketListView({
  tickets,
  activeTicketId,
  onOpen,
  unreadFor,
  assigneeLabelFor,
  projectNames,
  hostNames,
  onTagClick,
}: TicketListViewProps) {
  const [sort, setSort] = useState<TicketSort>(DEFAULT_TICKET_SORT);
  const rows = useMemo(
    () => sortTickets(tickets, sort, { projectNames, hostNames }),
    [tickets, sort, projectNames, hostNames],
  );

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '8px 16px 16px' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
        <thead>
          <tr>
            {COLUMNS.map((c) => {
              const active = sort.key === c.key;
              return (
                <th
                  key={c.key}
                  scope="col"
                  aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                  style={{ ...cell, width: c.width, textAlign: 'left', fontWeight: 700, color: tokens.colors.textMuted, position: 'sticky', top: 0, background: tokens.colors.surface }}
                >
                  <button
                    type="button"
                    onClick={() => setSort((s) => nextSort(s, c.key))}
                    style={{
                      border: 'none', background: 'transparent', padding: 0, cursor: 'pointer',
                      color: active ? tokens.colors.textPrimary : tokens.colors.textMuted,
                      fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em',
                      fontFamily: 'inherit',
                    }}
                  >
                    {c.label}{active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => {
            const unread = unreadFor(t);
            const assignee = assigneeLabelFor(t);
            const selected = t.id === activeTicketId;
            return (
              <tr
                key={t.id}
                data-ticket-row={t.id}
                onClick={() => onOpen(t)}
                aria-selected={selected}
                style={{ cursor: 'pointer', background: selected ? tokens.colors.surfaceHover : 'transparent' }}
              >
                <td style={{ ...cell, color: tokens.colors.textStrong, fontWeight: 600 }} title={t.title}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%' }}>
                    {(t.pending_user_action || t.pending_on_tickets || t.pending_ci_wait) && (
                      <span title="Pending — not dispatched" aria-label="Pending" style={{ color: tokens.colors.warningLight }}>⏸</span>
                    )}
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.title}</span>
                    {unread > 0 && <NavBadge count={unread} size="sm" label={`읽지 않은 코멘트 ${unread}건`} />}
                    {t.children?.length > 0 && (
                      <span style={{ fontSize: 10, color: tokens.colors.textMuted }}>
                        {t.children.filter((c) => c.status === 'done').length}/{t.children.length}
                      </span>
                    )}
                  </span>
                </td>
                <td style={cell}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: ticketStatusColor(t.status) }} />
                    {ticketStatusLabel(t.status)}
                  </span>
                </td>
                <td style={cell}>{TICKET_PRIORITY_LABELS[t.priority] || t.priority}</td>
                <td style={cell} title={(t.tags || []).map((x) => `#${x}`).join(' ')}>
                  {(t.tags || []).map((tag) => (
                    <span
                      key={tag}
                      onClick={onTagClick ? (e) => { e.stopPropagation(); onTagClick(tag); } : undefined}
                      style={{ marginRight: 6, color: tokens.colors.accentSubtle, cursor: onTagClick ? 'pointer' : 'default' }}
                    >#{tag}</span>
                  ))}
                </td>
                <td style={cell} title={t.project_id ? projectNames[t.project_id] || t.project_id : ''}>
                  {t.project_id ? projectNames[t.project_id] || '—' : '—'}
                </td>
                <td style={{ ...cell, fontStyle: assignee ? 'normal' : 'italic', color: assignee ? tokens.colors.textSecondary : tokens.colors.textMuted }} title={assignee || '미지정'}>
                  {assignee || '미지정'}
                </td>
                <td style={cell} title={t.updated_at ? new Date(t.updated_at).toLocaleString() : ''}>
                  {t.updated_at ? relativeTime(t.updated_at) : ''}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
