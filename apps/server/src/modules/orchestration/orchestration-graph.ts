/**
 * GraphSpec — mission별 실행 그래프의 버전된 스키마 + 순수 실행 판정 로직.
 *
 * `orchestration.constants.ts`와 같은 이유로 의존성이 전혀 없다: runner service와
 * MCP tool layer가 같은 규칙으로 그래프를 검증하고, DB 없이 단위 테스트할 수 있어야
 * 한다.
 *
 * ── 기존 wave/DAG 모델과의 관계 ──────────────────────────────────────────────
 * 기존 모델은 이미 DAG다 — `OrchestrationStep.depends_on`(형제 step_key 배열)과
 * `validatePlan()`의 Kahn 비순환 검증. 없던 것은 edge라는 **1급 개념**이다:
 * depends_on은 무타입·무조건 의존성이라 조건 분기도, join policy도, loop 재진입도
 * 표현할 자리가 없다.
 *
 * GraphSpec은 그 depends_on을 **전치(transpose)** 해서 forward edge로 만든다:
 *   depends_on: { c: ['a','b'] }  ≡  edges: [a→c, b→c] + node c의 join='all'
 * 이 변환이 무손실이라는 점이 wave adapter의 전부다(`graphFromWavePlan`) — 그래서
 * 기존 미션은 GraphSpec으로 승격해도 `computePlanProgress`와 **완전히 동일한**
 * ready/blocked 판정을 받는다(회귀 테스트가 이 동치성을 직접 단언한다).
 *
 * ── loop를 안전하게 만드는 두 규칙 ──────────────────────────────────────────
 * 1. `loop_back` edge를 제거한 그래프는 반드시 DAG여야 한다. 즉 순환은 **오직**
 *    명시적으로 loop_back이라고 선언된 edge를 통해서만 생길 수 있다. 실수로 만든
 *    순환은 여전히 validation에서 거부된다.
 * 2. loop_back edge는 종료 조건(`when`)과 유한한 반복 상한(대상 node의
 *    `max_visits` ≥ 2)이 **둘 다** 있어야 한다. 그리고 loop가 하나라도 있으면
 *    mission 전체 `max_total_visits`(global budget)가 필수다. 이 셋 중 하나라도
 *    없으면 그래프는 실행되기 전에 거부된다 — 티켓 수용 기준의
 *    "loop는 명시적 종료 조건과 hard iteration/budget cap 없이는 validation에서
 *    거부된다"가 이 규칙이다.
 */

import { DEPENDENCY_SATISFYING_STATUSES, STEP_KEY_PATTERN, computePlanProgress } from './orchestration.constants';

// ── 버전 ─────────────────────────────────────────────────────────────────────

/** GraphSpec 스키마 버전. 저장된 spec은 이 값으로 마이그레이션 가능 여부를 판정한다. */
export const GRAPH_SPEC_VERSION = 1;

// ── 어휘 ─────────────────────────────────────────────────────────────────────

export const GRAPH_NODE_KINDS = ['task', 'evaluator', 'router'] as const;
export type GraphNodeKind = (typeof GRAPH_NODE_KINDS)[number];

/**
 * - `sequence`   — 무조건 의존성. depends_on과 정확히 같은 의미(기본값).
 * - `conditional`— `when`이 맞을 때만 만족되는 분기 edge.
 * - `loop_back`  — 상류 node로 되돌아가는 재진입 edge. 유일하게 순환을 만들 수 있다.
 */
export const GRAPH_EDGE_KINDS = ['sequence', 'conditional', 'loop_back'] as const;
export type GraphEdgeKind = (typeof GRAPH_EDGE_KINDS)[number];

/**
 * 들어오는 edge들을 어떻게 합칠지.
 * - `all` — 모든 incoming edge가 만족돼야 ready (fan-in / 기존 depends_on 의미).
 * - `any` — 하나라도 만족되면 ready (조건 분기 합류점에서 필요 — 어느 한쪽 분기만
 *           실행되므로 `all`이면 영원히 대기한다).
 */
