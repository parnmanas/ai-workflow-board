import React, { useMemo, useState } from 'react';
import type { AgentManagerInstance, DashboardAgent } from '../../types';
import { tokens } from '../../tokens';
import { Button, EmptyState, ErrorState, Input, Select } from '../common';
import AgentCard from '../AgentCard';
import {
  AGENT_GROUP_BY_OPTIONS,
  AGENT_STATUS_META,
  AGENT_STATUS_ORDER,
  type AgentGroupBy,
  type AgentStatusCategory,
  countByStatus,
  filterAgents,
  groupAgents,
} from './agentFleet.logic';

/**
 * AI Agents 화면의 주 표면 — 워크스페이스의 Agent 를 **카테고리로 묶어** 보여준다.
 *
 * 이전 화면은 Agent 를 두 군데에 흩어 놓았다: 비관리자는 제목·상태만 반복되는 평면
 * 목록 하나, 관리자는 Runtime Host 콘솔 안의 "Managed agents (N)" 카드와 "Without a
 * live runtime" 잔여 목록. 어느 쪽에서도 "지금 무엇이 고장났나 / 어느 장비가 무엇을
 * 돌리나" 를 한눈에 볼 수 없었다.
 *
 * 그래서 이 패널의 축은 셋이고 전부 같은 로직(`agentFleet.logic.ts`)에서 나온다:
 *   - 상태 칩: 손볼 것(오류)부터 세어 보여주고, 누르면 그 카테고리만 남긴다.
 *   - 그룹: Runtime Host(기본) · 상태 · CLI. 장비별 보기가 기본인 이유는 spawn·중지가
 *     결국 장비 단위 작업이기 때문이다.
 *   - 검색: 이름(매니저 접두 포함) · 설명 · 작업 폴더 · CLI · 모델.
 *
 * 카드는 기존 `AgentCard` 를 그대로 쓴다 — 아바타·상태 배지·진행 중 작업·관리자용
 * 라이프사이클 버튼이 이미 그 안에 있고, Agent artifact 패널도 같은 카드를 쓰므로
 * 두 표면이 저절로 같은 모양을 유지한다.
 */
interface AgentFleetPanelProps {
  agents: DashboardAgent[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onOpenAgent: (agentId: string) => void;
  /** 관리자에게만 전달된다 — 카드의 spawn/중지/재시작 버튼을 켜는 값. */
  managerInstances?: AgentManagerInstance[];
  isAdmin?: boolean;
  /** 라이프사이클 명령을 보낸 뒤 목록을 다시 읽게 한다. */
  onLifecycleDispatched?: () => void;
  /** 비어 있을 때 보여 줄 기본 동작(예: + New Agent). */
  emptyAction?: React.ReactNode;
}

const GRID_STYLE: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
  gap: 12,
  alignItems: 'stretch',
};

function StatusChip({
  label,
  count,
  active,
  variant,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  variant: 'success' | 'danger' | 'warning' | 'info' | 'neutral';
  onClick: () => void;
}) {
  const accent =
    variant === 'danger' ? tokens.colors.dangerLight
      : variant === 'warning' ? tokens.colors.warningLight
        : variant === 'info' ? tokens.colors.accentLight
          : variant === 'success' ? tokens.colors.successLight
            : tokens.colors.textSecondary;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '5px 10px',
        borderRadius: tokens.radii.full,
        border: `1px solid ${active ? accent : tokens.colors.border}`,
        background: active ? `${accent}1f` : tokens.colors.surfaceCard,
        color: active ? accent : tokens.colors.textSecondary,
        fontSize: 12,
        fontWeight: 600,
        fontFamily: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: tokens.radii.full,
          background: accent,
          flexShrink: 0,
          opacity: count > 0 ? 1 : 0.35,
        }}
      />
      {label}
      <span style={{ color: active ? accent : tokens.colors.textMuted, fontWeight: 700 }}>{count}</span>
    </button>
  );
}

