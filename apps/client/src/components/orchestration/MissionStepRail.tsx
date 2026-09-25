import React from 'react';
import { tokens } from '../../tokens';
import type { OrchestrationCounts, OrchestrationGraphSpec, OrchestrationStep } from '../../types';
import { stepStyle } from './status';
import { computeDepths } from './PlanGraph';
import { compactActivityLabel, describeStepActivity, describeStepQuiet } from './step-activity';

/**
 * 미션 화면의 좌측 레일 — "무엇을 볼지" 고르는 목록.
 *
 * 이 레일이 채팅의 채널 목록과 같은 모양인 것은 의도다. 맨 위 한 줄이 **미션 대화**이고
 * 그 아래가 step 들이라, "step 을 고르면 그 step 의 작업 세션, 선택을 풀면 미션 대화"가
 * 화면 구조 자체로 드러난다. 선택된 step 을 다시 누르면 선택이 풀린다(= 미션 대화로).
 *
 * step 은 **단계(stage/wave)로 묶어** 세로로 늘어놓는다. 실행 순서는 의존성 깊이가
 * 결정하므로(같은 묶음 = 진짜 병렬 작업), 그 사실을 잃지 않으면서 좁은 폭에 들어가야
 * 한다. 위상 전체를 보고 싶을 때는 오른쪽 패널의 Graph 탭이 넓은 그래프를 그린다 —
 * 240px 열을 여러 개 늘어놓는 그림은 레일 폭에 들어가지 않는다.
 *
 * 카드에 쓰는 활동 판정을 그대로 재사용한다(`step-activity.ts`) — 같은 step 이 레일과
 * 그래프에서 다른 상태로 읽히면 운영자는 어느 쪽을 믿을지 알 수 없다.
 */