export const JOIN_POLICIES = ['all', 'any'] as const;
export type JoinPolicy = (typeof JOIN_POLICIES)[number];

/** node 하나가 한 mission 안에서 실행될 수 있는 최대 횟수의 상한. */
export const MAX_NODE_VISITS_CEILING = 25;
/** mission 전체 node 실행 횟수 합의 상한(global budget). */
export const MAX_TOTAL_VISITS_CEILING = 500;
/** loop 대상 node가 선언해야 하는 최소 반복 상한 — 1이면 애초에 loop가 아니다. */
export const MIN_LOOP_MAX_VISITS = 2;

// ── 스키마 ───────────────────────────────────────────────────────────────────

/**
 * edge를 통과시킬 조건. `status`와 `verdict`가 둘 다 있으면 **둘 다** 맞아야 한다.
 * 둘 다 없으면 조건 없음(= 상류가 done/skipped면 통과)이다.
 */
export interface EdgeCondition {
  /** 상류 node의 최종 status가 이 중 하나일 때 통과. */
  status?: string[];
  /** 상류 node가 보고한 verdict가 이 중 하나일 때 통과(evaluator/router 분기). */
  verdict?: string[];
}

export interface GraphNode {
  key: string;
  kind: GraphNodeKind;
  join: JoinPolicy;
  /** 이 node가 실행될 수 있는 최대 횟수. loop 밖 node는 1. */
  max_visits: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
  when?: EdgeCondition;
  /** UI/trace에 그대로 노출되는 사람이 읽을 라벨(예: "needs revision"). */
  label?: string;
}

export interface GraphSpec {
  version: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** incoming(non-loop_back) edge가 없는 node들 — 계산된 값이며 입력받지 않는다. */
  entry: string[];
  /** outgoing edge가 전혀 없는 node들 — 계산된 값이며 입력받지 않는다. */
  terminal: string[];
  /** mission 전체 node 실행 횟수 합의 hard cap. */
  max_total_visits: number;
}

export interface GraphNodeInput {
  key: string;
  kind?: string;
  join?: string;
  max_visits?: number;
}

export interface GraphEdgeInput {
  from: string;
  to: string;
  kind?: string;
  when?: EdgeCondition;
  label?: string;
}

export interface GraphSpecInput {
  version?: number;
  nodes?: GraphNodeInput[];
  edges?: GraphEdgeInput[];
  max_total_visits?: number;
}

export interface GraphValidationError {
  error: string;
}

// ── 검증 ─────────────────────────────────────────────────────────────────────

const isPositiveInt = (v: unknown): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v > 0;

function normalizeCondition(raw: unknown): EdgeCondition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const src = raw as EdgeCondition;
  const status = Array.isArray(src.status)
    ? Array.from(new Set(src.status.map((s) => String(s ?? '').trim()).filter(Boolean)))
    : [];
  const verdict = Array.isArray(src.verdict)
    ? Array.from(new Set(src.verdict.map((s) => String(s ?? '').trim().toLowerCase()).filter(Boolean)))
    : [];
  if (status.length === 0 && verdict.length === 0) return undefined;
  const out: EdgeCondition = {};
  if (status.length) out.status = status;
  if (verdict.length) out.verdict = verdict;
  return out;
}

/** non-loop_back edge만 따라가며 `from`에서 도달 가능한 node 집합. */
function reachableVia(edges: GraphEdge[], from: string, includeLoopBack = false): Set<string> {
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    if (!includeLoopBack && e.kind === 'loop_back') continue;
    if (!adjacency.has(e.from)) adjacency.set(e.from, []);
    adjacency.get(e.from)!.push(e.to);
  }
  const seen = new Set<string>([from]);
  const stack = [from];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const next of adjacency.get(cur) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/**
 * GraphSpec을 정규화 + 검증한다.
 *
 * `nodeKeys`는 이 그래프가 참조할 수 있는 step_key 전체 집합이다(plan의 step들).
 * 그래프의 node는 **step과 1:1**이다 — 별도의 실행 단위를 만들지 않는다. 그래서
 * 그래프에서 빠진 step은 자동으로 고립 node(entry이자 terminal)로 채워지고,
 * 존재하지 않는 step을 가리키는 node/edge는 거부된다.
 */
