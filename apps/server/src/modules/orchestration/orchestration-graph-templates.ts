/**
 * Graph template 라이브러리 (티켓 2fc8f99a).
 *
 * 자주 쓰는 그래프 형태를 이름 하나로 펼친다. 손으로 GraphSpec을 쓰는 것과
 * **완전히 같은 결과**를 만들 뿐이다 — 템플릿 전용 실행 규칙은 없고, 펼친 결과는
 * `validateGraphSpec`을 그대로 통과해야 한다. 즉 템플릿은 저작 편의이지 새로운
 * 실행 개념이 아니다.
 *
 * 왜 필요한가: 검토 루프 하나를 손으로 쓰려면 `loop_back` edge + `when` 종료 조건 +
 * 대상 node의 `max_visits >= 2` + 미션 단위 `max_total_visits`를 **전부** 맞춰야
 * validation을 통과한다. 이 네 가지 중 하나만 빠져도 거부되는데, 그 조합이 곧
 * "검토 루프"라는 하나의 형태다. 템플릿은 그 형태를 한 번만 정확히 적어두고 재사용한다.
 *
 * node는 step과 1:1이므로 템플릿도 **이미 존재하는 step_key만** 엮는다 — step을
 * 만들어내지 않는다. 템플릿이 언급하지 않은 step은 `validateGraphSpec`이 고립 node로
 * 채운다(기존 동작 그대로).
 */

import {
  GraphEdgeInput,
  GraphNodeInput,
  GraphSpec,
  GraphSpecInput,
  GraphValidationError,
  GRAPH_SPEC_VERSION,
  MAX_NODE_VISITS_CEILING,
  MAX_TOTAL_VISITS_CEILING,
  MIN_LOOP_MAX_VISITS,
  validateGraphSpec,
} from './orchestration-graph';

export interface GraphTemplateParam {
  name: string;
  type: 'string' | 'string[]' | 'number';
  required: boolean;
  description: string;
}

export interface GraphTemplateInfo {
  name: string;
  summary: string;
  /** 어떤 상황에서 이 형태를 고르는지 — 오케스트레이터가 읽고 판단하는 근거. */
  when_to_use: string;
  params: GraphTemplateParam[];
  example: Record<string, unknown>;
}

interface GraphTemplateDefinition extends GraphTemplateInfo {
  build(params: Record<string, unknown>): GraphSpecInput | GraphValidationError;
}

// ── 파라미터 읽기 헬퍼 ───────────────────────────────────────────────────────

const isError = (v: unknown): v is GraphValidationError =>
  !!v && typeof v === 'object' && 'error' in (v as object);

function readKey(params: Record<string, unknown>, name: string, template: string): string | GraphValidationError {
  const raw = params?.[name];
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { error: `graph template "${template}" needs a "${name}" step_key` };
  return value;
}

function readKeyList(
  params: Record<string, unknown>,
  name: string,
  template: string,
  minimum: number,
): string[] | GraphValidationError {
  const raw = params?.[name];
  if (!Array.isArray(raw)) {
    return { error: `graph template "${template}" needs "${name}" as an array of step_keys` };
  }
  const keys = raw.map((k) => (typeof k === 'string' ? k.trim() : '')).filter(Boolean);
  if (keys.length < minimum) {
    return { error: `graph template "${template}" needs at least ${minimum} step_key(s) in "${name}"` };
  }
  const seen = new Set<string>();
  for (const key of keys) {
    if (seen.has(key)) {
      return { error: `graph template "${template}" lists "${key}" twice in "${name}" — each step appears once` };
    }
    seen.add(key);
  }
  return keys;
}

function readCount(
  params: Record<string, unknown>,
  name: string,
  template: string,
  min: number,
  max: number,
): number | GraphValidationError {
  const raw = params?.[name];
  if (raw === undefined || raw === null) {
    return { error: `graph template "${template}" needs "${name}"` };
  }
  const value = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    return { error: `graph template "${template}": "${name}" must be a whole number between ${min} and ${max}` };
  }
  return value;
}

const readVerdict = (params: Record<string, unknown>, name: string, fallback: string): string => {
  const raw = params?.[name];
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return value || fallback;
};

/**
 * loop가 있는 템플릿의 기본 예산. loop 본문 node가 `passes`번까지 돌 수 있으므로
 * "모든 node 1회 + 본문 node의 추가 반복분"을 잡는다. 호출자가 `max_total_visits`를
 * 명시하면 그 값이 이긴다.
 */
const loopBudget = (nodeCount: number, loopBodySize: number, passes: number): number =>
  Math.min(MAX_TOTAL_VISITS_CEILING, nodeCount + loopBodySize * (passes - 1));

// ── 템플릿 정의 ──────────────────────────────────────────────────────────────

