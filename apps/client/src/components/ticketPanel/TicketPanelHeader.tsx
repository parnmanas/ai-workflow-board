import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React from 'react';
import type { Ticket } from '../../types';
import { tokens } from '../../tokens';
import { ActivityPill } from '../common/ActivityIndicator';
import { ticketActivity } from '../../activity';
import SessionHeaderMenu, { SessionMenuItem, SessionMenuSection } from '../sessions/SessionHeaderMenu';
import { panelButton } from './panelStyles';

interface TicketPanelHeaderProps {
  ticket: Ticket;
  title: string;
  /** Root tickets run and archive; checklist children do neither. */
  isRoot: boolean;
  canGoBack: boolean;
  running: boolean;
  archiveBusy: boolean;
  onBack(): void;
  onCopyId(): void;
  onRun(): void;
  onPark(): void;
  onToggleArchive(): void;
  onDelete(): void;
  onClose(): void;
  onShowOverview(): void;
}

/**
 * A short row: title and identity on the left, then the hamburger
 * menu and Close. Run / park / Archive / Delete and the full id live in the menu
 * so the header keeps one shape at every width; Close is always last so it stays
 * reachable. `.awb-ticket-header` carries the narrow-screen rules (responsive.css).
 */
export default function TicketPanelHeader({
  ticket, title, isRoot, canGoBack, running, archiveBusy,
  onBack, onCopyId, onRun, onPark, onToggleArchive, onDelete, onClose, onShowOverview,
}: TicketPanelHeaderProps) {
  useLocale();
  const archived = !!ticket.archived_at;
  const runBlocked = running || !ticket.assignee || archived;
  return (
    <div className="awb-ticket-header" style={{
      display: 'flex', flexWrap: 'nowrap', alignItems: 'center', gap: 8,
      padding: '10px 14px', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0,
    }}>
      {canGoBack && (
        <button type="button" onClick={onBack} style={{ ...panelButton('plain'), padding: '5px 10px', flexShrink: 0 }} aria-label={translate('상위 티켓으로')} title={translate('상위 티켓으로')}>←</button>
      )}
      <div className="awb-ticket-heading">
        <h2 className="awb-ticket-heading-title" title={title} style={{ color: tokens.colors.textPrimary }}>{title}</h2>
        <div className="awb-ticket-heading-meta">
          <button
            type="button"
            onClick={onCopyId}
            title={translate('클릭하여 Ticket ID 복사 ({0})', { 0: ticket.id })}
            aria-label={translate('Ticket ID {0}, 클릭하여 클립보드에 복사', { 0: ticket.id })}
            style={{
              background: tokens.colors.surfaceCard, border: 'none', borderRadius: tokens.radii.sm,
              color: tokens.colors.textMuted, fontSize: '11px', fontFamily: 'monospace',
              padding: '2px 0', cursor: 'pointer',
            }}
          >#{ticket.id.slice(0, 8)}</button>
          <ActivityPill view={ticketActivity(ticket)} />
          {archived && (
            <span style={{
              fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: tokens.radii.sm,
              textTransform: 'uppercase', background: tokens.colors.surfaceSubtle, color: tokens.colors.textMuted,
            }}>{translate('보관됨')}</span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
        <SessionHeaderMenu label={translate('Ticket menu')}>
          {(close) => (
            <>
              <SessionMenuSection title={translate('Actions')}>
                {isRoot && (
                  <SessionMenuItem
                    icon="▶"
                    label={running ? translate('Running…') : translate('Run')}
                    title={ticket.assignee ? translate('지금 담당자에게 보냅니다') : translate('담당자를 지정하고 저장해야 실행할 수 있습니다')}
                    disabled={runBlocked}
                    onSelect={() => { close(); onRun(); }}
                  />
                )}
                {!ticket.pending_user_action && !archived && (
                  <SessionMenuItem
                    icon="⏸"
                    label={translate('사람 확인 요청(보류)')}
                    title={translate('담당자를 멈추고 사람의 확인을 기다립니다')}
                    onSelect={() => { close(); onPark(); }}
                  />
                )}
                {isRoot && (
                  <SessionMenuItem
                    icon="🗄"
                    label={archived ? translate('Unarchive') : translate('Archive')}
                    title={archived ? translate('보관을 해제해 목록으로 되돌립니다') : translate('이 티켓(과 하위 작업)을 보관합니다')}
                    disabled={archiveBusy}
                    onSelect={() => { close(); onToggleArchive(); }}
                  />
                )}
                <SessionMenuItem
                  icon="🗑"
                  label={translate('Delete')}
                  title={translate('이 티켓을 삭제합니다')}
                  onSelect={() => { close(); onDelete(); }}
                />
              </SessionMenuSection>
              <SessionMenuSection title={translate('Ticket')}>
                <div style={{ padding: '2px 8px 8px', fontSize: 13, lineHeight: 1.5, color: tokens.colors.textPrimary }}>{title}</div>
                <SessionMenuItem
                  icon="⚙"
                  label={translate('상세 정보·설정')}
                  onSelect={() => { close(); onShowOverview(); }}
                />
                <SessionMenuItem
                  icon="#"
                  label={ticket.id}
                  title={translate('전체 ID 복사')}
                  onSelect={() => { close(); onCopyId(); }}
                />
              </SessionMenuSection>
            </>
          )}
        </SessionHeaderMenu>
        <button
          type="button"
          onClick={onClose}
          aria-label={translate('Close ticket')}
          title={translate('닫기 (Esc)')}
          style={{ ...panelButton('plain'), padding: '5px 10px', fontSize: '14px', lineHeight: 1 }}
        >✕</button>
      </div>
    </div>
  );
}
