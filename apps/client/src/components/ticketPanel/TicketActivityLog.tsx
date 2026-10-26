import { getLocaleTag } from '../../i18n/core';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useEffect, useState } from 'react';
import type { ActivityLog } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { isTicketStatus, ticketStatusLabel } from '../../tickets/status';
import { wrapText } from './panelStyles';

const ACTION_LABELS: Record<string, string> = {
  get created() { return translate('만듦'); },
  get updated() { return translate('수정'); },
  get moved() { return translate('상태 변경'); },
  get status_changed() { return translate('상태 변경'); },
  get archived() { return translate('보관'); },
  get unarchived() { return translate('보관 해제'); },
  get deleted() { return translate('삭제'); },
  get trigger_emitted() { return translate('담당자에게 보냄'); },
  get dispatch_failed() { return translate('보내기 실패'); },
  get dispatch_deferred() { return translate('보내기 보류'); },
  get dispatch_ack_accepted() { return translate('담당자가 받음'); },
  get dispatch_ack_rejected() { return translate('담당자가 거절'); },
  get duplicate_link_corrected() { return translate('중복 연결 해제'); },
};

const FIELD_LABELS: Record<string, string> = {
  get title() { return translate('제목'); },
  get description() { return translate('설명'); },
  get priority() { return translate('우선순위'); },
  get tags() { return translate('태그'); },
  get assignee() { return translate('담당'); },
  get project_id() { return translate('프로젝트'); },
  get base_branch() { return translate('기준 브랜치'); },
  get next_ticket_id() { return translate('다음 티켓'); },
  get on_done_action_ids() { return translate('완료 시 실행'); },
  get pending_user_action() { return translate('보류'); },
  get pending_reason() { return translate('보류 사유'); },
  get prerequisite_added() { return translate('선행 티켓 추가'); },
  get prerequisite_removed() { return translate('선행 티켓 제거'); },
  get parent_id() { return translate('상위 티켓'); },
};

const valueText = (value: string | null | undefined) => {
  const v = value && isTicketStatus(value) ? ticketStatusLabel(value) : (value || '');
  return v.length > 120 ? `${v.slice(0, 120)}…` : v;
};

function describe(log: ActivityLog): string {
  if (log.entity_type === 'comment') {
    const text = valueText(log.new_value);
    return translate('코멘트{0}{1}', { 0: log.action === 'created' ? '' : ` ${ACTION_LABELS[log.action] || log.action}`, 1: text ? ` · ${text}` : '' });
  }
  const label = ACTION_LABELS[log.action] || log.action.replace(/_/g, ' ');
  const fieldName = log.field_changed && log.field_changed !== 'status'
    ? (FIELD_LABELS[log.field_changed] || log.field_changed.replace(/_/g, ' '))
    : '';
  const from = valueText(log.old_value);
  const to = valueText(log.new_value);
  const change = from || to ? ` · ${from ? `${from} → ` : ''}${to}` : '';
  return `${label}${fieldName ? ` · ${fieldName}` : ''}${change}`;
}

/** The ticket's audit trail, newest first — who changed what, and what was sent to the assignee. */
export default function TicketActivityLog({ ticketId, refreshKey }: { ticketId: string; refreshKey?: string }) {
  useLocale();
  const [rows, setRows] = useState<ActivityLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.getTicketActivity(ticketId)
      .then(list => { if (!cancelled) setRows(list); })
      .catch((e: any) => { if (!cancelled) setError(e?.message || translate('기록을 불러오지 못했습니다')); });
    return () => { cancelled = true; };
  }, [ticketId, refreshKey]);

  if (error) return <div role="alert" style={{ fontSize: '12px', color: tokens.colors.dangerLight }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>{translate('불러오는 중…')}</div>;
  if (rows.length === 0) return <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>{translate('기록이 없습니다.')}</div>;

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map(log => (
        <li key={log.id} style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2,
          padding: '6px 2px', borderBottom: `1px solid ${tokens.colors.border}`, fontSize: '12px',
        }}>
          <time style={{ color: tokens.colors.textMuted, fontSize: '11px', flexShrink: 0 }}>
            {new Date(log.created_at).toLocaleString(getLocaleTag())}
          </time>
          {log.actor_name && <span style={{ color: tokens.colors.textSecondary, fontWeight: 600, ...wrapText }}>{log.actor_name}</span>}
          <span style={{ color: tokens.colors.textStrong, flex: '1 1 200px', ...wrapText }}>{describe(log)}</span>
        </li>
      ))}
    </ol>
  );
}