export function validateGraphSpec(
  input: GraphSpecInput | null | undefined,
  opts: { nodeKeys: string[] },
): { spec: GraphSpec } | GraphValidationError {
  if (!input || typeof input !== 'object') return { error: 'graph must be an object' };

  const version = input.version ?? GRAPH_SPEC_VERSION;
  if (version !== GRAPH_SPEC_VERSION) {
    return {
      error: `unsupported graph version ${version} — this server implements GraphSpec v${GRAPH_SPEC_VERSION}`,
    };
  }

  const planKeys = new Set(opts.nodeKeys);
  if (planKeys.size === 0) return { error: 'graph needs at least one node' };

  // ── nodes ────────────────────────────────────────────────────────────────
  const byKey = new Map<string, GraphNode>();
  for (const raw of Array.isArray(input.nodes) ? input.nodes : []) {
    const key = String(raw?.key ?? '').trim();
    if (!STEP_KEY_PATTERN.test(key)) {
      return { error: `invalid graph node key "${raw?.key}" — must match the step_key format` };
    }
    if (!planKeys.has(key)) {
      return { error: `graph node "${key}" does not match any step in the plan` };
    }
    if (byKey.has(key)) return { error: `duplicate graph node "${key}"` };

    const kind = String(raw?.kind ?? 'task').trim() as GraphNodeKind;
    if (!(GRAPH_NODE_KINDS as readonly string[]).includes(kind)) {
      return { error: `graph node "${key}" has unknown kind "${raw?.kind}" — use one of ${GRAPH_NODE_KINDS.join(', ')}` };
    }
    const join = String(raw?.join ?? 'all').trim() as JoinPolicy;
    if (!(JOIN_POLICIES as readonly string[]).includes(join)) {
      return { error: `graph node "${key}" has unknown join policy "${raw?.join}" — use one of ${JOIN_POLICIES.join(', ')}` };
    }
    const maxVisits = raw?.max_visits ?? 1;
    if (!isPositiveInt(maxVisits) || maxVisits > MAX_NODE_VISITS_CEILING) {
      return {
        error:
          `graph node "${key}" has invalid max_visits ${raw?.max_visits} — ` +
          `must be a whole number between 1 and ${MAX_NODE_VISITS_CEILING}`,
      };
    }
    byKey.set(key, { key, kind, join, max_visits: maxVisits });
  }

  // 그래프에 빠진 step은 고립 node로 채운다 — plan의 step 전체가 항상 실행 대상이다.
  for (const key of opts.nodeKeys) {
    if (!byKey.has(key)) byKey.set(key, { key, kind: 'task', join: 'all', max_visits: 1 });
  }

  // ── edges ────────────────────────────────────────────────────────────────
  const edges: GraphEdge[] = [];
  const seenEdge = new Set<string>();
  for (const raw of Array.isArray(input.edges) ? input.edges : []) {
    const from = String(raw?.from ?? '').trim();
    const to = String(raw?.to ?? '').trim();
    if (!byKey.has(from)) return { error: `graph edge references unknown node "${raw?.from}" as its source` };
    if (!byKey.has(to)) return { error: `graph edge references unknown node "${raw?.to}" as its target` };
    if (from === to) return { error: `graph edge "${from}" → "${to}" is a self-edge — a node cannot depend on itself` };

    const kind = String(raw?.kind ?? 'sequence').trim() as GraphEdgeKind;
    if (!(GRAPH_EDGE_KINDS as readonly string[]).includes(kind)) {
      return { error: `graph edge "${from}" → "${to}" has unknown kind "${raw?.kind}" — use one of ${GRAPH_EDGE_KINDS.join(', ')}` };
    }
    const dedupe = `${from} ${to} ${kind}`;
    if (seenEdge.has(dedupe)) return { error: `duplicate graph edge "${from}" → "${to}" (${kind})` };
    seenEdge.add(dedupe);

    const when = normalizeCondition(raw?.when);
    if (kind === 'conditional' && !when) {
      return {
        error:
          `conditional edge "${from}" → "${to}" has no "when" condition — ` +
          `give it a status and/or verdict list, or make it a sequence edge`,
      };
    }
    if (kind === 'loop_back' && !when) {
      return {
        error:
          `loop_back edge "${from}" → "${to}" has no "when" condition. A loop without an explicit ` +
          `termination condition can never stop — declare when the loop should re-enter (e.g. ` +
          `{ verdict: ["revise"] }).`,
      };
    }

    const edge: GraphEdge = { from, to, kind };
    if (when) edge.when = when;
    const label = String(raw?.label ?? '').trim();
    if (label) edge.label = label.slice(0, 120);
    edges.push(edge);
  }

  // ── loop_back을 뺀 그래프는 반드시 DAG ────────────────────────────────────
  const forward = edges.filter((e) => e.kind !== 'loop_back');
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const key of byKey.keys()) {
    indegree.set(key, 0);
    dependents.set(key, []);
  }
  for (const e of forward) {
    indegree.set(e.to, (indegree.get(e.to) ?? 0) + 1);
    dependents.get(e.from)!.push(e.to);
  }
  const order: string[] = [];
  const queue = Array.from(byKey.keys()).filter((k) => (indegree.get(k) ?? 0) === 0);
  while (queue.length) {
    const cur = queue.shift()!;
    order.push(cur);
    for (const next of dependents.get(cur) ?? []) {
      const remaining = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, remaining);
      if (remaining === 0) queue.push(next);
    }
  }
  if (order.length !== byKey.size) {
    const stuck = Array.from(byKey.keys()).filter((k) => !order.includes(k));
    return {
      error:
        `graph contains a cycle through non-loop_back edges involving: ${stuck.join(', ')}. ` +
        `Only edges explicitly declared kind="loop_back" may close a cycle.`,
    };
  }

  // ── loop_back edge별 규칙 ────────────────────────────────────────────────
  const loops = edges.filter((e) => e.kind === 'loop_back');
  for (const loop of loops) {
    // loop_back이 실제로 순환을 닫는지: to → ... → from 경로가 forward edge로 존재해야 한다.
    const downstream = reachableVia(edges, loop.to);
    if (!downstream.has(loop.from)) {
      return {
        error:
          `loop_back edge "${loop.from}" → "${loop.to}" does not close a loop — ` +
          `"${loop.to}" cannot reach "${loop.from}" through the graph. Use a conditional edge instead.`,
      };
    }
    const target = byKey.get(loop.to)!;
    if (target.max_visits < MIN_LOOP_MAX_VISITS) {
      return {
        error:
          `loop_back edge "${loop.from}" → "${loop.to}" needs node "${loop.to}" to declare ` +
          `max_visits >= ${MIN_LOOP_MAX_VISITS} (it is ${target.max_visits}). Without a finite iteration ` +
          `cap the loop has no hard stop.`,
      };
    }
  }

  // ── global budget ───────────────────────────────────────────────────────
  let maxTotalVisits = input.max_total_visits;
  if (maxTotalVisits === undefined || maxTotalVisits === null) {
    if (loops.length > 0) {
      return {
        error:
          `graph declares ${loops.length} loop_back edge(s) but no max_total_visits budget. ` +
          `A bounded loop needs a mission-wide hard cap on total node executions.`,
      };
    }
    maxTotalVisits = byKey.size;
  }
  if (!isPositiveInt(maxTotalVisits) || maxTotalVisits > MAX_TOTAL_VISITS_CEILING) {
    return {
      error:
        `invalid max_total_visits ${input.max_total_visits} — must be a whole number between 1 and ` +
        `${MAX_TOTAL_VISITS_CEILING}`,
    };
  }
  if (maxTotalVisits < byKey.size) {
    return {
      error:
        `max_total_visits ${maxTotalVisits} is below the ${byKey.size} node(s) in the graph — ` +
        `the mission could never run every node once`,
    };
  }

  // ── loop 본문 node에 반복 상한 전파 ──────────────────────────────────────
  // loop가 재진입하면 본문 node들이 함께 리셋된다. 본문 node가 max_visits=1이면
  // 두 번째 iteration에서 즉시 예산 초과로 죽으므로, 저자가 개별로 선언하지 않아도
  // loop 대상의 상한을 물려받게 한다.
  for (const loop of loops) {
    const cap = byKey.get(loop.to)!.max_visits;
    for (const key of loopBodyNodes(edges, loop)) {
      const node = byKey.get(key)!;
      if (node.max_visits < cap) node.max_visits = cap;
    }
  }

  // ── entry / terminal / 도달 가능성 ──────────────────────────────────────
  const hasForwardIncoming = new Set(forward.map((e) => e.to));
  const hasAnyOutgoing = new Set(edges.map((e) => e.from));
  const entry = Array.from(byKey.keys()).filter((k) => !hasForwardIncoming.has(k));
  const terminal = Array.from(byKey.keys()).filter((k) => !hasAnyOutgoing.has(k));
  if (entry.length === 0) {
    return { error: 'graph has no entry node — every node has an incoming dependency' };
  }

  const reachable = new Set<string>();
  for (const start of entry) for (const k of reachableVia(edges, start, true)) reachable.add(k);
  const orphans = Array.from(byKey.keys()).filter((k) => !reachable.has(k));
  if (orphans.length > 0) {
    return {
      error:
        `graph node(s) ${orphans.join(', ')} cannot be reached from any entry node — ` +
        `they would never run (deadlock). Connect them or remove them.`,
    };
  }

  // ── node kind별 규칙 ────────────────────────────────────────────────────
  for (const node of byKey.values()) {
    const outgoing = edges.filter((e) => e.from === node.key);
    if (node.kind === 'router') {
      if (outgoing.length < 2) {
        return {
          error:
            `router node "${node.key}" has ${outgoing.length} outgoing edge(s) — a router must choose ` +
            `between at least 2.`,
        };
      }
      const unconditional = outgoing.filter((e) => !e.when);
      if (unconditional.length > 0) {
        return {
          error:
            `router node "${node.key}" has unconditional outgoing edge(s) to ` +
            `${unconditional.map((e) => `"${e.to}"`).join(', ')} — every edge out of a router must have a ` +
            `"when" condition, otherwise the branch it picks is meaningless.`,
        };
      }
    }
    if (node.kind === 'evaluator') {
      const verdictEdges = outgoing.filter((e) => (e.when?.verdict?.length ?? 0) > 0);
      if (verdictEdges.length === 0) {
        return {
          error:
            `evaluator node "${node.key}" has no outgoing edge that branches on a verdict — ` +
            `add at least one edge with { when: { verdict: [...] } } or make it a task node.`,
        };
      }
    }
  }

  // node 순서는 위상 정렬 순서로 고정 — UI lane 렌더링과 dispatch tie-break이 결정론적이도록.
  const nodes = order.map((k) => byKey.get(k)!);

  return { spec: { version: GRAPH_SPEC_VERSION, nodes, edges, entry, terminal, max_total_visits: maxTotalVisits } };
}

