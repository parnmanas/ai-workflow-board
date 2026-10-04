import React, { useEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import type { Project } from '../../types';
import {
  TICKET_STATUSES,
  TICKET_STATUS_LABELS,
  ticketStatusColor,
} from '../../tickets/status';
import {
  EMPTY_TICKET_FILTERS,
  hasActiveFilters,
  toggleInList,
  type TicketFilters,
} from '../../tickets/ticketFilters';
import type { AssigneeOption } from '../../tickets/assignee';
import type { TicketView } from '../../tickets/ticketList';

interface TicketFilterBarProps {
  filters: TicketFilters;
  onChange(next: TicketFilters): void;
  tagFacet: Array<{ tag: string; count: number; selected: boolean }>;
  projects: Project[];
  assigneeOptions: AssigneeOption[];
  view: TicketView;
  onViewChange(view: TicketView): void;
}

const SEARCH_DEBOUNCE_MS = 300;
const VISIBLE_TAGS = 14;

const chipStyle = (active: boolean, color?: string): React.CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  padding: '3px 10px',
  borderRadius: 14,
  border: `1px solid ${active ? (color || tokens.colors.accent) : tokens.colors.border}`,
  background: active ? `${color || tokens.colors.accent}26` : 'transparent',
  color: active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
  fontSize: 12,
  fontWeight: active ? 600 : 500,
  cursor: 'pointer',
  fontFamily: 'inherit',
  whiteSpace: 'nowrap',
});

const selectStyle: React.CSSProperties = {
  background: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  color: tokens.colors.textStrong,
  fontSize: 12,
  padding: '5px 8px',
  fontFamily: 'inherit',
  maxWidth: 220,
};

/**
 * Tickets filter bar. Every control writes straight through `onChange`; the
 * page turns that into the URL query (so views are shareable) and the list
 * request. Only the free-text box is debounced.
 */
export default function TicketFilterBar({
  filters,
  onChange,
  tagFacet,
  projects,
  assigneeOptions,
  view,
  onViewChange,
}: TicketFilterBarProps) {
  const [q, setQ] = useState(filters.q);
  const [showAllTags, setShowAllTags] = useState(false);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  // External changes (back/forward, "clear") win over the local draft.
  useEffect(() => { setQ(filters.q); }, [filters.q]);

  useEffect(() => {
    if (q === filtersRef.current.q) return;
    const timer = setTimeout(() => onChange({ ...filtersRef.current, q }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, onChange]);

  const set = (patch: Partial<TicketFilters>) => onChange({ ...filters, ...patch });
  const tags = showAllTags ? tagFacet : tagFacet.slice(0, Math.max(VISIBLE_TAGS, tagFacet.filter((t) => t.selected).length));
  const hiddenTagCount = tagFacet.length - tags.length;
  const projectKnown = !filters.projectId || projects.some((p) => p.id === filters.projectId);
  const assigneeKnown = !filters.assigneeKey || assigneeOptions.some((a) => a.key === filters.assigneeKey);

  return (
    <div
      data-testid="ticket-filter-bar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 16px',
        borderBottom: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surface,
        flexShrink: 0,
      }}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
        <input
          type="search"
          aria-label="티켓 검색"
          placeholder="검색 (제목·설명)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ ...selectStyle, minWidth: 200, maxWidth: 280, padding: '6px 10px' }}
        />
        <div role="group" aria-label="상태 필터" style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {TICKET_STATUSES.map((s) => {
            const active = filters.statuses.includes(s);
            return (
              <button
                key={s}
                type="button"
                aria-pressed={active}
                onClick={() => set({ statuses: toggleInList(filters.statuses, s) })}
                style={chipStyle(active, ticketStatusColor(s))}
              >
                <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: ticketStatusColor(s) }} />
                {TICKET_STATUS_LABELS[s]}
              </button>
            );
          })}
        </div>
        <select
          aria-label="프로젝트 필터"
          value={filters.projectId}
          onChange={(e) => set({ projectId: e.target.value })}
          style={selectStyle}
        >
          <option value="">모든 프로젝트</option>
          {!projectKnown && <option value={filters.projectId}>(알 수 없는 프로젝트)</option>}
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select
          aria-label="담당자 필터"
          value={filters.assigneeKey}
          onChange={(e) => set({ assigneeKey: e.target.value })}
          style={selectStyle}
        >
          <option value="">모든 담당자</option>
          {!assigneeKnown && <option value={filters.assigneeKey}>(선택된 담당자)</option>}
          {assigneeOptions.map((a) => (
            <option key={a.key} value={a.key}>{a.label} ({a.count})</option>
          ))}
        </select>
        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={filters.archived}
            onChange={(e) => set({ archived: e.target.checked })}
          />
          보관된 티켓
        </label>
        {hasActiveFilters(filters) && (
          <button
            type="button"
            onClick={() => onChange({ ...EMPTY_TICKET_FILTERS })}
            style={{ ...chipStyle(false), border: 'none', color: tokens.colors.accent }}
          >
            필터 지우기
          </button>
        )}
        <div style={{ flex: 1 }} />
        <div role="group" aria-label="보기" style={{ display: 'inline-flex', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md, overflow: 'hidden' }}>
          {(['kanban', 'list'] as TicketView[]).map((v) => (
            <button
              key={v}
              type="button"
              aria-pressed={view === v}
              onClick={() => onViewChange(v)}
              style={{
                border: 'none',
                padding: '5px 12px',
                fontSize: 12,
                fontWeight: 600,
                fontFamily: 'inherit',
                cursor: 'pointer',
                background: view === v ? tokens.colors.accent : 'transparent',
                color: view === v ? '#fff' : tokens.colors.textSecondary,
              }}
            >
              {v === 'kanban' ? 'Kanban' : 'List'}
            </button>
          ))}
        </div>
      </div>

      {tagFacet.length > 0 && (
        <div role="group" aria-label="태그 필터 (모두 포함)" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 11, color: tokens.colors.textMuted, marginRight: 4 }}>태그</span>
          {tags.map((t) => (
            <button
              key={t.tag}
              type="button"
              aria-pressed={t.selected}
              title={t.selected ? `#${t.tag} 필터 해제` : `#${t.tag} 가 붙은 티켓만 (다른 선택 태그와 AND)`}
              onClick={() => set({ tags: toggleInList(filters.tags, t.tag) })}
              style={chipStyle(t.selected)}
            >
              #{t.tag}
              <span style={{ fontSize: 10, color: tokens.colors.textMuted }}>{t.count}</span>
            </button>
          ))}
          {(hiddenTagCount > 0 || showAllTags) && tagFacet.length > VISIBLE_TAGS && (
            <button
              type="button"
              onClick={() => setShowAllTags((v) => !v)}
              style={{ ...chipStyle(false), border: 'none', color: tokens.colors.accent }}
            >
              {showAllTags ? '접기' : `+${hiddenTagCount}개 더`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
