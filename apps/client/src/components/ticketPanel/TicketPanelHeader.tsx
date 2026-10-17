import React from 'react';
import type { Ticket } from '../../types';
import { tokens } from '../../tokens';
import { ActivityPill } from '../common/ActivityIndicator';
import { ticketActivity } from '../../activity';
import SessionHeaderMenu, { SessionMenuItem, SessionMenuSection } from '../sessions/SessionHeaderMenu';
import { panelButton } from './panelStyles';

interface TicketPanelHeaderProps {
  ticket: Ticket;
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
}

/**
 * A short row: identity on the left (it may shrink and wrap), then the hamburger
 * menu and Close. Run / park / Archive / Delete and the full id live in the menu
 * so the header keeps one shape at every width; Close is always last so it stays
 * reachable. `.awb-ticket-header` carries the narrow-screen rules (responsive.css).
 */
export default function TicketPanelHeader({
  ticket, isRoot, canGoBack, running, archiveBusy,
  onBack, onCopyId, onRun, onPark, onToggleArchive, onDelete, onClose,
}: TicketPanelHeaderProps) {
  const archived = !!ticket.archived_at;
  const runBlocked = running || !ticket.assignee || archived;
  return (
    <div className="awb-ticket-header" style={{
      display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
      padding: '10px 14px', borderBottom: `1px solid ${tokens.colors.border}`, flexShrink: 0,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 auto', minWidth: 0, flexWrap: 'wrap' }}>
        {canGoBack && (
          <button type="button" onClick={onBack} style={panelButton('plain')} title="상위 티켓으로">← 상위</button>
        )}
        <button
          type="button"
          onClick={onCopyId}
          title={`클릭하여 Ticket ID 복사 (${ticket.id})`}
          aria-label={`Ticket ID ${ticket.id}, 클릭하여 클립보드에 복사`}
          style={{
            background: tokens.colors.surfaceCard, border: 'none', borderRadius: tokens.radii.sm,
            color: tokens.colors.textMuted, fontSize: '11px', fontFamily: 'monospace',
            padding: '3px 7px', cursor: 'pointer',
          }}
        >#{ticket.id.slice(0, 8)}</button>
        <ActivityPill view={ticketActivity(ticket)} />
        {archived && (
          <span style={{
            fontSize: '10px', fontWeight: 700, padding: '2px 6px', borderRadius: tokens.radii.sm,
            textTransform: 'uppercase', background: tokens.colors.surfaceSubtle, color: tokens.colors.textMuted,
          }}>보관됨</span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, marginLeft: 'auto' }}>
        <SessionHeaderMenu label="Ticket menu">
          {(close) => (
            <>
              <SessionMenuSection title="Actions">
                {isRoot && (
                  <SessionMenuItem
                    icon="▶"
                    label={running ? 'Running…' : 'Run'}
                    title={ticket.assignee ? '지금 담당자에게 보냅니다' : '담당자를 지정하고 저장해야 실행할 수 있습니다'}
                    disabled={runBlocked}
                    onSelect={() => { close(); onRun(); }}
                  />
                )}
                {!ticket.pending_user_action && !archived && (
                  <SessionMenuItem
                    icon="⏸"
                    label="사람 확인 요청(보류)"
                    title="담당자를 멈추고 사람의 확인을 기다립니다"
                    onSelect={() => { close(); onPark(); }}
                  />
                )}
                {isRoot && (
                  <SessionMenuItem
                    icon="🗄"
                    label={archived ? 'Unarchive' : 'Archive'}
                    title={archived ? '보관을 해제해 목록으로 되돌립니다' : '이 티켓(과 하위 작업)을 보관합니다'}
                    disabled={archiveBusy}
                    onSelect={() => { close(); onToggleArchive(); }}
                  />
                )}
                <SessionMenuItem
                  icon="🗑"
                  label="Delete"
                  title="이 티켓을 삭제합니다"
                  onSelect={() => { close(); onDelete(); }}
                />
              </SessionMenuSection>
              <SessionMenuSection title="Ticket">
                <SessionMenuItem
                  icon="#"
                  label={ticket.id}
                  title="전체 ID 복사"
                  onSelect={() => { close(); onCopyId(); }}
                />
              </SessionMenuSection>
            </>
          )}
        </SessionHeaderMenu>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close ticket"
          title="닫기 (Esc)"
          style={{ ...panelButton('plain'), padding: '5px 10px', fontSize: '14px', lineHeight: 1 }}
        >✕</button>
      </div>
    </div>
  );
}