/**
 * loop_back edge 하나가 재진입시킬 node 집합(= loop 본문).
 *
 * 정의: loop.to에서 forward edge로 도달 가능하면서, 동시에 loop.from에 도달할 수
 * 있는 node들. loop 밖으로 갈라져 나간 가지는 리셋 대상이 아니다 — 그 가지는 loop와
 * 무관하게 이미 확정된 결과이므로 다시 실행하면 중복 실행이 된다.
 */
export function loopBodyNodes(edges: GraphEdge[], loop: GraphEdge): string[] {
  const forwardFromTarget = reachableVia(edges, loop.to);
  // loop.from에 도달할 수 있는 node = 역방향 그래프에서 loop.from으로부터 도달 가능한 node.
  const reversed = edges
    .filter((e) => e.kind !== 'loop_back')
    .map((e) => ({ from: e.to, to: e.from, kind: e.kind } as GraphEdge));
  const canReachSource = reachableVia(reversed, loop.from);
  return Array.from(forwardFromTarget).filter((k) => canReachSource.has(k));
}

// ── 실행 판정 ────────────────────────────────────────────────────────────────

export interface GraphNodeState {
  key: string;
  status: string;
  /** 지금까지 이 node가 실행된 횟수(1-based, 미실행이면 0). */
  visit: number;
  /** 마지막으로 보고된 verdict(evaluator/router 분기용). */
  verdict?: string | null;
}

