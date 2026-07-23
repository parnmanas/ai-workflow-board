import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { tokens } from '../tokens';
import { Badge, ErrorState } from './common';
import { useBoardStream, useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { ticketBoardPath } from '../utils/ticketBoardLink';
import type { BoardWithCards, BoardCardColumn, BoardCardTicket } from '../types';

/**
 * Board Artifact 상세 (F-3 · ticket 3ca88253).
 *
 * 채팅 BoardRefCard 클릭 시 우측 Artifact 패널 본문으로 주입되는 read-only 뷰다.
 * TicketArtifact.tsx/AgentArtifact.tsx 와 동일한 컨테이너/뷰 분리 + fetch-on-open +
 * SSE 라이브 갱신 패턴을 그대로 따른다.
 *
 * 실제 보드 화면(Board.tsx → Column → TicketCard)은 @hello-pangea/dnd 의
 * DragDropContext/Droppable/Draggable 에 강결합돼 있고 Column 은 티켓 생성 폼까지
 * 내장한다 — 이 read-only 요약 패널에 그대로 끌어오면 (1) 채팅 카드에서 티켓을
 * 드래그·생성할 수 있게 돼버리고 (2) "대량 컬럼은 최근 일부만" 축약이 불가능하다.
 * TicketArtifact.tsx 가 TicketPanel(30+ props·Board 결합) 대신 같은 프리미티브
 * (tokens·Badge)로 읽기 전용 뷰를 다시 구성한 선례를 그대로 따라, 컬럼 헤더 배지 +
 * 우선순위 배지는 Column.tsx/TicketCard.tsx 와 동일한 시각 언어를 재사용하되 상호작용은
 * 뺐다. 티켓 클릭은 새 뷰어를 열지 않고 실제 보드 UI 로 네비게이트한다
 * (MentionInboxBadge/BoardSettingsPage 가 이미 쓰는 `?ticket=` 딥링크 재사용).
 */

export type BoardArtifactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; board: BoardWithCards };

// 컬럼 티켓이 이 개수를 넘으면 "건수 + 최근 일부만" 으로 축약한다(요구사항 §2, Done 등
// 대량 컬럼 대상). 이하인 컬럼은 보드와 동일한 순서로 전부 보여준다.
const COLUMN_PREVIEW_LIMIT = 5;

// TicketCard.tsx 의 priorityVariants/priorityLabels 와 동일한 매핑 — 실제 보드 카드와
// 같은 배지 톤/라벨을 재사용한다(컴포넌트는 DnD 결합 때문에 못 끌어오지만 시각 언어는 유지).
const PRIORITY_VARIANT: Record<string, 'neutral' | 'info' | 'warning' | 'danger'> = {
  low: 'neutral', medium: 'info', high: 'warning', critical: 'danger',
};
const PRIORITY_LABEL: Record<string, string> = {
  low: 'LOW', medium: 'MED', high: 'HIGH', critical: 'CRIT',
};

// role_holders(다중담당자 프로젝션)가 있으면 그 이름들을, 없으면 레거시 assignee 문자열로
// 폴백한다(TicketCard.tsx 의 동일 폴백을 텍스트 전용으로 단순화 — 아바타 스택은 축약 카드엔 과함).
function ticketAssignee(ticket: BoardCardTicket): string | undefined {
  const holders = (ticket.role_holders || []).find((r) => r.role_slug === 'assignee')?.holders || [];
  if (holders.length > 0) return holders.map((h) => h.name).join(', ');
  return ticket.assignee || undefined;
}

function TicketRow({ ticket, onOpen }: { ticket: BoardCardTicket; onOpen: (ticket: BoardCardTicket) => void }) {
  const assignee = ticketAssignee(ticket);
  return (
    <button
      type="button"
      data-board-artifact-ticket={ticket.id}
      onClick={() => onOpen(ticket)}
      aria-label={`티켓 열기: ${ticket.title}`}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '6px 8px',
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.sm,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <Badge variant={PRIORITY_VARIANT[ticket.priority] ?? 'neutral'}>
        {PRIORITY_LABEL[ticket.priority] ?? ticket.priority}
      </Badge>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 13,
          color: tokens.colors.textPrimary,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {ticket.title}
      </span>
      {assignee && (
        <span
          style={{
            fontSize: 11,
            color: tokens.colors.textSecondary,
            flexShrink: 0,
            maxWidth: 90,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {assignee}
        </span>
      )}
    </button>
  );
}

function ColumnSection({
  column,
  onOpenTicket,
}: {
  column: BoardCardColumn;
  onOpenTicket: (ticket: BoardCardTicket) => void;
}) {
  const total = column.tickets.length;
  const truncated = total > COLUMN_PREVIEW_LIMIT;
  // 대량 컬럼은 최근 갱신순(updated_at desc) 일부만 — Done 처럼 위치 순서가 완료 시점과
  // 무관해진 컬럼에서도 "최근" 이 의미를 갖게 한다. 소량 컬럼은 보드와 동일한 순서 그대로.
  const shown = truncated
    ? [...column.tickets].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || '')).slice(0, COLUMN_PREVIEW_LIMIT)
    : column.tickets;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: column.color, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textStrong }}>{column.name}</span>
        <span
          style={{
            fontSize: 11,
            color: tokens.colors.textMuted,
            background: tokens.colors.surface,
            padding: '1px 6px',
            borderRadius: 10,
          }}
        >
          {total}
        </span>
      </div>
      {shown.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {shown.map((t) => (
            <TicketRow key={t.id} ticket={t} onOpen={onOpenTicket} />
          ))}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: '2px 8px' }}>비어 있음</div>
      )}
      {truncated && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, padding: '0 8px' }}>
          최근 {shown.length}건 표시 · 총 {total}건
        </div>
      )}
    </div>
  );
}

