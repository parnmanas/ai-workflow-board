import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { tokens } from '../tokens';
import { ErrorState } from './common';
import AgentCard from './AgentCard';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import type { AgentDetail } from '../types';

/**
 * Agent Artifact 상세 (F-3 · ticket 3ca88253).
 *
 * 채팅 AgentRefCard 클릭 시 우측 Artifact 패널 본문으로 주입되는 read-only 뷰다.
 * TicketArtifact.tsx 와 동일한 컨테이너/뷰 분리 + fetch-on-open + SSE 라이브 갱신
 * 패턴을 그대로 따른다. AI Agents 화면과 "같은 컴포넌트"를 재사용하는 것이 핵심
 * 요구사항이라, 요약 블록은 AgentsPage 의 그리드가 쓰는 실제 <AgentCard> 를 그대로
 * 렌더한다(순수 프레젠테이션 컴포넌트라 이 컨텍스트에서도 그대로 동작). AgentCard 가
 * 보여주지 않는 나머지 필드(관리 manager/CLI/working dir)만 아래 Section 으로 보강한다.
 */

export type AgentArtifactState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'loaded'; agent: AgentDetail };

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

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, color: tokens.colors.textSecondary }}>
      <span style={{ color: tokens.colors.textMuted, minWidth: 72, flexShrink: 0 }}>{label}</span>
      <span style={{ color: tokens.colors.textPrimary, overflow: 'hidden', textOverflow: 'ellipsis' }}>{value}</span>
    </div>
  );
}

/**
 * 순수 표현 컴포넌트 — 부수효과 없음. TicketArtifactView 와 동일하게 컨테이너가
 * 상태/네비게이션 콜백을 props 로 주입한다.
 */
export function AgentArtifactView({
  state,
  onOpenDetail,
  onRetry,
}: {
  state: AgentArtifactState;
  onOpenDetail: (agentId: string) => void;
  onRetry?: () => void;
}) {
  if (state.status === 'loading') {
    return (
      <div style={{ padding: tokens.spacing.lg, color: tokens.colors.textSecondary, fontSize: tokens.typography.fontSizeMd }}>
        에이전트 정보를 불러오는 중…
      </div>
    );
  }

  if (state.status === 'error') {
    return <ErrorState title="에이전트 정보를 불러오지 못했습니다" message={state.message} onRetry={onRetry} />;
  }

  const a = state.agent;
  const isManaged = !!a.manager_agent_id;

  return (
    <div style={{ padding: tokens.spacing.lg, display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
      <AgentCard agent={a} onOpenDetail={onOpenDetail} />

      {(isManaged || a.type || a.working_dir) && (
        <Section title="관리 정보">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {isManaged && <InfoRow label="Manager" value={a.manager_name || a.manager_agent_id || '-'} />}
            {a.type && <InfoRow label="CLI" value={a.type} />}
            {a.working_dir && <InfoRow label="Working dir" value={a.working_dir} />}
          </div>
        </Section>
      )}

      <button
        type="button"
        onClick={() => onOpenDetail(a.id)}
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
        AI Agents에서 상세 보기
      </button>
    </div>
  );
}

/**
 * 컨테이너 — agentId 로 상세를 fetch 하고 상태별 뷰를 렌더.
 * agent_status SSE 를 구독해 열린 카드의 online/heartbeat/현재 작업을 라이브
 * 갱신한다(AgentDetailModal 의 동일 구독 선례를 그대로 따름).
 */
export default function AgentArtifact({ agentId }: { agentId: string }) {
  const [state, setState] = useState<AgentArtifactState>({ status: 'loading' });
  const navigate = useNavigate();

  const load = useCallback(
    (showLoading: boolean): (() => void) => {
      let cancelled = false;
      if (showLoading) setState({ status: 'loading' });
      api
        .getAgent(agentId)
        .then((agent) => {
          if (!cancelled) setState({ status: 'loaded', agent });
        })
        .catch((err: any) => {
          if (cancelled) return;
          if (showLoading) setState({ status: 'error', message: err?.message || '네트워크 오류' });
        });
      return () => {
        cancelled = true;
      };
    },
    [agentId],
  );

  useEffect(() => load(true), [load]);

  useBoardStreamEvent(
    'agent_status',
    useCallback(
      (envelope: any) => {
        const payload = envelope?.payload;
        if (!payload || payload.agent_id !== agentId) return;
        setState((prev) =>
          prev.status === 'loaded'
            ? {
                status: 'loaded',
                agent: {
                  ...prev.agent,
                  is_online: !!payload.is_online,
                  last_seen_at: payload.last_seen_at ?? prev.agent.last_seen_at,
                  current_task: payload.current_task,
                  active_tasks: payload.active_tasks !== undefined ? payload.active_tasks : prev.agent.active_tasks,
                },
              }
            : prev,
        );
      },
      [agentId],
    ),
  );

  const retry = useCallback(() => load(true), [load]);
  // AgentCard/the "AI Agents에서 상세 보기" button only render once state is
  // 'loaded' (see AgentArtifactView), so workspace_id is always present in
  // practice — no deep-link fallback needed for an unreachable branch.
  const openDetail = useCallback(
    (id: string) => {
      if (state.status !== 'loaded') return;
      navigate(`/ws/${state.agent.workspace_id}/agents/${id}`);
    },
    [navigate, state],
  );

  return <AgentArtifactView state={state} onOpenDetail={openDetail} onRetry={retry} />;
}
