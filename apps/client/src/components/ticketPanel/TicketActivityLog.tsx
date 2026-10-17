import React, { useEffect, useState } from 'react';
import type { ActivityLog } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { isTicketStatus, ticketStatusLabel } from '../../tickets/status';
import { wrapText } from './panelStyles';

const ACTION_LABELS: Record<string, string> = {
  created: '만듦',
  updated: '수정',
  moved: '상태 변경',
  status_changed: '상태 변경',
  archived: '보관',
  unarchived: '보관 해제',
  deleted: '삭제',
  trigger_emitted: '담당자에게 보냄',
  dispatch_failed: '보내기 실패',
  dispatch_deferred: '보내기 보류',
  dispatch_ack_accepted: '담당자가 받음',
  dispatch_ack_rejected: '담당자가 거절',
  duplicate_link_corrected: '중복 연결 해제',
};

const FIELD_LABELS: Record<string, string> = {
  title: '제목',
  description: '설명',
  priority: '우선순위',
  tags: '태그',
  assignee: '담당',
  project_id: '프로젝트',
  base_branch: '기준 브랜치',
  next_ticket_id: '다음 티켓',
  on_done_action_ids: '완료 시 실행',
  pending_user_action: '보류',
  pending_reason: '보류 사유',
  prerequisite_added: '선행 티켓 추가',
  prerequisite_removed: '선행 티켓 제거',
  parent_id: '상위 티켓',
};

const valueText = (value: string | null | undefined) => {
  const v = value && isTicketStatus(value) ? ticketStatusLabel(value) : (value || '');
  return v.length > 120 ? `${v.slice(0, 120)}…` : v;
};

function describe(log: ActivityLog): string {
  if (log.entity_type === 'comment') {
    const text = valueText(log.new_value);
    return `코멘트${log.action === 'created' ? '' : ` ${ACTION_LABELS[log.action] || log.action}`}${text ? ` · ${text}` : ''}`;
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
  const [rows, setRows] = useState<ActivityLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api.getTicketActivity(ticketId)
      .then(list => { if (!cancelled) setRows(list); })
      .catch((e: any) => { if (!cancelled) setError(e?.message || '기록을 불러오지 못했습니다'); });
    return () => { cancelled = true; };
  }, [ticketId, refreshKey]);

  if (error) return <div role="alert" style={{ fontSize: '12px', color: tokens.colors.dangerLight }}>{error}</div>;
  if (!rows) return <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>불러오는 중…</div>;
  if (rows.length === 0) return <div style={{ fontSize: '12px', color: tokens.colors.textMuted }}>기록이 없습니다.</div>;

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {rows.map(log => (
        <li key={log.id} style={{
          display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', columnGap: 8, rowGap: 2,
          padding: '6px 2px', borderBottom: `1px solid ${tokens.colors.border}`, fontSize: '12px',
        }}>
          <time style={{ color: tokens.colors.textMuted, fontSize: '11px', flexShrink: 0 }}>
            {new Date(log.created_at).toLocaleString()}
          </time>
          {log.actor_name && <span style={{ color: tokens.colors.textSecondary, fontWeight: 600, ...wrapText }}>{log.actor_name}</span>}
          <span style={{ color: tokens.colors.textStrong, flex: '1 1 200px', ...wrapText }}>{describe(log)}</span>
        </li>
      ))}
    </ol>
  );
}