/**
 * 순수 표현 컴포넌트 — 부수효과 없음. TicketArtifactView/AgentArtifactView 와 동일하게
 * 컨테이너가 상태/네비게이션 콜백을 props 로 주입한다.
 */
export function BoardArtifactView({
  state,
  disconnected,
  onOpenTicket,
  onOpenBoard,
  onRetry,
}: {
  state: BoardArtifactState;
  disconnected?: boolean;
  onOpenTicket: (ticket: BoardCardTicket) => void;
  onOpenBoard: () => void;
  onRetry?: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div style={{ padding: tokens.spacing.lg, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd }}>
        보드 정보를 불러오는 중…
      </div>
    );
  }

  if (state.status === 'error') {
    return <ErrorState title="보드 정보를 불러오지 못했습니다" message={state.message} onRetry={onRetry} />;
  }

  const b = state.board;

  return (
    <div style={{ padding: tokens.spacing.lg, display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
      {disconnected && (
        <div
          role="status"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '6px 10px',
            fontSize: tokens.typography.fontSizeXs,
            color: tokens.colors.warningLight,
            background: `${tokens.colors.warning}1A`,
            border: `1px solid ${tokens.colors.warning}40`,
            borderRadius: tokens.radii.sm,
          }}
        >
          <span aria-hidden="true">●</span>
          연결이 끊겨 실시간 갱신이 일시중단됐습니다. 재연결되면 자동으로 최신 내용을 불러옵니다.
        </div>
      )}
      <div>
        <h2 style={{ margin: 0, fontSize: tokens.typography.fontSizeXl, fontWeight: 700, color: tokens.colors.textPrimary }}>
          {b.name}
        </h2>
        {b.description && (
          <div style={{ marginTop: 4, fontSize: 13, color: tokens.colors.textSecondary }}>{b.description}</div>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
        {b.columns.map((col) => (
          <ColumnSection key={col.id} column={col} onOpenTicket={onOpenTicket} />
        ))}
      </div>
      <button
        type="button"
        onClick={onOpenBoard}
        style={{
          alignSelf: 'flex-start',
          padding: '8px 16px',
          background: tokens.colors.accent,
          color: 'white',
          border: 'none',
          borderRadius: tokens.radii.md,
          fontSize: 13,
          fontWeight: 600,
          cursor: 'pointer',
        }}
      >
        보드에서 열기
      </button>
    </div>
  );
}

/**
 * 컨테이너 — boardId 로 보드를 fetch 하고 상태별 뷰를 렌더.
 * board_update SSE 를 구독해 이 보드의 어떤 티켓이든 바뀌면 조용히 재조회한다
 * (TicketArtifact 의 동일 구독 선례 — 여기선 특정 ticket_id 대신 board_id 로 필터).
 */
export default function BoardArtifact({ boardId }: { boardId: string }) {
  const [state, setState] = useState<BoardArtifactState>({ status: 'loading' });
  const { isConnected } = useBoardStream();
  const navigate = useNavigate();

  const load = useCallback(
    (showLoading: boolean): (() => void) => {
      let cancelled = false;
      if (showLoading) setState({ status: 'loading' });
      api
        .getBoard(boardId)
        .then((board) => {
          if (!cancelled) setState({ status: 'loaded', board });
        })
        .catch((err: any) => {
          if (cancelled) return;
          if (showLoading) setState({ status: 'error', message: err?.message || '네트워크 오류' });
        });
      return () => {
        cancelled = true;
      };
    },
    [boardId],
  );

  useEffect(() => load(true), [load]);

  // board_update 는 flatten() 을 거쳐 {board_id, ticket_id, ...} 형태로 평평하게
  // 온다(event-registry.ts) — TicketArtifact 의 data.ticket_id 필터와 동일한 층위.
  useBoardStreamEvent(
    'board_update',
    useCallback(
      (data: any) => {
        if (!data || data.board_id !== boardId) return;
        load(false);
      },
      [boardId, load],
    ),
  );

  const retry = useCallback(() => load(true), [load]);

  // AgentArtifact 의 openDetail 과 동일하게, 로드된 상태에서만 렌더되는 콜백이라
  // workspace_id 는 항상 있다(도달 불가능한 분기에 대한 방어 폴백 불필요). 경로 조합은
  // TicketArtifact.tsx/AgentDetailModal.tsx 와 동일하게 ticketBoardPath 를 재사용한다
  // (티켓 7815a958/dc5c0813 이 도입한 공유 유틸 — 손으로 새로 짜지 않는다). 이 카드에
  // 나열되는 티켓은 정의상 이 보드에 실려 있는 미아카이브 티켓뿐이라 canOpenTicketOnBoard
  // 게이트는 불필요하다.
  const openTicket = useCallback(
    (ticket: BoardCardTicket) => {
      if (state.status !== 'loaded') return;
      navigate(ticketBoardPath({ id: ticket.id, board_id: boardId, workspace_id: state.board.workspace_id }));
    },
    [navigate, state, boardId],
  );

  const openBoard = useCallback(() => {
    if (state.status !== 'loaded') return;
    navigate(`/ws/${encodeURIComponent(state.board.workspace_id)}/boards/${encodeURIComponent(boardId)}`);
  }, [navigate, state, boardId]);

  return (
    <BoardArtifactView
      state={state}
      disconnected={!isConnected}
      onOpenTicket={openTicket}
      onOpenBoard={openBoard}
      onRetry={retry}
    />
  );
}