export default function MissionStepRail({
  steps,
  graph,
  stepTimeoutMinutes,
  selectedId,
  onSelect,
  counts,
  planVersion,
  emptyHint,
}: {
  steps: OrchestrationStep[];
  graph: OrchestrationGraphSpec | null;
  stepTimeoutMinutes: number;
  selectedId: string | null;
  /** step id, 또는 null(= 미션 대화). */
  onSelect: (stepId: string | null) => void;
  counts: OrchestrationCounts;
  planVersion: number;
  /** step 이 아직 없을 때 레일에 적을 한 줄. */
  emptyHint: string;
}) {
  const depths = computeDepths(steps, graph);
  const maxDepth = steps.reduce((max, s) => Math.max(max, depths.get(s.step_key) ?? 0), 0);
  const stages: OrchestrationStep[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const s of steps) stages[depths.get(s.step_key) ?? 0].push(s);
  for (const stage of stages) stage.sort((a, b) => a.position - b.position);
  const now = Date.now();

  return (
    <div
      data-testid="mission-step-rail"
      style={{
        width: 288,
        flexShrink: 0,
        borderRight: `1px solid ${tokens.colors.border}`,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 0,
      }}
    >
      <div style={{ padding: 8, borderBottom: `1px solid ${tokens.colors.border}` }}>
        <RailRow
          selected={selectedId === null}
          onClick={() => onSelect(null)}
          accent={tokens.colors.accentLight}
          testId="rail-mission-row"
        >
          <div style={{ fontSize: 12.5, fontWeight: 600, color: tokens.colors.textPrimary }}>Mission conversation</div>
          <div style={{ marginTop: 2, fontSize: 10.5, color: tokens.colors.textMuted }}>
            orchestrator · plan v{planVersion} · {counts.done}/{counts.total} done
          </div>
        </RailRow>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 8 }}>
        {steps.length === 0 ? (
          <div style={{ fontSize: 11.5, color: tokens.colors.textMuted, lineHeight: 1.7, padding: '4px 2px' }}>
            {emptyHint}
          </div>
        ) : (
          stages.map((stage, index) => (
            <div key={index} style={{ marginBottom: 10 }}>
              <div
                style={{
                  fontSize: 9.5,
                  fontWeight: 700,
                  letterSpacing: '0.06em',
                  textTransform: 'uppercase',
                  color: tokens.colors.textMuted,
                  padding: '2px 2px 5px',
                }}
              >
                {index === 0 ? 'Stage 1 · starts immediately' : `Stage ${index + 1}`}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {stage.map((step) => (
                  <StepRailRow
                    key={step.id}
                    step={step}
                    now={now}
                    stepTimeoutMinutes={stepTimeoutMinutes}
                    selected={step.id === selectedId}
                    // 같은 행을 다시 누르면 선택이 풀린다 — 이 레일에서 미션 대화로
                    // 돌아가는 가장 짧은 동작이고, 맨 위 Mission 행과 같은 결과다.
                    onClick={() => onSelect(step.id === selectedId ? null : step.id)}
                  />
                ))}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function StepRailRow({
  step,
  now,
  stepTimeoutMinutes,
  selected,
  onClick,
}: {
  step: OrchestrationStep;
  now: number;
  stepTimeoutMinutes: number;
  selected: boolean;
  onClick: () => void;
}) {
  const style = stepStyle(step.status);
  const activity = describeStepActivity(step, now);
  const quiet = style.live ? describeStepQuiet(step, stepTimeoutMinutes, now) : null;

  return (
    <RailRow selected={selected} onClick={onClick} accent={style.color} testId="rail-step-row">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 8.5,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: style.color,
          }}
        >
          {style.label}
        </span>
        {style.live && (
          <span
            aria-hidden="true"
            style={{
              width: 5,
              height: 5,
              borderRadius: '50%',
              background: style.color,
              animation: 'awb-orch-pulse 1.4s ease-in-out infinite',
            }}
          />
        )}
        {step.attempt > 1 && (
          <span style={{ fontSize: 9, color: tokens.colors.warningLight }}>retry {step.attempt}/{step.max_attempts}</span>
        )}
        {step.status === 'awaiting_user' && (
          <span style={{ fontSize: 9, color: tokens.colors.warningLight, fontWeight: 700 }}>답변 필요</span>
        )}
        {(step.evidence_count ?? 0) > 0 && (
          <span
            data-testid="rail-evidence-badge"
            title={`검증 증거 ${step.evidence_count}개 (스크린샷·녹화)`}
            style={{ marginLeft: 'auto', fontSize: 9.5, color: tokens.colors.textMuted }}
          >
            📎 {step.evidence_count}
          </span>
        )}
      </div>

      <div
        style={{
          marginTop: 3,
          fontSize: 12,
          fontWeight: 600,
          lineHeight: 1.35,
          color: tokens.colors.textPrimary,
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
        }}
        title={step.title}
      >
        {step.title}
      </div>

      <div
        style={{
          marginTop: 2,
          fontSize: 10,
          color: tokens.colors.textMuted,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {step.assignee_name || 'unassigned'}
      </div>

      {/* 진행 중인 행만 활동을 붙인다. 끝난 step 은 상태가 이미 답이고, 레일이 조용해야
          지금 움직이는 것이 눈에 들어온다. */}
      {style.live && (
        <div
          data-testid="rail-step-activity"
          style={{
            marginTop: 4,
            fontSize: 10,
            lineHeight: 1.4,
            color: activity.stalled ? tokens.colors.warningLight : tokens.colors.textSecondary,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={activity.text ?? undefined}
        >
          {compactActivityLabel(activity)}
        </div>
      )}
      {quiet && (
        <div
          style={{
            marginTop: 1,
            fontSize: 9.5,
            color: quiet.overdue ? tokens.colors.dangerLight : tokens.colors.textMuted,
          }}
        >
          {quiet.label}
        </div>
      )}
    </RailRow>
  );
}

function RailRow({
  selected,
  onClick,
  accent,
  testId,
  children,
}: {
  selected: boolean;
  onClick: () => void;
  accent: string;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-current={selected ? 'true' : undefined}
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '7px 9px',
        borderRadius: 8,
        border: `1px solid ${selected ? tokens.colors.accent : 'transparent'}`,
        borderLeft: `3px solid ${accent}`,
        background: selected ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {children}
    </button>
  );
}
