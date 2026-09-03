import React from 'react';
import type { OrchestrationGraphSpec, OrchestrationGraphEdge, OrchestrationStep } from '../../types';
import { tokens } from '../../tokens';
import { stepStyle } from './status';
import { relativeTime } from '../../utils/time';

/**
 * The plan, drawn as dependency waves.
 *
 * Steps are laid out in columns by dependency DEPTH (a step's column is one
 * past the deepest step it depends on), which is exactly the order the engine
 * dispatches them in: everything in column 0 can start immediately, column 1
 * waits for column 0, and so on. Anything sharing a column is genuinely
 * parallel work — that is the single most important thing an operator wants to
 * read off this view, and a plain list cannot show it.
 *
 * Dependencies are rendered as key chips on each card rather than drawn edges.
 * Edges look better on a whiteboard, but with 10+ steps and re-planning they
 * become an unreadable tangle in a scrolling panel, and a chip is
 * click-to-focus in a way a line is not.
 *
 * 그래프 모드(티켓 1ca9e49b)에서는 depth를 `depends_on`이 아니라 GraphSpec의
 * forward edge로 계산한다 — 조건 분기는 depends_on에 나타나지 않으므로 그대로
 * 두면 분기 하류가 전부 wave 1로 접혀 보인다. loop_back edge는 depth 계산에서
 * 제외한다(정의상 상류로 돌아가므로 세면 열이 무한히 깊어진다).
 */

export function computeDepths(
  steps: OrchestrationStep[],
  graph?: OrchestrationGraphSpec | null,
): Map<string, number> {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  const depth = new Map<string, number>();

  // 그래프가 있으면 forward edge에서 역방향 인접(= 이 node가 기다리는 것들)을 만든다.
  const graphDeps = new Map<string, string[]>();
  if (graph) {
    for (const e of graph.edges) {
      if (e.kind === 'loop_back') continue;
      if (!graphDeps.has(e.to)) graphDeps.set(e.to, []);
      graphDeps.get(e.to)!.push(e.from);
    }
  }

  const resolve = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    // Cycles are rejected server-side at plan submission, but a stale row from
    // an older plan version could still produce one — degrade to depth 0
    // instead of recursing forever.
    if (seen.has(key)) return 0;
    seen.add(key);
    const deps = graph ? graphDeps.get(key) ?? [] : byKey.get(key)?.depends_on ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((k) => (byKey.has(k) ? resolve(k, seen) + 1 : 0)));
    depth.set(key, d);
    return d;
  };

  for (const s of steps) resolve(s.step_key, new Set());
  return depth;
}

/** edge 조건을 사람이 읽을 짧은 문구로. 없으면 null(무조건 edge). */
export function describeEdgeCondition(edge: OrchestrationGraphEdge): string | null {
  if (edge.label) return edge.label;
  const bits: string[] = [];
  if (edge.when?.verdict?.length) bits.push(edge.when.verdict.join(' / '));
  if (edge.when?.status?.length) bits.push(edge.when.status.join(' / '));
  return bits.length ? bits.join(' + ') : null;
}