export type EdgeState = 'satisfied' | 'pending' | 'dead';

export interface EdgeEvaluation {
  edge: GraphEdge;
  state: EdgeState;
  /** 사람이 읽을 판정 근거 — 실행 trace에 그대로 기록된다. */
  reason: string;
}

const isTerminal = (status: string): boolean =>
  ['done', 'failed', 'blocked', 'skipped', 'cancelled'].includes(status);

const satisfies = (status: string): boolean =>
  (DEPENDENCY_SATISFYING_STATUSES as readonly string[]).includes(status);

/**
 * edge 하나의 상태를 판정한다.
 *
 * `when`이 없으면 기존 depends_on과 동일하게 "상류가 done/skipped면 통과"다 —
 * 이 기본값이 wave adapter의 무손실성을 만든다.
 */
export function evaluateEdge(edge: GraphEdge, source: GraphNodeState | undefined): EdgeEvaluation {
  if (!source) {
    // plan에서 사라진 node를 가리키는 edge는 만족된 것으로 본다 — computePlanProgress의
    // dangling dependency 처리와 같은 이유다(replan이 하류를 영구 고착시키면 안 된다).
    return { edge, state: 'satisfied', reason: `source node "${edge.from}" is no longer in the plan` };
  }
  if (!isTerminal(source.status)) {
    return { edge, state: 'pending', reason: `"${edge.from}" is still ${source.status}` };
  }

  const when = edge.when;
  if (!when) {
    return satisfies(source.status)
      ? { edge, state: 'satisfied', reason: `"${edge.from}" finished ${source.status}` }
      : { edge, state: 'dead', reason: `"${edge.from}" ended ${source.status}, which cannot satisfy a dependency` };
  }

  if (when.status && !when.status.includes(source.status)) {
    return {
      edge,
      state: 'dead',
      reason: `"${edge.from}" ended ${source.status}, not ${when.status.join('/')}`,
    };
  }
  if (when.verdict) {
    // verdict 분기는 상류가 정상 종료했을 때만 의미가 있다 — 실패한 evaluator의
    // verdict는 신뢰할 수 없다. when.status로 명시적으로 허용한 경우는 예외.
    if (!when.status && !satisfies(source.status)) {
      return {
        edge,
        state: 'dead',
        reason: `"${edge.from}" ended ${source.status}, so its verdict is not trusted`,
      };
    }
    const verdict = String(source.verdict ?? '').trim().toLowerCase();
    if (!verdict) {
      return { edge, state: 'dead', reason: `"${edge.from}" reported no verdict` };
    }
    if (!when.verdict.includes(verdict)) {
      return {
        edge,
        state: 'dead',
        reason: `"${edge.from}" reported verdict "${verdict}", not ${when.verdict.join('/')}`,
      };
    }
    return {
      edge,
      state: 'satisfied',
      reason: `"${edge.from}" reported verdict "${verdict}"`,
    };
  }

  return { edge, state: 'satisfied', reason: `"${edge.from}" ended ${source.status}` };
}

