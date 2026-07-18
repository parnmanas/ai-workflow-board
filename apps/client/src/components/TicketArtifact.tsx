import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { tokens } from '../tokens';
import { renderMarkdown } from './chat/utils/markdown';
import { ErrorState } from './common';
import { useBoardStream, useBoardStreamEvent } from '../contexts/BoardStreamContext';

/**
 * 티켓 Artifact 상세 (에픽 bf65ca00 · Phase 1 · S3).
 *
 * 채팅/코멘트 티켓 카드(TicketRefCard) 클릭 시 우측 Artifact 패널 본문으로 주입되는
 * 경량 read-only 뷰다. 편집기인 TicketPanel(30+ props·Board 결합)을 그대로 끌어오지
 * 않고, 같은 프리미티브(tokens·renderMarkdown·배지)로 상세를 읽기 전용 렌더한다 —
 * 대화 맥락을 유지한 채 상세를 확인하는 Phase 1 목적에 맞춘 최소 표면. 편집/승인/결과물
 * 카드 등 처리 액션은 후속(F-2)에서 확장한다.
 *
 * 컨테이너/뷰 분리: 순수 <TicketArtifactView>(state props)로 상태별(로딩·오류·로드)
 * 마크업을 react-dom/server 로 회귀 테스트하고(jsdom 없이), fetch·부수효과는 컨테이너가
 * 담당한다(ArtifactPanel·viewMode 선례).
 */

export type TicketArtifactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; ticket: any };

function Chip({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'accent' | 'danger' | 'muted' }) {
  const palette: Record<string, { bg: string; fg: string }> = {
    default: { bg: tokens.colors.surfaceCard, fg: tokens.colors.textSecondary },
    accent: { bg: tokens.overlays.accentSoft, fg: tokens.colors.accentSubtle },
    danger: { bg: `${tokens.colors.danger}1A`, fg: tokens.colors.danger },
    muted: { bg: `${tokens.colors.border}60`, fg: tokens.colors.textMuted },
  };
  const c = palette[tone] || palette.default;
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        padding: '1px 8px',
        fontSize: 12,
        fontWeight: 600,
        color: c.fg,
        background: c.bg,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.sm,
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          fontSize: 11,
          fontWeight: 700,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: tokens.colors.textMuted,
        }}
      >
        {title}
      </div>
      {children}
    </div>
  );
}

function roleNames(ticket: any, slug: string): string[] {
  const assignments = Array.isArray(ticket?.role_assignments) ? ticket.role_assignments : [];
  const names = assignments
    .filter((r: any) => r?.slug === slug && r?.holder?.name)
    .map((r: any) => r.holder.name as string);
  if (names.length > 0) return names;
  // 폴백: role_assignments 가 비어 있으면 비정규화 표시 필드(assignee/reporter)를 쓴다.
  const legacy = slug === 'assignee' ? ticket?.assignee : slug === 'reporter' ? ticket?.reporter : null;
  return legacy ? [String(legacy)] : [];
}

const PRIORITY_TONE: Record<string, 'danger' | 'accent' | 'muted'> = {
  high: 'danger',
  medium: 'accent',
  low: 'muted',
};

/**
 * 순수 표현 컴포넌트 — 부수효과 없음. 상태는 전부 props 로 받는다.
 * disconnected 는 SSE 단절 시 로드 뷰 상단에 "실시간 갱신 일시중단" 배너를 띄운다
 * (컨테이너가 useBoardStream().isConnected 를 주입). onRetry 는 오류 상태에서
 * 재시도 버튼을 노출한다.
 */