const TEMPLATES: GraphTemplateDefinition[] = [
  {
    name: 'linear',
    summary: '주어진 순서대로 한 번에 하나씩 실행하는 사슬.',
    when_to_use:
      '각 단계가 앞 단계의 결과물 위에서만 의미가 있어 병렬로 돌릴 수 없을 때. 조건 분기도 반복도 없다.',
    params: [
      {
        name: 'steps',
        type: 'string[]',
        required: true,
        description: '실행 순서대로 나열한 step_key 2개 이상. steps[i] 가 끝나야 steps[i+1] 이 시작한다.',
      },
    ],
    example: { steps: ['research', 'draft', 'publish'] },
    build(params) {
      const steps = readKeyList(params, 'steps', 'linear', 2);
      if (isError(steps)) return steps;
      const edges: GraphEdgeInput[] = [];
      for (let i = 0; i + 1 < steps.length; i += 1) {
        edges.push({ from: steps[i], to: steps[i + 1], kind: 'sequence' });
      }
      return { version: GRAPH_SPEC_VERSION, nodes: steps.map((key) => ({ key })), edges };
    },
  },

  {
    name: 'review_loop',
    summary: '작업 → 검토 → (수정이 필요하면) 작업으로 되돌리는 상한 있는 루프.',
    when_to_use:
      '산출물이 기준을 만족할 때까지 다듬어야 하고, 그 판정을 사람이 아니라 검토 step 이 verdict 로 내릴 때. ' +
      '`max_passes` 가 hard cap 이라 무한히 돌지 않는다.',
    params: [
      { name: 'work', type: 'string', required: true, description: '산출물을 만드는 step_key.' },
      {
        name: 'review',
        type: 'string',
        required: true,
        description: 'work 를 판정하는 step_key. evaluator node 가 되며 verdict 를 보고해야 한다.',
      },
      {
        name: 'max_passes',
        type: 'number',
        required: true,
        description: `work 가 실행될 수 있는 최대 횟수(최초 1회 + 재작업). ${MIN_LOOP_MAX_VISITS} 이상.`,
      },
      {
        name: 'on_pass',
        type: 'string',
        required: false,
        description: '검토를 통과했을 때 이어질 step_key. 생략하면 검토 통과가 곧 이 갈래의 끝이다.',
      },
      {
        name: 'pass_verdict',
        type: 'string',
        required: false,
        description: '통과를 뜻하는 verdict 문자열(기본 "pass").',
      },
      {
        name: 'revise_verdict',
        type: 'string',
        required: false,
        description: '재작업을 뜻하는 verdict 문자열(기본 "revise").',
      },
      {
        name: 'max_total_visits',
        type: 'number',
        required: false,
        description: '미션 전체 실행 예산을 직접 지정한다. 생략하면 반복 횟수에 맞춰 계산한다.',
      },
    ],
    example: { work: 'draft', review: 'critique', max_passes: 3, on_pass: 'publish' },
    build(params) {
      const work = readKey(params, 'work', 'review_loop');
      if (isError(work)) return work;
      const review = readKey(params, 'review', 'review_loop');
      if (isError(review)) return review;
      if (work === review) {
        return { error: 'graph template "review_loop": "work" and "review" must be different steps' };
      }
      const passes = readCount(params, 'max_passes', 'review_loop', MIN_LOOP_MAX_VISITS, MAX_NODE_VISITS_CEILING);
      if (isError(passes)) return passes;

      const onPassRaw = params?.on_pass;
      const onPass = typeof onPassRaw === 'string' ? onPassRaw.trim() : '';
      if (onPass && (onPass === work || onPass === review)) {
        return { error: 'graph template "review_loop": "on_pass" must be a different step from work/review' };
      }

      const passVerdict = readVerdict(params, 'pass_verdict', 'pass');
      const reviseVerdict = readVerdict(params, 'revise_verdict', 'revise');
      if (passVerdict === reviseVerdict) {
        return {
          error:
            'graph template "review_loop": "pass_verdict" and "revise_verdict" must differ — otherwise the ' +
            'same verdict both ends and restarts the loop',
        };
      }

      // work 와 review 가 loop 본문이므로 둘 다 반복 상한을 받는다.
      const nodes: GraphNodeInput[] = [
        { key: work, max_visits: passes },
        { key: review, kind: 'evaluator', max_visits: passes },
      ];
      const edges: GraphEdgeInput[] = [
        { from: work, to: review, kind: 'sequence' },
        {
          from: review,
          to: work,
          kind: 'loop_back',
          when: { verdict: [reviseVerdict] },
          label: 'needs revision',
        },
      ];
      if (onPass) {
        nodes.push({ key: onPass });
        edges.push({
          from: review,
          to: onPass,
          kind: 'conditional',
          when: { verdict: [passVerdict] },
          label: 'approved',
        });
      }

      const explicitBudget = params?.max_total_visits;
      const budget =
        explicitBudget === undefined || explicitBudget === null
          ? loopBudget(nodes.length, 2, passes)
          : explicitBudget;
      return { version: GRAPH_SPEC_VERSION, nodes, edges, max_total_visits: budget as number };
    },
  },

  {
    name: 'fan_out_aggregate',
    summary: '여러 갈래를 병렬로 돌리고 하나의 집계 step 에서 전부 합류시킨다.',
    when_to_use:
      '서로 독립인 작업을 동시에 진행한 뒤 결과를 한데 모아야 할 때. 집계 step 은 `join: all` 이라 ' +
      '모든 갈래가 끝나야 시작한다.',
    params: [
      {
        name: 'branches',
        type: 'string[]',
        required: true,
        description: '병렬로 실행할 step_key 2개 이상.',
      },
      {
        name: 'aggregate',
        type: 'string',
        required: true,
        description: '모든 갈래가 끝난 뒤 결과를 합치는 step_key.',
      },
      {
        name: 'source',
        type: 'string',
        required: false,
        description: '갈래들이 시작하기 전에 먼저 끝나야 하는 step_key. 생략하면 갈래들이 곧바로 시작한다.',
      },
    ],
    example: { source: 'spec', branches: ['api', 'ui', 'docs'], aggregate: 'integrate' },
    build(params) {
      const branches = readKeyList(params, 'branches', 'fan_out_aggregate', 2);
      if (isError(branches)) return branches;
      const aggregate = readKey(params, 'aggregate', 'fan_out_aggregate');
      if (isError(aggregate)) return aggregate;
      if (branches.includes(aggregate)) {
        return { error: 'graph template "fan_out_aggregate": "aggregate" cannot also be one of the branches' };
      }
      const sourceRaw = params?.source;
      const source = typeof sourceRaw === 'string' ? sourceRaw.trim() : '';
      if (source && (branches.includes(source) || source === aggregate)) {
        return {
          error: 'graph template "fan_out_aggregate": "source" must differ from the branches and the aggregate',
        };
      }

      const nodes: GraphNodeInput[] = branches.map((key) => ({ key }));
      nodes.push({ key: aggregate, join: 'all' });
      if (source) nodes.push({ key: source });

      const edges: GraphEdgeInput[] = [];
      for (const branch of branches) {
        if (source) edges.push({ from: source, to: branch, kind: 'sequence' });
        edges.push({ from: branch, to: aggregate, kind: 'sequence' });
      }
      return { version: GRAPH_SPEC_VERSION, nodes, edges };
    },
  },
];

