import type { AcpPermissionRequest } from './acp/acp-types.js';
import type { RuntimeEvent } from './runtime-events.js';
import type { AgentRuntimeConfig } from './runtime-types.js';

export class CollaborationPolicyError extends Error {
  readonly code = 'runtime_collaboration_denied';
  constructor(message: string) {
    super(message);
    this.name = 'CollaborationPolicyError';
  }
}

export function isChildTool(value: {
  title?: string;
  kind?: string;
}): boolean {
  const marker = `${value.kind || ''} ${value.title || ''}`.toLowerCase();
  return /\b(delegate|delegation|subagent|sub-agent|spawn[_ -]?agent|swarm)\b/.test(marker);
}

interface ChildRequest {
  childId: string;
  title: string;
  depth: number;
  tools: string[];
  skills: string[];
}

interface SessionState {
  total: number;
  active: Map<string, ChildRequest>;
}

const CHILD_FORBIDDEN_TOOLS = new Set([
  'move_ticket',
  'move_ticket_to_board',
  'record_agreement',
  'propose_move',
  'archive_ticket',
  'unarchive_ticket',
  'run_action',
]);

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .slice(0, 100)
    : [];
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  return Number.isInteger(value)
    ? Math.min(max, Math.max(min, Number(value)))
    : fallback;
}

function requestFrom(
  value: AcpPermissionRequest['toolCall'] | Extract<RuntimeEvent, { type: 'child_started' }>,
): ChildRequest {
  const record = value as unknown as Record<string, unknown>;
  const raw = objectValue(record.input ?? record.rawInput ?? record.raw_input);
  return {
    childId: String(record.toolCallId ?? record.childRunId ?? ''),
    title: String(value.title || '').slice(0, 240),
    depth: integer(raw.depth ?? raw.child_depth, 1, 1, 100),
    tools: strings(raw.tools ?? raw.allowed_tools),
    skills: strings(raw.skills ?? raw.skill_ids),
  };
}

function configuredSet(extra: Record<string, unknown>, key: string): Set<string> {
  return new Set(strings(extra[key]));
}

export class CollaborationGovernor {
  readonly #sessions = new Map<string, SessionState>();

  assertStrategy(config: AgentRuntimeConfig, hostHealthy: boolean): void {
    if (config.strategy === 'swarm' && !hostHealthy) {
      throw new CollaborationPolicyError(
        'Swarm requires a healthy Hermes ACP capability probe',
      );
    }
    const configuredTools = strings(config.extra?.allowed_child_tools);
    const forbidden = configuredTools.find((tool) => CHILD_FORBIDDEN_TOOLS.has(tool));
    if (forbidden) {
      throw new CollaborationPolicyError(
        `Child tool ${forbidden} can perform a terminal or consensus action`,
      );
    }
  }

  reservePermission(
    sessionKey: string,
    config: AgentRuntimeConfig,
    request: AcpPermissionRequest,
    hostHealthy: boolean,
  ): ChildRequest | null {
    if (!isChildTool(request.toolCall)) return null;
    return this.#reserve(
      sessionKey,
      config,
      requestFrom(request.toolCall),
      hostHealthy,
    );
  }

  observeStarted(
    sessionKey: string,
    config: AgentRuntimeConfig,
    event: Extract<RuntimeEvent, { type: 'child_started' }>,
    hostHealthy: boolean,
  ): ChildRequest {
    return this.#reserve(sessionKey, config, requestFrom(event), hostHealthy);
  }

  finish(
    sessionKey: string,
    childId: string,
  ): void {
    this.#sessions.get(sessionKey)?.active.delete(childId);
  }

  clear(sessionKey: string): void {
    this.#sessions.delete(sessionKey);
  }

  #reserve(
    sessionKey: string,
    config: AgentRuntimeConfig,
    request: ChildRequest,
    hostHealthy: boolean,
  ): ChildRequest {
    if (config.strategy === 'single') {
      throw new CollaborationPolicyError(
        'The single strategy forbids runtime child creation',
      );
    }
    this.assertStrategy(config, hostHealthy);
    const state = this.#sessions.get(sessionKey) ?? {
      total: 0,
      active: new Map<string, ChildRequest>(),
    };
    const duplicate = state.active.get(request.childId);
    if (duplicate) return duplicate;

    const extra = config.extra ?? {};
    const maxChildren = config.max_children ?? 3;
    const maxIterations = config.max_iterations ?? maxChildren;
    const maxConcurrency = integer(
      extra.max_concurrency,
      Math.min(maxChildren, 3),
      1,
      maxChildren,
    );
    const maxDepth = integer(extra.max_depth, 2, 1, 8);
    if (request.depth > maxDepth) {
      throw new CollaborationPolicyError(
        `Child depth ${request.depth} exceeds max_depth ${maxDepth}`,
      );
    }
    if (state.active.size >= maxConcurrency) {
      throw new CollaborationPolicyError(
        `Child concurrency exceeds max_concurrency ${maxConcurrency}`,
      );
    }
    if (state.total >= maxChildren) {
      throw new CollaborationPolicyError(
        `Child budget exceeds max_children ${maxChildren}`,
      );
    }
    if (state.total >= maxIterations) {
      throw new CollaborationPolicyError(
        `Delegation loop exceeds max_iterations ${maxIterations}`,
      );
    }

    const toolSubset = configuredSet(extra, 'allowed_child_tools');
    const skillSubset = configuredSet(extra, 'allowed_child_skills');
    if (request.tools.some((tool) => !toolSubset.has(tool))) {
      throw new CollaborationPolicyError(
        'Child requested a tool outside allowed_child_tools',
      );
    }
    if (request.tools.some((tool) => CHILD_FORBIDDEN_TOOLS.has(tool))) {
      throw new CollaborationPolicyError(
        'Children cannot perform terminal ticket transitions or consensus actions',
      );
    }
    if (request.skills.some((skill) => !skillSubset.has(skill))) {
      throw new CollaborationPolicyError(
        'Child requested a skill outside allowed_child_skills',
      );
    }

    state.total++;
    state.active.set(request.childId, request);
    this.#sessions.set(sessionKey, state);
    return request;
  }
}
