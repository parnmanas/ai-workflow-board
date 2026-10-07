import React, { useCallback, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import type { SessionProposal, SessionProposalEvent } from '../../types';
import { Button } from '../common';
import { sessionProposalStore } from './sessionProposals';
import { sessionPath } from './sessionList.logic';

/**
 * operator 의 작업 제안 카드(docs/voice-operator.md "작업 제안"). operator 는 다른 세션에 일을 직접 시키지 못하고
 * 제안만 남긴다 — 여기서 사람이 글을 그대로 읽고 보내거나 거절한다. 대상이 턴 중이면 보낸 제안은 그 턴이
 * 끝날 때 간다(queued).
 */
export default function SessionProposalCards({ proposals, showTarget }: {
  proposals: SessionProposal[];
  /** operator 세션 화면 — 어느 세션에 보낼 것인지 같이 보인다. */
  showTarget: (p: SessionProposal) => boolean;
}) {
  const { showToast } = useToast();
  // 진행 중 표시는 제안 id 로 — 카드가 바뀌어도 다른 제안의 버튼이 잠기지 않게.
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const act = useCallback(async (p: SessionProposal, action: 'send' | 'dismiss') => {
    setBusy((b) => ({ ...b, [p.id]: true }));
    try {
      const { proposal } = action === 'send' ? await api.sendSessionProposal(p.id) : await api.dismissSessionProposal(p.id);
      sessionProposalStore.apply(proposal);
      if (action === 'send') {
        showToast(proposal.status === 'queued' ? 'Approved — it goes to the session when its current turn ends.' : 'Sent to the session.', 'info');
      }
    } catch (err: any) {
      showToast(err?.message || 'Failed to update the proposal', 'error');
      void sessionProposalStore.load();
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[p.id];
        return next;
      });
    }
  }, [showToast]);

  if (!proposals.length) return null;
  return (
    <div className="awb-session-proposals" style={{ borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface }}>
      {proposals.map((p) => {
        const working = !!busy[p.id];
        const target = `${p.target.manager_name} / ${p.target.cli_label}${p.target.title ? ` · ${p.target.title}` : ''}`;
        return (
          <section key={p.id} className="awb-session-proposal" data-proposal-status={p.status} aria-label={`Proposal from ${p.operator.name}`}>
            <div className="awb-session-proposal-head">
              <span style={{ color: tokens.colors.textPrimary, fontWeight: 600 }}>🧭 {p.operator.name} proposes</span>
              {showTarget(p) && <span className="awb-session-proposal-target" style={{ color: tokens.colors.textSecondary }} title={target}>→ {target}</span>}
              <span className="awb-session-proposal-actions">
                {p.status === 'pending' && (
                  <>
                    <Button variant="primary" size="sm" disabled={working} onClick={() => void act(p, 'send')}>Send</Button>
                    <Button variant="ghost" size="sm" disabled={working} onClick={() => void act(p, 'dismiss')}>Dismiss</Button>
                  </>
                )}
                {p.status === 'queued' && (
                  <Button variant="ghost" size="sm" disabled={working} onClick={() => void act(p, 'dismiss')} title="Do not send it after all">Cancel</Button>
                )}
                {p.status === 'failed' && (
                  <>
                    <Button variant="secondary" size="sm" disabled={working} onClick={() => void act(p, 'send')}>Retry</Button>
                    <Button variant="ghost" size="sm" disabled={working} onClick={() => void act(p, 'dismiss')}>Dismiss</Button>
                  </>
                )}
              </span>
            </div>
            {p.reason && <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>{p.reason}</div>}
            <pre className="awb-session-proposal-text" style={{ color: tokens.colors.textPrimary, background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>{p.text}</pre>
            {p.status === 'queued' && (
              <div style={{ fontSize: 12, color: tokens.colors.textSecondary }}>Approved — it goes to the session when its current turn ends.</div>
            )}
            {p.status === 'failed' && (
              <div role="alert" style={{ fontSize: 12, color: tokens.colors.dangerLight }}>Not sent: {p.error || 'unknown error'}</div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/**
 * 새 제안을 모든 화면에서 알린다(화면을 그리지 않는다). 누르면 그 세션으로 간다 — 거기서 글을 읽고 정한다.
 * 목록 상태도 여기서 따라간다(세션 화면이 열려 있지 않아도).
 */
export function SessionProposalNotifier() {
  const { showToast } = useToast();
  const navigate = useNavigate();
  useBoardStreamEvent('agent_session_proposal', useCallback((data: SessionProposalEvent) => {
    if (!data?.proposal) return;
    sessionProposalStore.apply(data.proposal);
    if (data.reason !== 'proposed') return;
    const p = data.proposal;
    const target = `${p.target.manager_name} / ${p.target.cli_label}${p.target.title ? ` · ${p.target.title}` : ''}`;
    showToast(`🧭 ${p.operator.name} proposes work for ${target} — open to review`, 'info', {
      durationMs: 10_000,
      onClick: () => navigate(sessionPath('', p.target.manager_id, p.target.cli, p.target.session_id)),
    });
  }, [showToast, navigate]));
  return null;
}