const BY_NAME = new Map(TEMPLATES.map((t) => [t.name, t]));

/** 알려진 템플릿 이름들 — MCP 툴 스키마의 enum 과 문서가 같은 출처를 쓰도록. */
export const GRAPH_TEMPLATE_NAMES = TEMPLATES.map((t) => t.name);

/** 오케스트레이터에게 보여줄 템플릿 카탈로그(빌더 함수는 제외). */
export function listGraphTemplates(): GraphTemplateInfo[] {
  return TEMPLATES.map(({ build: _build, ...info }) => info);
}

/**
 * 템플릿을 펼쳐 검증된 GraphSpec 으로 만든다.
 *
 * 펼친 결과도 손으로 쓴 그래프와 **똑같이** `validateGraphSpec` 을 통과해야 한다 —
 * 템플릿이라고 규칙을 면제받지 않는다.
 */
export function expandGraphTemplate(
  name: string,
  params: Record<string, unknown> | null | undefined,
  opts: { nodeKeys: string[] },
): { spec: GraphSpec } | GraphValidationError {
  const template = BY_NAME.get(String(name ?? '').trim());
  if (!template) {
    return {
      error: `unknown graph template "${name}" — available templates: ${GRAPH_TEMPLATE_NAMES.join(', ')}`,
    };
  }

  const built = template.build(params ?? {});
  if (isError(built)) return built;

  // 템플릿이 가리키는 step 이 실제 plan 에 있는지 먼저 확인한다. validateGraphSpec 도
  // 잡아내지만, 템플릿 이름을 함께 실은 메시지가 원인을 훨씬 빨리 알려준다.
  const planKeys = new Set(opts.nodeKeys);
  const referenced = new Set<string>();
  for (const node of built.nodes ?? []) referenced.add(node.key);
  for (const edge of built.edges ?? []) {
    referenced.add(edge.from);
    referenced.add(edge.to);
  }
  const missing = Array.from(referenced).filter((k) => !planKeys.has(k));
  if (missing.length > 0) {
    return {
      error:
        `graph template "${template.name}" references step(s) ${missing.join(', ')} that are not in the ` +
        `plan. Submit those steps first, or point the template at existing step_keys.`,
    };
  }

  const validated = validateGraphSpec(built, { nodeKeys: opts.nodeKeys });
  if ('error' in validated) return { error: `graph template "${template.name}" produced an invalid graph: ${validated.error}` };
  return validated;
}