export default function AgentFleetPanel({
  agents,
  loading,
  error,
  onRetry,
  onOpenAgent,
  managerInstances = [],
  isAdmin,
  onLifecycleDispatched,
  emptyAction,
}: AgentFleetPanelProps) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<AgentStatusCategory | null>(null);
  const [groupBy, setGroupBy] = useState<AgentGroupBy>('host');

  // 칩의 숫자는 **검색 결과 기준**이다 — 검색으로 좁힌 뒤 칩이 여전히 전체 개수를
  // 세면 "오류 1" 을 눌렀는데 아무것도 안 나오는 상태가 된다.
  const searched = useMemo(() => filterAgents(agents, { query }), [agents, query]);
  const counts = useMemo(() => countByStatus(searched), [searched]);
  const visible = useMemo(() => filterAgents(searched, { status }), [searched, status]);
  // 호스트 이름은 Agent 행에 실려 오지만(서버 dashboard 가 붙인다), 구버전 서버나
  // 아직 하트비트를 못 받은 경우를 대비해 인스턴스 목록으로도 메운다.
  const hostNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const agent of agents) {
      const id = (agent.manager_agent_id || '').trim();
      const name = (agent.manager_name || '').trim();
      if (id && name && !map.has(id)) map.set(id, name);
    }
    for (const inst of managerInstances) {
      if (!map.has(inst.agent_id) && inst.hostname) map.set(inst.agent_id, inst.hostname);
    }
    return map;
  }, [agents, managerInstances]);
  const groups = useMemo(
    () => groupAgents(visible, groupBy, { hostNames }),
    [visible, groupBy, hostNames],
  );

  // 카드의 라이프사이클 버튼은 그 Agent 를 감독하는 호스트의 라이브 인스턴스를 받아야
  // 명령을 보낼 수 있다. manager_agent_id → 인스턴스로 한 번만 색인한다.
  const instanceByManager = useMemo(() => {
    const map = new Map<string, AgentManagerInstance>();
    for (const inst of managerInstances) {
      const prev = map.get(inst.agent_id);
      if (!prev || prev.last_seen_at < inst.last_seen_at) map.set(inst.agent_id, inst);
    }
    return map;
  }, [managerInstances]);

  if (error) {
    return (
      <ErrorState title="Agent 목록을 불러오지 못했습니다" message={error} onRetry={onRetry ?? undefined} />
    );
  }

  if (loading && agents.length === 0) {
    return (
      <div style={{ padding: 24, fontSize: 13, color: tokens.colors.textSecondary }}>
        Agent 목록을 불러오는 중…
      </div>
    );
  }

  if (agents.length === 0) {
    return (
      <EmptyState
        title="아직 Agent 가 없습니다"
        description="Runtime Host 를 하나 붙인 뒤 그 위에 Agent 를 만들면 여기에 나타납니다."
        action={emptyAction}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, minHeight: 0 }}>
      {/* ── 툴바: 검색 + 그룹 기준 ─────────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px', maxWidth: 360, minWidth: 180 }}>
          <Input
            aria-label="Agent 검색"
            placeholder="이름 · 폴더 · CLI · 모델 검색"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div style={{ width: 200 }}>
          <Select
            aria-label="그룹 기준"
            value={groupBy}
            onChange={(e) => setGroupBy((e.target as HTMLSelectElement).value as AgentGroupBy)}
            options={AGENT_GROUP_BY_OPTIONS.map((o) => ({ value: o.value, label: `그룹: ${o.label}` }))}
          />
        </div>
        <div style={{ marginLeft: 'auto', fontSize: 12, color: tokens.colors.textMuted, paddingBottom: 9 }}>
          {visible.length === agents.length
            ? `${agents.length}개`
            : `${visible.length} / ${agents.length}개`}
        </div>
      </div>

      {/* ── 상태 칩: 세면서 동시에 필터 ────────────────────────────────── */}
      <div role="group" aria-label="상태 필터" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <StatusChip
          label="전체"
          count={searched.length}
          active={status === null}
          variant="neutral"
          onClick={() => setStatus(null)}
        />
        {AGENT_STATUS_ORDER.map((category) => (
          <StatusChip
            key={category}
            label={AGENT_STATUS_META[category].label}
            count={counts[category]}
            active={status === category}
            variant={AGENT_STATUS_META[category].variant}
            // 누른 칩을 다시 누르면 전체로 돌아온다.
            onClick={() => setStatus((prev) => (prev === category ? null : category))}
          />
        ))}
      </div>

      {/* ── 그룹별 카드 ────────────────────────────────────────────────── */}
      {groups.length === 0 ? (
        <EmptyState
          title="조건에 맞는 Agent 가 없습니다"
          description="검색어나 상태 필터를 지우면 전체 목록이 다시 보입니다."
          action={
            <Button variant="secondary" size="sm" onClick={() => { setQuery(''); setStatus(null); }}>
              필터 지우기
            </Button>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {groups.map((group) => (
            <section key={group.key} aria-label={group.label}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  marginBottom: 8,
                  paddingBottom: 6,
                  borderBottom: `1px solid ${tokens.colors.border}`,
                }}
              >
                <h3
                  style={{
                    margin: 0,
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: '0.05em',
                    textTransform: 'uppercase',
                    color: tokens.colors.textPrimary,
                  }}
                >
                  {group.label}
                </h3>
                <span style={{ fontSize: 12, color: tokens.colors.textMuted, fontWeight: 600 }}>
                  {group.agents.length}
                </span>
                {group.hint && (
                  <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>· {group.hint}</span>
                )}
              </div>
              <div style={GRID_STYLE}>
                {group.agents.map((agent) => (
                  <AgentCard
                    key={agent.id}
                    agent={agent}
                    onOpenDetail={onOpenAgent}
                    managerInstance={
                      agent.manager_agent_id ? instanceByManager.get(agent.manager_agent_id) ?? null : null
                    }
                    isAdmin={isAdmin}
                    onLifecycleDispatched={onLifecycleDispatched}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