export interface GraphProgress {
  /** 비종료 + 모든 join 조건 충족 → 지금 디스패치 가능. */
  dispatchable: string[];
  /** 비종료 + 아직 열려 있는 incoming edge를 기다리는 중. */
  waiting: string[];
  /** 비종료지만 join 조건이 영영 충족될 수 없음 → blocked 처리 대상. */
  newlyBlocked: string[];
  inFlight: string[];
  done: string[];
  failed: string[];
  allTerminal: boolean;
  /** node별 incoming edge 판정 결과 — 실행 trace/UI가 "왜 대기 중인가"를 설명하는 근거. */
  incoming: Map<string, EdgeEvaluation[]>;
}

/**
 * 현재 node 상태 집합으로 각 node를 디스패치 가능 / 대기 / 영구 차단으로 분류한다.
 *
 * `computePlanProgress`의 그래프 버전이다. loop_back edge는 **의존성으로 세지 않는다** —
 * 재진입은 상류가 완료된 뒤에 일어나는 리셋 트리거이지, 하류가 기다릴 선행조건이
 * 아니다(세면 loop 대상이 자기 하류를 기다리는 교착이 된다).
 */
export function computeGraphProgress(spec: GraphSpec, states: GraphNodeState[]): GraphProgress {
  const byKey = new Map(states.map((s) => [s.key, s]));
  const out: GraphProgress = {
    dispatchable: [],
    waiting: [],
    newlyBlocked: [],
    inFlight: [],
    done: [],
    failed: [],
    allTerminal: true,
    incoming: new Map(),
  };

  const incomingByNode = new Map<string, GraphEdge[]>();
  for (const node of spec.nodes) incomingByNode.set(node.key, []);
  for (const edge of spec.edges) {
    if (edge.kind === 'loop_back') continue;
    incomingByNode.get(edge.to)?.push(edge);
  }

  for (const node of spec.nodes) {
    const state = byKey.get(node.key);
    const status = state?.status ?? 'pending';
    const evaluations = (incomingByNode.get(node.key) ?? []).map((e) => evaluateEdge(e, byKey.get(e.from)));
    out.incoming.set(node.key, evaluations);

    if (['dispatched', 'running'].includes(status)) {
      out.inFlight.push(node.key);
      out.allTerminal = false;
      continue;
    }
    if (status === 'done' || status === 'skipped') {
      out.done.push(node.key);
      continue;
    }
    if (status === 'failed' || status === 'blocked' || status === 'cancelled') {
      out.failed.push(node.key);
      continue;
    }

    // pending / ready
    out.allTerminal = false;
    if (evaluations.length === 0) {
      out.dispatchable.push(node.key);
      continue;
    }
    const satisfiedCount = evaluations.filter((e) => e.state === 'satisfied').length;
    const deadCount = evaluations.filter((e) => e.state === 'dead').length;
    if (node.join === 'any') {
      if (satisfiedCount > 0) out.dispatchable.push(node.key);
      else if (deadCount === evaluations.length) out.newlyBlocked.push(node.key);
      else out.waiting.push(node.key);
    } else {
      if (deadCount > 0) out.newlyBlocked.push(node.key);
      else if (satisfiedCount === evaluations.length) out.dispatchable.push(node.key);
      else out.waiting.push(node.key);
    }
  }

  return out;
}

