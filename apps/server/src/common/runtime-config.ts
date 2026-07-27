export type ExecutionStrategy = 'single' | 'delegated' | 'swarm';
export type RuntimePermissionMode = 'strict' | 'approve' | 'trusted';

export interface AgentRuntimeConfig {
  strategy: ExecutionStrategy;
  permission_mode: RuntimePermissionMode;
  profile?: string;
  max_children?: number;
  max_iterations?: number;
  extra?: Record<string, unknown>;
}

export type AgentRuntimeConfigErrorCode =
  | 'runtime_unknown'
  | 'runtime_config_invalid';

export class AgentRuntimeConfigError extends Error {
  readonly code: AgentRuntimeConfigErrorCode;

  constructor(code: AgentRuntimeConfigErrorCode, message: string) {
    super(message);
    this.name = 'AgentRuntimeConfigError';
    this.code = code;
  }
}

const EXECUTABLE_RUNTIMES = new Set([
  'claude',
  'deepseek',
  'codex',
  'antigravity',
  'pi',
  'hermes',
]);

const COLLABORATION = new Map<string, ReadonlySet<ExecutionStrategy>>([
  ['hermes', new Set<ExecutionStrategy>(['single', 'delegated', 'swarm'])],
]);

function invalid(message: string): never {
  throw new AgentRuntimeConfigError('runtime_config_invalid', message);
}

export function isExecutableRuntime(runtimeId: unknown): runtimeId is string {
  return typeof runtimeId === 'string'
    && EXECUTABLE_RUNTIMES.has(runtimeId.trim().toLowerCase());
}

export function validateAgentRuntimeConfig(
  runtimeId: unknown,
  input: unknown,
): AgentRuntimeConfig {
  const runtime = typeof runtimeId === 'string' ? runtimeId.trim().toLowerCase() : '';
  if (!EXECUTABLE_RUNTIMES.has(runtime)) {
    throw new AgentRuntimeConfigError(
      'runtime_unknown',
      runtime ? `Unknown executable runtime: ${runtime}` : 'Agent runtime is not configured',
    );
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid('Runtime configuration must be an object');
  }

  const raw = input as Record<string, unknown>;
  const supportedFields = new Set([
    'strategy',
    'permission_mode',
    'profile',
    'max_children',
    'max_iterations',
    'extra',
  ]);
  const unknownFields = Object.keys(raw).filter((field) => !supportedFields.has(field));
  if (unknownFields.length > 0) {
    return invalid(`Unknown runtime configuration field(s): ${unknownFields.sort().join(', ')}`);
  }

  const strategy = raw.strategy;
  if (strategy !== 'single' && strategy !== 'delegated' && strategy !== 'swarm') {
    return invalid('Runtime strategy must be explicitly configured');
  }
  const allowedStrategies = COLLABORATION.get(runtime) ?? new Set<ExecutionStrategy>(['single']);
  if (!allowedStrategies.has(strategy)) {
    return invalid(`Runtime ${runtime} does not support ${strategy} collaboration`);
  }

  const permissionMode = raw.permission_mode;
  if (
    permissionMode !== 'strict'
    && permissionMode !== 'approve'
    && permissionMode !== 'trusted'
  ) {
    return invalid('Runtime permission mode must be explicitly configured');
  }

  const config: AgentRuntimeConfig = {
    strategy,
    permission_mode: permissionMode,
  };
  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string' || !raw.profile.trim()) {
      return invalid('Runtime profile must be a non-empty string');
    }
    config.profile = raw.profile.trim();
  }
  for (const field of ['max_children', 'max_iterations'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
      return invalid(`${field} must be an integer between 1 and 1000`);
    }
    config[field] = Number(value);
  }
  if (raw.extra !== undefined) {
    if (!raw.extra || typeof raw.extra !== 'object' || Array.isArray(raw.extra)) {
      return invalid('Runtime extra configuration must be an object');
    }
    config.extra = raw.extra as Record<string, unknown>;
  }
  return config;
}
