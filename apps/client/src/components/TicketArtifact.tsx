import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { tokens } from '../tokens';
import { renderMarkdown } from './chat/utils/markdown';

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
    accent: { bg: 'rgba(99,102,241,0.12)', fg: tokens.colors.accentSubtle },
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

/** 순수 표현 컴포넌트 — 부수효과 없음. 상태는 전부 props 로 받는다. */
export function TicketArtifactView({ state }: { state: TicketArtifactState }) {
  if (state.status === 'loading') {
    return (
      <div style={{ padding: tokens.spacing.lg, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd }}>
        티켓을 불러오는 중…
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div
        role="alert"
        style={{ padding: tokens.spacing.lg, color: tokens.colors.danger, fontSize: tokens.typography.fontSizeMd, lineHeight: 1.5 }}
      >
        티켓을 불러오지 못했습니다.
        <div style={{ marginTop: 4, color: tokens.colors.textMuted, fontSize: 12 }}>{state.message}</div>
      </div>
    );
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

/** 컨테이너 — ticketId 로 상세를 fetch 하고 상태별 뷰를 렌더. */
export default function TicketArtifact({ ticketId }: { ticketId: string }) {
  const [state, setState] = useState<TicketArtifactState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    api
      .getTicket(ticketId)
      .then((ticket) => {
        if (cancelled) return;
        setState({ status: 'loaded', ticket });
      })
      .catch((err: any) => {
        if (cancelled) return;
        setState({ status: 'error', message: err?.message || '네트워크 오류' });
      });
    return () => {
      cancelled = true;
    };
    // 실시간 갱신(ticket_updated SSE 재조회)은 종합 상태 설계(F-2)로 미룬다 — S3 는
    // 카드 클릭 시점 상세를 여는 데 집중한다.
  }, [ticketId]);

  return <TicketArtifactView state={state} />;
}
