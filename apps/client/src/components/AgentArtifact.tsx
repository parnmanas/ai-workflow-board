import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, getActiveWorkspaceId } from '../api';
import { tokens } from '../tokens';
import { ErrorState } from './common';
import AgentCard from './AgentCard';
import { useBoardStreamEvent } from '../contexts/BoardStreamContext';
import { useCloseArtifactPanel } from '../contexts/ArtifactPanelContext';
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
 * `runtime_config.permission_mode` 옆에 붙는 해설 (ticket 6705d39b).
 *
 * 이 값은 운영자가 에이전트에 **설정한** trust 일 뿐, 그 에이전트가 spawn 될 때
 * 실제로 받는 권한 등급이 아니다. 실효 등급은 매니저의
 * `resolveEffectivePermissionPolicy()`(`apps/agent-manager/src/lib/permission-policy.ts`)
 * 가 디스패치 시점에 판정하며, 여기 표시된 값과 갈리는 경로가 실재한다 —
 * trust 가 인식 불가능한 값이면 `strict` 로 fail-closed 강등되고, trust 가 아예
 * 없으면 보드·워크스페이스 harness 의 `permission_mode` 가 등급을 정한다. 등급이
 * 그대로여도 런타임이 그 등급을 native 로 표현하지 못해 근사되거나(antigravity/pi
 * 의 strict), `approve` 처럼 승인 브릿지가 없는 런타임에서는 spawn 자체가 차단된다.
 *
 * 그래서 라벨만 "Permission" 이면 운영자가 이 값을 "이 에이전트가 실제로 갖는
 * 권한"으로 읽는다. 라벨을 설정값 쪽으로 좁히고(`Trust 설정`) 실효 등급과 갈릴 수
 * 있다는 사실을 값 옆에 함께 노출한다. 용어는 Agent details 가 실효값을 부르는
 * "권한 등급" 과 겹치지 않게 골랐다 — 두 화면이 서로 다른 것을 보여준다는 점이
 * 이름에서 드러나야 한다.
 */
const TRUST_CONFIGURED_NOTE = '설정값 — 실효 등급과 다를 수 있음';
// 툴팁은 origin/main 에 실재하는 것만 가리킨다 — 아직 안 올라온 화면으로 안내하면
// 그것 자체가 이 티켓이 고치는 오표시가 된다.
const TRUST_CONFIGURED_HINT =
  '에이전트에 설정된 trust 값입니다. 실제 적용되는 권한 등급은 디스패치 시점에 매니저가 판정합니다 — '
  + 'trust 가 유효하지 않으면 strict 로 강등되고, trust 가 없으면 보드·워크스페이스 harness 설정이 '
  + '등급을 정합니다. 런타임이 해당 등급을 그대로 표현하지 못하면 근사되거나 실행이 차단될 수도 있습니다.';

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
  const hasRuntimeHost = !!a.manager_agent_id;

  return (
    <div style={{ padding: tokens.spacing.lg, display: 'flex', flexDirection: 'column', gap: tokens.spacing.lg }}>
      <AgentCard agent={a} onOpenDetail={onOpenDetail} />

      <Section title="Execution">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <InfoRow
            label="Runtime Host"
            value={hasRuntimeHost ? (a.manager_name || a.manager_agent_id) : 'Required — not assigned'}
          />
          {a.type && <InfoRow label="Runtime" value={a.type} />}
          {a.runtime_config?.strategy && <InfoRow label="Strategy" value={a.runtime_config.strategy} />}
          {a.runtime_config?.permission_mode && (
            <InfoRow
              label="Trust 설정"
              value={
                <span title={TRUST_CONFIGURED_HINT}>
                  {a.runtime_config.permission_mode}
                  <span style={{ color: tokens.colors.textMuted, marginLeft: 8 }}>
                    {TRUST_CONFIGURED_NOTE}
                  </span>
                </span>
              }
            />
          )}
          {a.working_dir && <InfoRow label="Working dir" value={a.working_dir} />}
        </div>
      </Section>

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
  const closeArtifact = useCloseArtifactPanel();

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
  // 이동에 성공했을 때만 패널을 접는다 — workspace 를 못 구해 이동이 무산되면
  // 사용자는 아무 데도 가지 않으므로 아티팩트는 열린 채로 둔다.
  const openDetail = useCallback(
    (id: string) => {
      if (state.status !== 'loaded') return;
      const workspaceId = state.agent.workspace_id || getActiveWorkspaceId();
      if (!workspaceId) return;
      navigate(`/ws/${workspaceId}/agents/${id}`);
      closeArtifact();
    },
    [navigate, state, closeArtifact],
  );

  return <AgentArtifactView state={state} onOpenDetail={openDetail} onRetry={retry} />;
}