export default function PlanGraph({
  steps,
  selectedId,
  onSelect,
  graph = null,
}: {
  steps: OrchestrationStep[];
  selectedId: string | null;
  onSelect: (step: OrchestrationStep) => void;
  graph?: OrchestrationGraphSpec | null;
}) {
  const depths = computeDepths(steps, graph);
  const maxDepth = steps.reduce((max, s) => Math.max(max, depths.get(s.step_key) ?? 0), 0);
  const columns: OrchestrationStep[][] = Array.from({ length: maxDepth + 1 }, () => []);
  for (const s of steps) columns[depths.get(s.step_key) ?? 0].push(s);
  for (const col of columns) col.sort((a, b) => a.position - b.position);

  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto', paddingBottom: 6 }}>
      {columns.map((col, index) => (
        <div key={index} style={{ minWidth: 240, flex: '0 0 240px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: tokens.colors.textMuted,
              paddingLeft: 2,
            }}
          >
            {graph
              ? index === 0
                ? 'Entry · starts immediately'
                : `Stage ${index + 1}`
              : index === 0
                ? 'Wave 1 · starts immediately'
                : `Wave ${index + 1} · after wave ${index}`}
          </div>
          {col.map((step) => (
            <StepCard
              key={step.id}
              step={step}
              graph={graph}
              selected={step.id === selectedId}
              onClick={() => onSelect(step)}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function StepCard({
  step,
  graph,
  selected,
  onClick,
}: {
  step: OrchestrationStep;
  graph: OrchestrationGraphSpec | null;
  selected: boolean;
  onClick: () => void;
}) {
  const style = stepStyle(step.status);
  const node = graph?.nodes.find((n) => n.key === step.step_key) ?? null;
  const incoming = graph ? graph.edges.filter((e) => e.to === step.step_key && e.kind !== 'loop_back') : [];
  const outgoing = graph ? graph.edges.filter((e) => e.from === step.step_key) : [];
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'block',
        width: '100%',
        textAlign: 'left',
        padding: '10px 11px',
        borderRadius: 9,
        border: `1px solid ${selected ? tokens.colors.accent : tokens.colors.border}`,
        borderLeft: `3px solid ${style.color}`,
        background: selected ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
        color: tokens.colors.textPrimary,
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            padding: '1px 6px',
            borderRadius: 999,
            fontSize: 9,
            fontWeight: 700,
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: style.color,
            background: style.background,
          }}
        >
          {style.label}
        </span>
        {style.live && (
          <span
            aria-hidden="true"
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: style.color,
              animation: 'awb-orch-pulse 1.4s ease-in-out infinite',
            }}
          />
        )}
        {step.attempt > 1 && (
          <span style={{ fontSize: 9, color: tokens.colors.warningLight }}>retry {step.attempt}/{step.max_attempts}</span>
        )}
        {node && node.kind !== 'task' && (
          <span
            data-testid="node-kind-chip"
            style={{
              fontSize: 9,
              fontWeight: 700,
              letterSpacing: '0.04em',
              textTransform: 'uppercase',
              // confirm 은 "사람이 개입해야 하는 node" 라 나머지 kind(에이전트가 실행)와
              // 다른 색을 쓴다 — 그래프만 보고 어디서 멈출지 알 수 있어야 한다.
              color: node.kind === 'confirm' ? tokens.colors.warningLight : tokens.colors.accent,
            }}
            title={
              node.kind === 'evaluator'
                ? 'Judges upstream work and reports a verdict that selects the next branch'
                : node.kind === 'confirm'
                  ? 'A person answers Pass/Fail here — the mission pauses until they do'
                  : 'Only picks a branch — every edge out of it is conditional'
            }
          >
            {node.kind === 'confirm' ? 'user confirm' : node.kind}
          </span>
        )}
        {node && node.max_visits > 1 && (
          <span
            style={{ fontSize: 9, color: tokens.colors.textMuted }}
            title={`This node may run up to ${node.max_visits} times (bounded loop)`}
          >
            pass {Math.max(step.visit, 1)}/{node.max_visits}
          </span>
        )}
      </div>

      <div style={{ marginTop: 5, fontSize: 12.5, fontWeight: 600, lineHeight: 1.35 }}>{step.title}</div>
      <div style={{ marginTop: 2, fontSize: 10, color: tokens.colors.textMuted, fontFamily: 'monospace' }}>
        {step.step_key}
      </div>

      <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: tokens.colors.textSecondary }}>
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: step.assignee_online ? tokens.colors.successLight : tokens.colors.textMuted,
            flexShrink: 0,
          }}
        />
        {step.assignee_name || 'unassigned'}
      </div>

      {step.workspace_folder && (
        <div
          style={{
            marginTop: 3,
            fontSize: 9.5,
            fontFamily: 'monospace',
            color: tokens.colors.textMuted,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={step.workspace_folder}
        >
          {step.workspace_folder}
        </div>
      )}

      {step.verdict && (
        <div style={{ marginTop: 6, fontSize: 10, color: tokens.colors.textSecondary }}>
          verdict:{' '}
          <span style={{ fontFamily: 'monospace', fontWeight: 700, color: tokens.colors.accent }}>{step.verdict}</span>
        </div>
      )}

      {graph ? (
        (incoming.length > 0 || outgoing.length > 0) && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {incoming.map((edge) => (
              <EdgeChip key={`in-${edge.from}-${edge.kind}`} edge={edge} direction="in" />
            ))}
            {outgoing.map((edge) => (
              <EdgeChip key={`out-${edge.to}-${edge.kind}`} edge={edge} direction="out" />
            ))}
          </div>
        )
      ) : (
        step.depends_on.length > 0 && (
          <div style={{ marginTop: 6, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {step.depends_on.map((key) => (
              <span
                key={key}
                style={{
                  fontSize: 9,
                  fontFamily: 'monospace',
                  padding: '1px 5px',
                  borderRadius: 4,
                  background: `${tokens.colors.border}70`,
                  color: tokens.colors.textMuted,
                }}
              >
                ← {key}
              </span>
            ))}
          </div>
        )
      )}

      {step.finished_at && (
        <div style={{ marginTop: 6, fontSize: 10, color: tokens.colors.textMuted }}>
          {relativeTime(step.finished_at)}
        </div>
      )}
    </button>
  );
}

/**
 * 하나의 edge를 칩으로. 방향(들어옴/나감)·종류·조건을 한 눈에 구분할 수 있어야
 * "이 node가 무엇을 기다리는지"와 "여기서 어디로 갈라지는지"가 카드에서 바로 읽힌다.
 */
function EdgeChip({ edge, direction }: { edge: OrchestrationGraphEdge; direction: 'in' | 'out' }) {
  const condition = describeEdgeCondition(edge);
  const color =
    edge.kind === 'loop_back'
      ? tokens.colors.warningLight
      : edge.kind === 'conditional'
        ? tokens.colors.accent
        : tokens.colors.textMuted;
  const peer = direction === 'in' ? edge.from : edge.to;
  const arrow = edge.kind === 'loop_back' ? '↺' : direction === 'in' ? '←' : '→';
  return (
    <span
      title={
        `${edge.kind} edge ${edge.from} → ${edge.to}` +
        (condition ? ` · taken when ${condition}` : ' · always taken once the source finishes')
      }
      style={{
        fontSize: 9,
        fontFamily: 'monospace',
        padding: '1px 5px',
        borderRadius: 4,
        background: `${tokens.colors.border}70`,
        border: edge.kind === 'sequence' ? 'none' : `1px solid ${color}55`,
        color,
      }}
    >
      {arrow} {peer}
      {condition ? ` · ${condition}` : ''}
    </span>
  );
}