export function TicketArtifactView({
  state,
  disconnected,
  onRetry,
}: {
  state: TicketArtifactState;
  disconnected?: boolean;
  onRetry?: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div style={{ padding: tokens.spacing.lg, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd }}>
        티켓을 불러오는 중…
      </div>
    );
  }

  if (state.status === 'error') {
    // 공통 오류 표현(F2-3). title 은 티켓 문맥으로 좁혀 회귀 계약(role=alert +
    // "불러오지 못했습니다" + 원문 message) 을 유지한다.
    return <ErrorState title="티켓을 불러오지 못했습니다" message={state.message} onRetry={onRetry} />;
  }

  const t = state.ticket || {};
  const labels: string[] = Array.isArray(t.labels) ? t.labels : [];
  const children: any[] = Array.isArray(t.children) ? t.children : [];
  const comments: any[] = Array.isArray(t.comments) ? t.comments : [];
  const assignees = roleNames(t, 'assignee');
  const reporters = roleNames(t, 'reporter');
  const reviewers = roleNames(t, 'reviewer');
  // 시스템 코멘트는 노이즈라 상세 요약에선 걸러 최근 사람/에이전트 발화만 몇 개 보여준다.
  const visibleComments = comments.filter((c) => c?.author_type !== 'system').slice(-4);

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
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <h2
          style={{
            margin: 0,
            fontSize: tokens.typography.fontSizeXl,
            fontWeight: 700,
            color: tokens.colors.textPrimary,
            lineHeight: tokens.typography.lineHeightHeading,
          }}
        >
          {t.title || '(제목 없음)'}
        </h2>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
          {t.priority && <Chip tone={PRIORITY_TONE[String(t.priority)] || 'default'}>{String(t.priority)}</Chip>}
          {t.status && <Chip tone="muted">{String(t.status)}</Chip>}
          {labels.map((l) => (
            <Chip key={l} tone="accent">{l}</Chip>
          ))}
        </div>
      </div>

      {(assignees.length > 0 || reporters.length > 0 || reviewers.length > 0) && (
        <Section title="담당">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 13, color: tokens.colors.textSecondary }}>
            {assignees.length > 0 && <div><span style={{ color: tokens.colors.textMuted }}>담당자 </span>{assignees.join(', ')}</div>}
            {reporters.length > 0 && <div><span style={{ color: tokens.colors.textMuted }}>보고자 </span>{reporters.join(', ')}</div>}
            {reviewers.length > 0 && <div><span style={{ color: tokens.colors.textMuted }}>리뷰어 </span>{reviewers.join(', ')}</div>}
          </div>
        </Section>
      )}

      {t.description && (
        <Section title="설명">
          <div
            style={{
              fontSize: 14,
              color: tokens.colors.textPrimary,
              lineHeight: 1.6,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {renderMarkdown(String(t.description))}
          </div>
        </Section>
      )}

      {children.length > 0 && (
        <Section title={`하위 작업 (${children.length})`}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {children.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: 13,
                  color: tokens.colors.textSecondary,
                }}
              >
                <Chip tone={c.status === 'done' ? 'muted' : 'accent'}>{c.status || 'todo'}</Chip>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.title}</span>
              </div>
            ))}
          </div>
        </Section>
      )}

      {visibleComments.length > 0 && (
        <Section title="최근 코멘트">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {visibleComments.map((c) => (
              <div key={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.textPrimary }}>{c.author || '알 수 없음'}</div>
                <div style={{ fontSize: 13, color: tokens.colors.textSecondary, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {renderMarkdown(String(c.content || ''))}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}
    </div>
  );
}

/**
 * 컨테이너 — ticketId 로 상세를 fetch 하고 상태별 뷰를 렌더.
 *
 * 종합 상태 설계(F2-3): (1) SSE `board_update` 를 구독해 열린 티켓이 대상이면
 * 조용히 재조회하고(이미 로드된 상세는 로딩 표시로 깜빡이지 않게 재조회 실패만
 * 무시), (2) 스트림 단절 시 로드 뷰 상단에 배너를 노출하며(재연결 시 board_update
 * 로 자동 최신화), (3) 오류 상태에 재시도 버튼을 배선한다. ticketId 가 바뀌면
 * (다중 태스크 전환) 즉시 로딩으로 초기화해 이전 티켓 내용이 남지 않게 한다.
 */
export default function TicketArtifact({ ticketId }: { ticketId: string }) {
  const [state, setState] = useState<TicketArtifactState>({ status: 'loading' });
  const { isConnected } = useBoardStream();

  // showLoading=false 는 이미 로드된 상세의 백그라운드 재조회용 — 성공 시에만
  // 교체하고 실패는 무시해 실시간 갱신이 화면을 깜빡이거나 오류로 덮지 않게 한다.
  const load = useCallback(
    (showLoading: boolean): (() => void) => {
      let cancelled = false;
      if (showLoading) setState({ status: 'loading' });
      api
        .getTicket(ticketId)
        .then((ticket) => {
          if (!cancelled) setState({ status: 'loaded', ticket });
        })
        .catch((err: any) => {
          if (cancelled) return;
          if (showLoading) setState({ status: 'error', message: err?.message || '네트워크 오류' });
        });
      return () => {
        cancelled = true;
      };
    },
    [ticketId],
  );

  // ticketId 전환(다중 태스크 스위치) → 로딩으로 초기화 후 재조회.
  useEffect(() => load(true), [load]);

  // 실시간 — 열린 티켓이 board_update 의 대상이면 조용히 재조회.
  useBoardStreamEvent(
    'board_update',
    useCallback(
      (data: any) => {
        if (!data || data.ticket_id !== ticketId) return;
        load(false);
      },
      [ticketId, load],
    ),
  );

  const retry = useCallback(() => load(true), [load]);

  return <TicketArtifactView state={state} disconnected={!isConnected} onRetry={retry} />;
}
