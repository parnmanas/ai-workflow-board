import React from 'react';
import type { OrchestrationGraphSpec, OrchestrationGraphEdge, OrchestrationStep } from '../../types';
import { tokens } from '../../tokens';
import { stepStyle } from './status';
import { relativeTime, shortDuration } from '../../utils/time';

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
  stepTimeoutMinutes = 0,
}: {
  steps: OrchestrationStep[];
  selectedId: string | null;
  onSelect: (step: OrchestrationStep) => void;
  graph?: OrchestrationGraphSpec | null;
  /** 미션의 step 무신호 허용 시간(분). 0 = 모름 → 카드에 리퍼 시계를 그리지 않는다. */
  stepTimeoutMinutes?: number;
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
              stepTimeoutMinutes={stepTimeoutMinutes}
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
  stepTimeoutMinutes,
  selected,
  onClick,
}: {
  step: OrchestrationStep;
  graph: OrchestrationGraphSpec | null;
  stepTimeoutMinutes: number;
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

      {style.live && <LiveActivity step={step} stepTimeoutMinutes={stepTimeoutMinutes} />}

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

/** 디스패치 직후 CLI 가 뜨기까지의 유예 — 이 안의 침묵은 정상이다. */
const SPAWN_GRACE_MS = 90_000;

/**
 * 진행 중인 카드에만 붙는 "지금 실제로 무엇을 하고 있나" 블록.
 *
 * 서로 다른 **두 개의 시계**를 나란히 보여준다. 하나로 합치면 안 된다:
 *
 *   - **활동(activity)** — CLI 가 마지막으로 무엇을 건드렸는지. 매니저가 step 방에
 *     중계하는 툴 하트비트라 에이전트가 한 번도 보고하지 않아도 찍히고, 그래서 "떠서
 *     즉시 죽었는지"를 이것으로만 구분할 수 있다.
 *   - **무신호 시계(quiet)** — AWB 가 개입을 판단하는 기준은 CLI 활동이 아니라
 *     **에이전트 자신의 진행 보고**(`last_heartbeat_at`, 없으면 시작/디스패치 시각)다.
 *     따라서 활동이 방금 찍혔는데도 이 시계는 허용 시간을 향해 계속 흐를 수 있다 —
 *     그 어긋남이 2026-09-25 EmberDelve 에서 열심히 일한 step 이 100분 뒤 lease 만료로
 *     실패한 이유였고, 화면에 두 값이 같이 있어야 운영자가 그걸 예측할 수 있다.
 *
 * **침묵을 죽음으로 단정하지 않는다.** 매니저는 하트비트를 spawn 당 상한/간격으로
 * 조이므로 긴 작업은 자연히 드물어진다. 경고는 `디스패치 후 활동이 한 번도 없고`
 * 유예 시간도 지난 경우에만 띄운다 — 그건 CLI 가 아예 뜨지 못했다는 뜻이다.
 */
function LiveActivity({
  step,
  stepTimeoutMinutes,
}: {
  step: OrchestrationStep;
  stepTimeoutMinutes: number;
}) {
  const now = Date.now();
  const startedMs = msOf(step.started_at) ?? msOf(step.dispatched_at);
  const runningFor = startedMs === null ? null : now - startedMs;
  const activity = step.activity ?? null;

  // 리퍼의 기준선과 **같은 순서**로 고른다(서버: last_heartbeat_at ?? started_at ??
  // dispatched_at). 여기서 CLI 활동 시각을 섞으면 화면이 실제보다 안전해 보인다.
  const quietSince = msOf(step.last_heartbeat_at) ?? startedMs;
  const quietFor = quietSince === null ? null : now - quietSince;
  const quietMinutes = quietFor === null ? 0 : Math.floor(quietFor / 60_000);
  const showQuiet = stepTimeoutMinutes > 0 && quietMinutes >= 1;

  const stalled = !activity && runningFor !== null && runningFor > SPAWN_GRACE_MS;

  return (
    <div
      data-testid="step-activity"
      style={{
        marginTop: 7,
        padding: '5px 6px',
        borderRadius: 6,
        background: stalled ? `${tokens.colors.warningBg}40` : `${tokens.colors.border}45`,
        borderLeft: `2px solid ${stalled ? tokens.colors.warningLight : tokens.colors.infoLight}`,
      }}
    >
      {activity ? (
        <>
          <div
            style={{
              fontSize: 10.5,
              lineHeight: 1.35,
              color: tokens.colors.textSecondary,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={activity.text}
          >
            <span
              style={{ color: tokens.colors.textMuted, fontWeight: 700, marginRight: 4 }}
              title={
                activity.source === 'cli'
                  ? 'CLI 가 실제로 실행한 도구 — 에이전트의 보고와 무관하게 찍힌다'
                  : '에이전트가 직접 남긴 진행 보고'
              }
            >
              {activity.source === 'cli' ? 'CLI' : 'REPORT'}
            </span>
            {activity.text}
          </div>
          <div style={{ marginTop: 2, fontSize: 9.5, color: tokens.colors.textMuted }}>
            {relativeTime(activity.at)}
            {runningFor !== null && ` · running ${shortDuration(runningFor)}`}
          </div>
        </>
      ) : (
        <div
          style={{
            fontSize: 10,
            color: stalled ? tokens.colors.warningLight : tokens.colors.textMuted,
            lineHeight: 1.35,
          }}
          title={
            stalled
              ? '디스패치된 뒤 CLI 활동이 한 번도 없습니다 — 원격 CLI 가 뜨지 못했을 수 있습니다(Runtime Host 의 매니저 로그를 확인하세요).'
              : 'CLI 가 첫 도구를 실행하면 여기에 표시됩니다'
          }
        >
          {stalled ? '⚠ no CLI activity since dispatch' : 'waiting for the CLI to start…'}
          {runningFor !== null && ` · ${shortDuration(runningFor)}`}
        </div>
      )}
      {showQuiet && (
        <div
          style={{
            marginTop: 2,
            fontSize: 9.5,
            color: quietMinutes >= stepTimeoutMinutes ? tokens.colors.dangerLight : tokens.colors.textMuted,
          }}
          title={
            `AWB 는 에이전트의 진행 보고가 ${stepTimeoutMinutes}분간 없으면 재접속을 요청하고, ` +
            '유예 안에 답이 없으면 이 시도를 실패로 처리합니다. CLI 활동은 이 시계를 되돌리지 않습니다 — ' +
            'report_orchestration_progress 호출만 되돌립니다.'
          }
        >
          quiet {quietMinutes}m / {stepTimeoutMinutes}m to reconnect check
        </div>
      )}
    </div>
  );
}

/** ISO 문자열 → epoch ms. 빈 값/파싱 실패는 null(시계를 만들지 않는다). */
function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
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
