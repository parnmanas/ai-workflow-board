import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import type { Project } from '../../types';
import { TICKET_STATUSES, TICKET_STATUS_LABELS, ticketStatusColor } from '../../tickets/status';
import { EMPTY_TICKET_FILTERS, hasActiveFilters, toggleInList, type TicketFilters } from '../../tickets/ticketFilters';
import type { AssigneeOption } from '../../tickets/assignee';
import type { TicketView } from '../../tickets/ticketList';
import { Button, Modal } from '../common';

interface TicketFilterBarProps {
  filters: TicketFilters;
  onChange(next: TicketFilters): void;
  tagFacet: Array<{ tag: string; count: number; selected: boolean }>;
  projects: Project[];
  assigneeOptions: AssigneeOption[];
  view: TicketView;
  onViewChange(view: TicketView): void;
  ticketCount: number;
  unreadCount: number;
  onCreate(): void;
  onMarkAllRead(): void;
}

const SEARCH_DEBOUNCE_MS = 300;
const VISIBLE_TAGS = 14;

const chipStyle = (active: boolean, color?: string): React.CSSProperties => ({
  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 10px',
  borderRadius: tokens.radii.md,
  border: `1px solid ${active ? (color || tokens.colors.accent) : tokens.colors.border}`,
  background: active ? `${color || tokens.colors.accent}26` : 'transparent',
  color: active ? tokens.colors.textPrimary : tokens.colors.textSecondary,
  fontSize: 12, fontWeight: active ? 600 : 500, cursor: 'pointer', fontFamily: 'inherit',
  maxWidth: '100%', overflowWrap: 'anywhere',
});
const selectStyle: React.CSSProperties = {
  background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md, color: tokens.colors.textStrong, fontSize: 13,
  padding: '8px 10px', fontFamily: 'inherit', width: '100%', minWidth: 0, boxSizing: 'border-box',
};
const fieldStyle: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0, fontSize: 12, color: tokens.colors.textSecondary };
const groupStyle: React.CSSProperties = { display: 'flex', flexWrap: 'wrap', gap: 6 };

/** Search stays in the toolbar; filters and view settings share a bounded dialog.
 * Filters still write through to the URL immediately, including while the menu is closed. */
