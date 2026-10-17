import React, { useEffect, useState } from 'react';
import type { Ticket, TicketPrerequisiteRow } from '../../types';
import { api } from '../../api';
import { tokens } from '../../tokens';
import { useToast } from '../../contexts/ToastContext';
import { openPrerequisiteCount } from './ticketDraft';
import { controlStyle, panelButton, wrapText } from './panelStyles';

interface PendingNoticeProps {
  ticket: Ticket;
  prerequisites: TicketPrerequisiteRow[];
  /** The header's "사람 확인 요청" asked for the park form. */
  parkRequested: boolean;
  onParkDone(): void;
  /** Posts the human's answer as a ticket comment before resuming. */
  onAddComment(ticketId: string, content: string): void | Promise<void>;
}

const box = (border: string, background: string): React.CSSProperties => ({
  border: `1px solid ${border}`, borderLeft: `3px solid ${border}`, background,
  borderRadius: tokens.radii.lg, padding: '10px 12px', marginBottom: 16, ...wrapText,
});

/**
 * Everything that is waiting on someone, at the top of the overview: a ticket
 * parked for a human (answer + resume, or the duplicate decision), a ticket
 * blocked by prerequisites (resumes by itself), and the park form itself.
 */
export default function PendingNotice({ ticket, prerequisites, parkRequested, onParkDone, onAddComment }: PendingNoticeProps) {
  const { showToast } = useToast();
  const [response, setResponse] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [duplicateDone, setDuplicateDone] = useState(false);

  useEffect(() => {
    setResponse('');
    setReason('');
    setDuplicateDone(false);
  }, [ticket.id]);

  const run = async (work: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await work();
      return true;
    } catch (e: any) {
      showToast(`${failure}: ${e?.message || 'unknown error'}`, 'error');
      return false;
    } finally {
      setBusy(false);
    }
  };

  const resume = () => run(async () => {
    const text = response.trim();
    // The answer lands in the thread before the assignee is woken up.
    if (text) await Promise.resolve(onAddComment(ticket.id, text));
    await api.updateTicket(ticket.id, { pending_user_action: false });
    setResponse('');
  }, '재개하지 못했습니다');

  const park = async () => {
    const text = reason.trim();
    if (!text) return;
    if (await run(() => api.updateTicket(ticket.id, { pending_user_action: true, pending_reason: text }), '보류하지 못했습니다')) {
      setReason('');
      onParkDone();
    }
  };

  const decideDuplicate = (candidateId: string | null) => run(async () => {
    await api.decideTicketDuplicate(ticket.id, candidateId
      ? { action: 'link', candidate_ticket_id: candidateId }
      : { action: 'keep_independent' });
    setDuplicateDone(true);
    showToast(candidateId ? '원본 티켓에 연결했습니다' : '독립 티켓으로 유지합니다', 'success');
  }, '중복 판단을 저장하지 못했습니다');

  const blockedCount = openPrerequisiteCount(prerequisites) || prerequisites.length;
  const showDuplicateChoice = ticket.duplicate_decision_pending === true
    && !!ticket.duplicate_candidates?.length
    && !duplicateDone;

  return (
    <>
      {ticket.pending_on_tickets && (
        <div style={box(tokens.colors.info, tokens.colors.surfaceCard)}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: tokens.colors.infoLight, marginBottom: 4 }}>⛓ 선행 티켓 대기</div>
          <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
            선행 티켓 {blockedCount}개가 끝나면 자동으로 다시 시작합니다. 아래 “연결·자동화”에서 바꿀 수 있습니다.
          </div>
        </div>
      )}

      {ticket.pending_user_action && (
        <div style={box(tokens.colors.warning, tokens.colors.warningBg)}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: tokens.colors.warningLight, marginBottom: 4 }}>⏸ 사람의 확인이 필요합니다</div>
          {(ticket.pending_set_by || ticket.pending_set_at) && (
            <div style={{ fontSize: '11px', color: tokens.colors.textMuted, marginBottom: 6 }}>
              {ticket.pending_set_by}{ticket.pending_set_at ? ` · ${new Date(ticket.pending_set_at).toLocaleString()}` : ''}
            </div>
          )}
          {ticket.pending_reason && (
            <div style={{
              background: tokens.colors.surfaceCard, borderRadius: tokens.radii.md, padding: '8px 10px',
              fontSize: '13px', color: tokens.colors.textStrong, whiteSpace: 'pre-wrap', lineHeight: 1.5, marginBottom: 8,
            }}>{ticket.pending_reason}</div>
          )}

          {showDuplicateChoice ? (
            <div>
              <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, marginBottom: 6 }}>
                이 보고가 기존 티켓의 중복인가요? 원본을 고르면 이 티켓은 원본과 함께 처리됩니다.
              </div>
              {ticket.duplicate_candidates!.map(candidate => (
                <div key={candidate.ticket_id} style={{
                  display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
                  padding: '6px 0', borderTop: `1px solid ${tokens.colors.border}`,
                }}>
                  <div style={{ flex: '1 1 180px', minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong }}>{candidate.title}</div>
                    <div style={{ fontSize: '11px', color: tokens.colors.textMuted }}>
                      {candidate.matched_signals.join(', ').replaceAll('_', ' ')}
                    </div>
                  </div>
                  <button type="button" disabled={busy} onClick={() => void decideDuplicate(candidate.ticket_id)} style={panelButton('plain', busy)}>
                    이 티켓과 중복
                  </button>
                </div>
              ))}
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button type="button" disabled={busy} onClick={() => void decideDuplicate(null)} style={panelButton('plain', busy)}>
                  독립 티켓으로 유지
                </button>
              </div>
            </div>
          ) : (
            <div>
              <textarea
                value={response}
                onChange={e => setResponse(e.target.value)}
                rows={3}
                placeholder="답변·결정을 적으면 코멘트로 남기고 재개합니다 (비워 두면 재개만)"
                style={{ ...controlStyle, fontSize: '13px', resize: 'vertical', lineHeight: 1.5 }}
              />
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 6 }}>
                <button type="button" disabled={busy} onClick={() => void resume()} style={panelButton('success', busy)}>
                  ▶ {response.trim() ? '답변하고 재개' : '재개'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {parkRequested && !ticket.pending_user_action && (
        <div style={box(tokens.colors.warning, tokens.colors.surfaceCard)}>
          <div style={{ fontSize: '12px', fontWeight: 700, color: tokens.colors.warningLight, marginBottom: 6 }}>⏸ 사람 확인 요청</div>
          <textarea
            autoFocus
            value={reason}
            onChange={e => setReason(e.target.value)}
            rows={3}
            placeholder="무엇을 확인해야 하나요? 재개할 때까지 담당자에게 보내지 않습니다."
            style={{ ...controlStyle, fontSize: '13px', resize: 'vertical', lineHeight: 1.5 }}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 6 }}>
            <button type="button" onClick={onParkDone} style={panelButton('plain')}>취소</button>
            <button type="button" disabled={busy || !reason.trim()} onClick={() => void park()} style={panelButton('warning', busy || !reason.trim())}>
              보류
            </button>
          </div>
        </div>
      )}
    </>
  );
}
