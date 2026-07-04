import React, { useEffect, useMemo, useState } from 'react';
import { Ticket, HandoffSpec, HandoffHop, HandoffPipeline } from '../types';
import { api } from '../api';
import { tokens } from '../tokens';

interface BoardOption {
  id: string;
  name: string;
  columns: Array<{ id: string; name: string }>;
}

interface HandoffEditorProps {
  ticket: Ticket;
  // Workspace boards (excluding the current one) — the hop target picker. Same
  // list the move-to-board picker uses. Lazily loaded by the parent.
  boardOptions: BoardOption[];
  boardsLoading?: boolean;
  onEnsureBoards: () => void;
  // Controlled draft. null = no relay. Committed via the panel's Save footer.
  value: HandoffSpec | null;
  onChange: (spec: HandoffSpec | null) => void;
}

/**
 * Cross-board handoff relay editor + pipeline rollup (ticket ac21a745).
 *
 * Top: an ordered hop editor — each hop creates a follow-up on a target board
 * when this ticket completes; the relay walks the hops board-by-board. Bottom:
 * a read-only rollup of the relay this ticket belongs to (fetched from the REST
 * bridge GET /tickets/:id/handoff-pipeline), so a user can see the whole
 * 기획→그래픽→클라 chain and where it currently sits without hopping boards.
 */
