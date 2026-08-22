import React from 'react';
import type { OrchestrationStep } from '../../types';
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
 */

export function computeDepths(steps: OrchestrationStep[]): Map<string, number> {
  const byKey = new Map(steps.map((s) => [s.step_key, s]));
  const depth = new Map<string, number>();

  const resolve = (key: string, seen: Set<string>): number => {
    if (depth.has(key)) return depth.get(key)!;
    // Cycles are rejected server-side at plan submission, but a stale row from
    // an older plan version could still produce one — degrade to depth 0
    // instead of recursing forever.
    if (seen.has(key)) return 0;
    seen.add(key);
    const step = byKey.get(key);
    const deps = step?.depends_on ?? [];
    const d = deps.length === 0 ? 0 : Math.max(...deps.map((k) => (byKey.has(k) ? resolve(k, seen) + 1 : 0)));
    depth.set(key, d);
    return d;
  };

  for (const s of steps) resolve(s.step_key, new Set());
  return depth;
}

export default function PlanGraph({
  steps,
  selectedId,
  onSelect,
}: {
  steps: OrchestrationStep[];
  selectedId: string | null;
  onSelect: (step: OrchestrationStep) => void;
}) {
  const depths = computeDepths(steps);
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
            {index === 0 ? 'Wave 1 · starts immediately' : `Wave ${index + 1} · after wave ${index}`}
          </div>
          {col.map((step) => (
            <StepCard
              key={step.id}
              step={step}
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
  selected,
  onClick,
}: {
  step: OrchestrationStep;
  selected: boolean;
  onClick: () => void;
}) {
  const style = stepStyle(step.status);
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

      {step.depends_on.length > 0 && (
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
      )}

      {step.finished_at && (
        <div style={{ marginTop: 6, fontSize: 10, color: tokens.colors.textMuted }}>
          {relativeTime(step.finished_at)}
        </div>
      )}
    </button>
  );
}
