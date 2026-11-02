import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useState } from 'react';
import { api } from '../../api';
import type { OrchestrationApproval, OrchestrationApprovalDecision } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button } from '../common';
import { relativeTime } from '../../utils/time';
import { pendingApprovals, routeReasonLabel } from './approvals.logic';

/**
 * 미션 runtime 의 도구 사용 승인 요청(docs/orchestration.md "실행 승인").
 *
 * 요청한 CLI 는 답이 올 때까지 그 자리에서 멈춰 있다. 그래서 확인 게이트처럼 미션 상세의 맨 위에
 * 둔다. 오케스트레이터가 판단 중인 요청도 보여주고 답할 수 있게 한다 — 사람이 먼저 정하면 그것이
 * 이긴다(오케스트레이터의 늦은 답은 서버가 거절한다).
 */
function ApprovalCard({
  approval,
  accountId,
  onDecided,
}: {
  approval: OrchestrationApproval;
  accountId: string;
  onDecided: () => void;
}) {
  useLocale();
  const { showToast } = useToast();
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState<OrchestrationApprovalDecision | null>(null);
  const yours = approval.route === 'user';

  const submit = async (decision: OrchestrationApprovalDecision) => {
    setSubmitting(decision);
    try {
      const result = await api.decideOrchestrationApproval(approval.id, {
        account_id: accountId,
        decision,
        note: note.trim() || undefined,
      });
      showToast(
        result.already_decided
          ? translate('This request was already answered.')
          : decision === 'deny'
            ? translate('Denied — the agent was told why.')
            : translate('Allowed — the agent is continuing.'),
        'success',
      );
      onDecided();
    } catch (e: any) {
      showToast(e?.message || translate('Failed to answer the approval request'), 'error');
      onDecided();
    } finally {
      setSubmitting(null);
    }
  };

  const accent = yours ? tokens.colors.warningLight : tokens.colors.border;
  return (
    <div
      data-testid="approval-card"
      data-approval-id={approval.id}
      data-route={approval.route}
      style={{
        border: `1px solid ${accent}${yours ? '66' : ''}`,
        background: yours ? `${tokens.colors.warningBg}22` : tokens.colors.surface,
        borderRadius: 8,
        padding: 14,
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      <div>
        <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textStrong, wordBreak: 'break-word' }}>
          {translate('{0} wants to use {1}', { 0: approval.requester_name, 1: approval.tool_name })}
        </div>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
          {approval.step_key ? <code>{approval.step_key}</code> : translate('Orchestrator')}
          {' · '}
          {relativeTime(approval.created_at)}
          {' · '}
          {routeReasonLabel(approval)}
        </div>
      </div>

      {approval.title && approval.title !== approval.tool_name && (
        <div style={{ fontSize: 13, color: tokens.colors.textPrimary, wordBreak: 'break-word' }}>{approval.title}</div>
      )}
      {approval.description && (
        <div style={{ fontSize: 13, lineHeight: 1.5, color: tokens.colors.textSecondary, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {approval.description}
        </div>
      )}
      {approval.route_reason === 'orchestrator_escalated' && approval.decision_note && (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>
          {translate('Orchestrator: {0}', { 0: approval.decision_note })}
        </div>
      )}
      {approval.input && (
        <pre
          data-testid="approval-input"
          style={{
            margin: 0,
            maxHeight: 220,
            overflow: 'auto',
            padding: '8px 10px',
            borderRadius: 6,
            border: `1px solid ${tokens.colors.border}`,
            background: tokens.colors.surface,
            color: tokens.colors.textPrimary,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
          }}
        >
          {approval.input}
        </pre>
      )}

      <textarea
        aria-label={translate('Reason (optional)')}
        placeholder={translate('Reason (optional) — the agent reads it when you deny')}
        value={note}
        rows={2}
        onChange={(e) => setNote(e.target.value)}
        style={{
          width: '100%',
          padding: '8px 10px',
          borderRadius: 6,
          border: `1px solid ${tokens.colors.border}`,
          background: tokens.colors.surface,
          color: tokens.colors.textPrimary,
          fontSize: 13,
          fontFamily: 'inherit',
          resize: 'vertical',
        }}
      />

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Button variant="primary" onClick={() => submit('allow')} loading={submitting === 'allow'} disabled={submitting !== null}>
          {translate('Allow')}
        </Button>
        {approval.can_allow_session && (
          <Button
            variant="secondary"
            onClick={() => submit('allow_session')}
            loading={submitting === 'allow_session'}
            disabled={submitting !== null}
            title={translate('Allow, and stop asking for the same kind of action in this session')}
          >
            {translate('Allow for this session')}
          </Button>
        )}
        <Button variant="danger" onClick={() => submit('deny')} loading={submitting === 'deny'} disabled={submitting !== null}>
          {translate('Deny')}
        </Button>
      </div>
    </div>
  );
}

export default function ApprovalRequestPanel({
  approvals,
  accountId,
  onDecided,
}: {
  approvals: OrchestrationApproval[] | undefined;
  accountId: string;
  onDecided: () => void;
}) {
  useLocale();
  const pending = pendingApprovals(approvals);
  if (pending.length === 0) return null;
  const yours = pending.filter((a) => a.route === 'user').length;

  return (
    <section data-testid="approval-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        <h2
          style={{
            margin: 0,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: yours ? tokens.colors.warningLight : tokens.colors.textMuted,
          }}
        >
          {yours ? translate('Waiting for your approval') : translate('Approval requests')}
        </h2>
        <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>
          {translate('The agent that asked is paused until someone answers.')}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {pending.map((a) => (
          <ApprovalCard key={a.id} approval={a} accountId={accountId} onDecided={onDecided} />
        ))}
      </div>
    </section>
  );
}