/**
 * 방금 종료한 node에서 나가는 edge들을 판정한다. UI/trace가 "어느 분기를 왜 골랐는가"를
 * 보여줄 수 있도록, 선택된 edge와 **선택되지 않은 edge + 그 이유**를 함께 돌려준다.
 */
export function selectOutgoingEdges(
  spec: GraphSpec,
  nodeKey: string,
  state: GraphNodeState,
): { taken: EdgeEvaluation[]; notTaken: EdgeEvaluation[] } {
  const taken: EdgeEvaluation[] = [];
  const notTaken: EdgeEvaluation[] = [];
  for (const edge of spec.edges) {
    if (edge.from !== nodeKey) continue;
    const evaluation = evaluateEdge(edge, state);
    if (evaluation.state === 'satisfied') taken.push(evaluation);
    else if (evaluation.state === 'dead') notTaken.push(evaluation);
  }
  return { taken, notTaken };
}

/**
 * 방금 종료한 node에서 발화한 loop_back edge들을 돌려준다(조건이 맞은 것만).
 * 호출자는 각 loop의 본문 node를 리셋해 재진입시킨다.
 */
export function firedLoopBacks(spec: GraphSpec, nodeKey: string, state: GraphNodeState): GraphEdge[] {
  return spec.edges
    .filter((e) => e.kind === 'loop_back' && e.from === nodeKey)
    .filter((e) => evaluateEdge(e, state).state === 'satisfied');
}