export default function TicketFilterBar({
  filters, onChange, tagFacet, projects, assigneeOptions, view, onViewChange,
  ticketCount, unreadCount, onCreate, onMarkAllRead,
}: TicketFilterBarProps) {
  useLocale();
  const [q, setQ] = useState(filters.q);
  const [menuOpen, setMenuOpen] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);
  const filtersRef = useRef(filters);
  // Router navigation can commit after the next input event. Keep pending edits
  // together until the URL props catch up, including across local menu renders.
  useLayoutEffect(() => { filtersRef.current = filters; }, [filters]);
  const set = useCallback((patch: Partial<TicketFilters>) => {
    const next = { ...filtersRef.current, ...patch };
    filtersRef.current = next;
    onChange(next);
  }, [onChange]);
  useEffect(() => { setQ(filters.q); }, [filters.q]);
  useEffect(() => {
    if (q === filtersRef.current.q) return;
    const timer = setTimeout(() => set({ q }), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [q, set]);

  const clear = () => { setQ(''); set({ ...EMPTY_TICKET_FILTERS }); };
  const tags = showAllTags ? tagFacet : tagFacet.slice(0, Math.max(VISIBLE_TAGS, tagFacet.filter(t => t.selected).length));
  const hiddenTagCount = tagFacet.length - tags.length;
  const projectKnown = !filters.projectId || projects.some(p => p.id === filters.projectId);
  const assigneeKnown = !filters.assigneeKey || assigneeOptions.some(a => a.key === filters.assigneeKey);
  const filterCount = filters.statuses.length + filters.tags.length + Number(!!filters.projectId) + Number(!!filters.assigneeKey) + Number(filters.archived);
  const summary = [
    ...filters.statuses.map(s => TICKET_STATUS_LABELS[s]),
    filters.projectId ? projects.find(p => p.id === filters.projectId)?.name || translate('선택된 프로젝트') : '',
    filters.assigneeKey ? assigneeOptions.find(a => a.key === filters.assigneeKey)?.label || translate('선택된 담당자') : '',
    ...filters.tags.map(tag => `#${tag}`),
    filters.archived ? translate('보관된 티켓') : '',
  ].filter(Boolean).join(' · ');

  return (
    <>
      <header
        data-testid="ticket-filter-bar"
        className="awb-tickets-toolbar"
        style={{ background: tokens.colors.surface, borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0 }}
      >
        <div className="awb-tickets-toolbar-row">
          <div className="awb-tickets-heading">
            <h1 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>{translate('Tickets')}</h1>
            <span style={{ color: tokens.colors.textMuted, fontSize: 12 }} aria-label={translate('티켓 {0}개', { 0: ticketCount })}>{ticketCount}</span>
            {unreadCount > 0 && (
              <button
                type="button" className="awb-tickets-unread" onClick={() => setMenuOpen(true)}
                title={translate('읽지 않은 코멘트 {0}건', { 0: unreadCount })}
                style={{ color: tokens.colors.accent, borderColor: tokens.colors.border }}
              >{translate('읽지 않음')} {unreadCount}</button>
            )}
          </div>
          <input
            className="awb-tickets-search" type="search" aria-label={translate('티켓 검색')} placeholder={translate('티켓 검색')}
            value={q} onChange={e => setQ(e.target.value)} style={selectStyle}
          />
          <div className="awb-tickets-toolbar-actions">
            <Button variant="primary" size="sm" onClick={onCreate}>{translate('+ New ticket')}</Button>
            <button
              type="button" className="awb-tickets-menu-trigger" aria-label={translate('티켓 필터 및 보기')}
              aria-haspopup="dialog" aria-expanded={menuOpen} onClick={() => setMenuOpen(true)}
              title={translate('필터 및 보기')}
              style={{ color: filterCount ? tokens.colors.accent : tokens.colors.textSecondary, borderColor: filterCount ? tokens.colors.accent : tokens.colors.border }}
            >
              <span aria-hidden="true">☰</span>
              {filterCount > 0 && (
                <span className="awb-tickets-filter-count" aria-label={translate('선택된 필터 {0}개', { 0: filterCount })} style={{ background: tokens.colors.accent, color: '#fff' }}>{filterCount}</span>
              )}
            </button>
          </div>
        </div>
        {summary && (
          <div className="awb-tickets-filter-summary" style={{ color: tokens.colors.textSecondary }}>
            <button type="button" onClick={() => setMenuOpen(true)} title={summary} style={{ color: 'inherit' }}>{summary}</button>
            <button type="button" onClick={clear} style={{ color: tokens.colors.accent }}>{translate('초기화')}</button>
          </div>
        )}
      </header>
      <Modal
        isOpen={menuOpen} onClose={() => setMenuOpen(false)} title={translate('티켓 필터 및 보기')} maxWidth={520}
        footer={
          <div className="awb-ticket-filter-footer">
            <Button variant="secondary" size="sm" onClick={clear} disabled={!hasActiveFilters(filters) && !q.trim()}>{translate('필터 지우기')}</Button>
            <Button variant="primary" size="sm" onClick={() => setMenuOpen(false)}>{translate('결과 보기')}</Button>
          </div>
        }
      >
        <div className="awb-ticket-filter-settings" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <div role="group" aria-label={translate('상태 필터')} style={fieldStyle}>
            <span>{translate('상태')}</span>
            <div style={groupStyle}>
              {TICKET_STATUSES.map(s => (
                <button
                  key={s} type="button" aria-pressed={filters.statuses.includes(s)}
                  onClick={() => set({ statuses: toggleInList(filtersRef.current.statuses, s) })}
                  style={chipStyle(filters.statuses.includes(s), ticketStatusColor(s))}
                >
                  <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: ticketStatusColor(s), flexShrink: 0 }} />
                  {TICKET_STATUS_LABELS[s]}
                </button>
              ))}
            </div>
          </div>
          <label style={fieldStyle}>{translate('프로젝트')}<select aria-label={translate('프로젝트 필터')} value={filters.projectId} onChange={e => set({ projectId: e.target.value })} style={selectStyle}>
              <option value="">{translate('모든 프로젝트')}</option>
              {!projectKnown && <option value={filters.projectId}>{translate('(알 수 없는 프로젝트)')}</option>}
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label style={fieldStyle}>{translate('담당자')}<select aria-label={translate('담당자 필터')} value={filters.assigneeKey} onChange={e => set({ assigneeKey: e.target.value })} style={selectStyle}>
              <option value="">{translate('모든 담당자')}</option>
              {!assigneeKnown && <option value={filters.assigneeKey}>{translate('(선택된 담당자)')}</option>}
              {assigneeOptions.map(a => <option key={a.key} value={a.key}>{a.label} ({a.count})</option>)}
            </select>
          </label>
          {tagFacet.length > 0 && (
            <div role="group" aria-label={translate('태그 필터 (모두 포함)')} style={fieldStyle}>
              <span>{translate('태그 · 선택한 태그를 모두 포함')}</span>
              <div style={groupStyle}>
                {tags.map(t => (
                  <button
                    key={t.tag} type="button" aria-pressed={t.selected}
                    title={t.selected ? translate('#{0} 필터 해제', { 0: t.tag }) : translate('#{0} 가 붙은 티켓만 (다른 선택 태그와 AND)', { 0: t.tag })}
                    onClick={() => set({ tags: toggleInList(filtersRef.current.tags, t.tag) })}
                    style={chipStyle(t.selected)}
                  >
                    #{t.tag}<span style={{ fontSize: 10, color: tokens.colors.textMuted }}>{t.count}</span>
                  </button>
                ))}
                {(hiddenTagCount > 0 || showAllTags) && tagFacet.length > VISIBLE_TAGS && (
                  <button
                    type="button" onClick={() => setShowAllTags(v => !v)}
                    style={{ ...chipStyle(false), border: 'none', color: tokens.colors.accent }}
                  >{showAllTags ? translate('접기') : translate('+{0}개 더', { 0: hiddenTagCount })}</button>
                )}
              </div>
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
            <input type="checkbox" checked={filters.archived} onChange={e => set({ archived: e.target.checked })} />{translate('보관된 티켓')}</label>
          <div role="group" aria-label={translate('보기')} style={fieldStyle}>
            <span>{translate('보기')}</span>
            <div style={groupStyle}>
              {(['kanban', 'list'] as TicketView[]).map(v => (
                <button key={v} type="button" aria-pressed={view === v} onClick={() => onViewChange(v)} style={chipStyle(view === v)}>
                  {v === 'kanban' ? translate('Kanban') : translate('List')}
                </button>
              ))}
            </div>
          </div>
          {unreadCount > 0 && (
            <div style={{
              ...groupStyle, alignItems: 'center', justifyContent: 'space-between',
              borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12,
              fontSize: 13, color: tokens.colors.textSecondary,
            }}>
              <span>{translate('읽지 않은 코멘트')} {unreadCount}{translate('건')}</span>
              <Button size="sm" variant="secondary" onClick={onMarkAllRead}>{translate('모두 읽음')}</Button>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}