export default function HandoffEditor({
  ticket,
  boardOptions,
  boardsLoading,
  onEnsureBoards,
  value,
  onChange,
}: HandoffEditorProps) {
  const [pipeline, setPipeline] = useState<HandoffPipeline | null>(null);
  const [pipelineLoading, setPipelineLoading] = useState(false);

  // Add-hop draft controls.
  const [draftBoardId, setDraftBoardId] = useState('');
  const [draftColumn, setDraftColumn] = useState('');
  const [draftCarry, setDraftCarry] = useState(true);

  // Lazily load the board options the first time the editor mounts.
  useEffect(() => { onEnsureBoards(); }, [onEnsureBoards]);

  // Fetch the relay rollup for this ticket. Only meaningful for root tickets;
  // a fetch failure (e.g. not part of a relay) just leaves the section hidden.
  useEffect(() => {
    let cancelled = false;
    if (ticket.column_id === null) { setPipeline(null); return; }
    setPipelineLoading(true);
    api.getHandoffPipeline(ticket.id)
      .then((p) => { if (!cancelled) setPipeline(p); })
      .catch(() => { if (!cancelled) setPipeline(null); })
      .finally(() => { if (!cancelled) setPipelineLoading(false); });
    return () => { cancelled = true; };
  }, [ticket.id, ticket.column_id]);

  const hops = value?.hops || [];
  const boardName = (id: string) => boardOptions.find((b) => b.id === id)?.name || id;
  const draftBoard = boardOptions.find((b) => b.id === draftBoardId);

  const setHops = (next: HandoffHop[]) => onChange(next.length > 0 ? { hops: next } : null);

  const addHop = () => {
    if (!draftBoardId) return;
    const hop: HandoffHop = { target_board_id: draftBoardId };
    if (draftColumn) hop.target_column_name = draftColumn;
    if (draftCarry) hop.carry_attachments = true;
    setHops([...hops, hop]);
    setDraftBoardId('');
    setDraftColumn('');
    setDraftCarry(true);
  };

  const removeHop = (i: number) => setHops(hops.filter((_, idx) => idx !== i));
  const moveHop = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= hops.length) return;
    const next = hops.slice();
    [next[i], next[j]] = [next[j], next[i]];
    setHops(next);
  };

  const labelStyle: React.CSSProperties = {
    fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 600,
    textTransform: 'uppercase', display: 'block', marginBottom: 4,
  };
  const cardStyle: React.CSSProperties = {
    background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.lg, padding: '8px 10px',
  };
  const selectStyle: React.CSSProperties = {
    background: tokens.colors.surfaceCard, border: `2px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md, padding: '5px 8px',
    color: tokens.colors.textStrong, fontSize: '12px', fontWeight: 600,
  };
  const iconBtn: React.CSSProperties = {
    background: 'transparent', border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.sm, color: tokens.colors.textMuted,
    cursor: 'pointer', fontSize: '11px', padding: '1px 6px', lineHeight: 1.4,
  };

  const rollupStages = pipeline?.stages || [];
  const showRollup = rollupStages.length > 1 || !!ticket.handoff_source_ticket_id;

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>크로스보드 핸드오프 릴레이</label>
      <div style={cardStyle}>
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 8 }}>
          이 티켓이 완료(terminal)되면 아래 순서대로 다음 보드에 후속 티켓을 자동 생성합니다
          (산출물 컨텍스트·첨부 이월). 홉을 여러 개 걸면 기획→그래픽→클라처럼 보드를 이어 릴레이합니다.
        </div>

        {/* Existing hops */}
        {hops.length === 0 ? (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, fontStyle: 'italic', marginBottom: 8 }}>
            홉 없음 — 핸드오프 비활성.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 8 }}>
            {hops.map((hop, i) => (
              <div key={i} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '5px 8px',
              }}>
                <span style={{ fontSize: 11, color: tokens.colors.textMuted, fontWeight: 700 }}>{i + 1}.</span>
                <span style={{ flex: 1, fontSize: 12, color: tokens.colors.textStrong }}>
                  → <strong>{boardName(hop.target_board_id)}</strong>
                  <span style={{ color: tokens.colors.textMuted }}>
                    {' / '}{hop.target_column_name || '(첫 라우팅 컬럼)'}
                  </span>
                  {hop.carry_attachments ? (
                    <span style={{ marginLeft: 6, fontSize: 10, color: tokens.colors.accent }}>📎 첨부 이월</span>
                  ) : null}
                </span>
                <button type="button" style={iconBtn} disabled={i === 0} onClick={() => moveHop(i, -1)} title="위로">↑</button>
                <button type="button" style={iconBtn} disabled={i === hops.length - 1} onClick={() => moveHop(i, 1)} title="아래로">↓</button>
                <button
                  type="button"
                  style={{ ...iconBtn, color: tokens.colors.danger, borderColor: tokens.colors.danger }}
                  onClick={() => removeHop(i)}
                  title="홉 제거"
                >×</button>
              </div>
            ))}
          </div>
        )}

        {/* Add hop */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
          <select
            value={draftBoardId}
            onChange={(e) => { setDraftBoardId(e.target.value); setDraftColumn(''); }}
            onFocus={onEnsureBoards}
            style={{ ...selectStyle, minWidth: 140 }}
          >
            <option value="">
              {boardsLoading ? '보드 로딩…' : '+ 대상 보드 선택'}
            </option>
            {boardOptions.map((b) => (
              <option key={b.id} value={b.id}>{b.name}</option>
            ))}
          </select>
          <select
            value={draftColumn}
            onChange={(e) => setDraftColumn(e.target.value)}
            disabled={!draftBoard}
            style={{ ...selectStyle, minWidth: 120 }}
          >
            <option value="">(첫 라우팅 컬럼)</option>
            {(draftBoard?.columns || []).map((c) => (
              <option key={c.id} value={c.name}>{c.name}</option>
            ))}
          </select>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: tokens.colors.textMuted }}>
            <input type="checkbox" checked={draftCarry} onChange={(e) => setDraftCarry(e.target.checked)} />
            첨부 이월
          </label>
          <button
            type="button"
            onClick={addHop}
            disabled={!draftBoardId}
            style={{
              background: draftBoardId ? tokens.colors.accent : tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
              color: draftBoardId ? '#fff' : tokens.colors.textMuted,
              cursor: draftBoardId ? 'pointer' : 'not-allowed', fontSize: 12, fontWeight: 600, padding: '5px 10px',
            }}
          >홉 추가</button>
        </div>
      </div>

      {/* Pipeline rollup (read-only) */}
      {showRollup && (
        <div style={{ ...cardStyle, marginTop: 10 }}>
          <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontWeight: 700, marginBottom: 8 }}>
            릴레이 파이프라인 {pipelineLoading ? '(로딩…)' : `(${rollupStages.length}단계)`}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {rollupStages.map((s, i) => {
              const isCurrent = s.ticket_id === ticket.id;
              const statusLabel = s.is_terminal ? '완료' : s.pending_on_tickets ? '대기(차단)' : '진행중';
              const statusColor = s.is_terminal ? tokens.colors.success : s.pending_on_tickets ? tokens.colors.warning : tokens.colors.accent;
              return (
                <div key={s.ticket_id} style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '4px 6px', borderRadius: tokens.radii.sm,
                  background: isCurrent ? tokens.colors.surfaceHover : 'transparent',
                  border: isCurrent ? `1px solid ${tokens.colors.accent}` : '1px solid transparent',
                }}>
                  <span style={{ fontSize: 10, color: tokens.colors.textMuted, fontWeight: 700, width: 14 }}>{i + 1}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, color: statusColor,
                    border: `1px solid ${statusColor}`, borderRadius: tokens.radii.sm, padding: '0 5px', whiteSpace: 'nowrap',
                  }}>{statusLabel}</span>
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>{s.board_name}</span>
                  <span style={{
                    flex: 1, fontSize: 12,
                    color: isCurrent ? tokens.colors.textStrong : tokens.colors.textSecondary,
                    fontWeight: isCurrent ? 700 : 400, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {s.title}
                    {s.is_rejection ? <span style={{ marginLeft: 6, fontSize: 10, color: tokens.colors.danger }}>반려</span> : null}
                  </span>
                  <span style={{ fontSize: 10, color: tokens.colors.textMuted, whiteSpace: 'nowrap' }}>{s.column_name}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