// ── wave adapter ─────────────────────────────────────────────────────────────

export interface WaveStepInput {
  step_key: string;
  depends_on?: string[] | null;
}

/**
 * 기존 wave/DAG plan(`depends_on` 배열)을 GraphSpec으로 무손실 승격한다.
 *
 * `depends_on: { c: ['a','b'] }` → edges `a→c`, `b→c` (전부 sequence) + node c의
 * join='all'. 조건도 loop도 만들지 않으므로 `computeGraphProgress`의 판정은
 * `computePlanProgress`와 정확히 일치한다 — 이것이 "기존 wave mission 회귀
 * 테스트가 통과한다" 수용 기준을 만족시키는 근거다.
 */
export function graphFromWavePlan(steps: WaveStepInput[]): GraphSpec {
  const keys = steps.map((s) => String(s.step_key).trim()).filter(Boolean);
  const known = new Set(keys);
  const edges: GraphEdge[] = [];
  for (const step of steps) {
    const to = String(step.step_key).trim();
    const deps = Array.isArray(step.depends_on) ? step.depends_on : [];
    for (const raw of deps) {
      const from = String(raw ?? '').trim();
      // plan에 없는 의존성은 edge로 만들지 않는다 — computePlanProgress가 dangling
      // dependency를 "만족됨"으로 취급하는 것과 같은 결과가 된다.
      if (!from || from === to || !known.has(from)) continue;
      edges.push({ from, to, kind: 'sequence' });
    }
  }
  const validated = validateGraphSpec(
    { version: GRAPH_SPEC_VERSION, nodes: keys.map((key) => ({ key })), edges, max_total_visits: keys.length },
    { nodeKeys: keys },
  );
  if ('error' in validated) {
    // validatePlan이 이미 비순환성과 키 유효성을 보장한 뒤에만 호출되므로 도달 불가.
    throw new Error(`wave plan could not be expressed as a graph: ${validated.error}`);
  }
  return validated.spec;
}

// ── 미션 단위 판정 진입점 ────────────────────────────────────────────────────

export interface MissionStepStateView {
  step_key: string;
  status: string;
  depends_on?: string[] | null;
  visit?: number;
  verdict?: string | null;
}

/** graph/wave 두 경로가 공통으로 돌려주는 판정 결과. */
export interface MissionProgress {
  dispatchable: string[];
  waiting: string[];
  newlyBlocked: string[];
  inFlight: string[];
  done: string[];
  failed: string[];
  allTerminal: boolean;
}

/**
 * 미션의 실행 판정 — graph_spec이 있으면 그래프 규칙, 없으면 기존 depends_on 규칙.
 *
 * 이 분기는 **오직 여기에만** 존재해야 한다. runner의 pump / propagateBlocking /
 * decideWake와 mission service의 orchestrator 뷰가 서로 다른 판정을 보면
 * "디스패치는 됐는데 곧바로 blocked로 뒤집히는" 모순이나 "오케스트레이터에게는
 * 대기 중이라고 보이는데 엔진은 이미 죽은 것으로 아는" 상태가 생긴다.
 */
export function computeMissionProgress(
  graphSpec: GraphSpec | null | undefined,
  steps: MissionStepStateView[],
): MissionProgress {
  if (graphSpec) {
    const g = computeGraphProgress(
      graphSpec,
      steps.map((s) => ({ key: s.step_key, status: s.status, visit: s.visit ?? 0, verdict: s.verdict ?? '' })),
    );
    return {
      dispatchable: g.dispatchable,
      waiting: g.waiting,
      newlyBlocked: g.newlyBlocked,
      inFlight: g.inFlight,
      done: g.done,
      failed: g.failed,
      allTerminal: g.allTerminal,
    };
  }
  return computePlanProgress(
    steps.map((s) => ({ step_key: s.step_key, status: s.status, depends_on: s.depends_on ?? null })),
  );
}
