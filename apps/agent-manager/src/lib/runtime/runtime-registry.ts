import {
  type AgentRuntimeConfig,
  type RuntimeCapabilities,
  type RuntimeDescriptor,
  RuntimeSelectionError,
} from './runtime-types.js';

const CLI_NATIVE_MCP: RuntimeCapabilities = {
  protocol: 'stream-json',
  session: 'persistent',
  native_mcp: true,
  native_approvals: false,
  steering: true,
  cancellation: true,
  usage: 'tokens-and-cost',
  collaboration: [],
  skill_delivery: ['prompt', 'filesystem'],
};

const DESCRIPTORS = new Map<string, RuntimeDescriptor>([
  ['claude', { id: 'claude', capabilities: CLI_NATIVE_MCP }],
  ['deepseek', { id: 'deepseek', capabilities: { ...CLI_NATIVE_MCP } }],
  ['codex', {
    id: 'codex',
    capabilities: {
      protocol: 'jsonl',
      session: 'oneshot',
      native_mcp: true,
      native_approvals: false,
      steering: false,
      cancellation: true,
      usage: 'tokens',
      collaboration: [],
      skill_delivery: ['prompt', 'filesystem'],
    },
  }],
  ['antigravity', {
    id: 'antigravity',
    capabilities: {
      protocol: 'jsonl',
      session: 'oneshot',
      native_mcp: false,
      native_approvals: false,
      steering: false,
      cancellation: true,
      usage: 'none',
      collaboration: [],
      skill_delivery: ['prompt'],
    },
  }],
  ['pi', {
    id: 'pi',
    capabilities: {
      protocol: 'jsonl',
      session: 'oneshot',
      native_mcp: true,
      native_approvals: false,
      steering: false,
      cancellation: true,
      usage: 'tokens',
      collaboration: [],
      skill_delivery: ['prompt', 'filesystem'],
    },
  }],
  ['hermes', {
    id: 'hermes',
    capabilities: {
      protocol: 'acp',
      session: 'resumable',
      native_mcp: true,
      native_approvals: true,
      steering: true,
      cancellation: true,
      usage: 'tokens',
      collaboration: ['delegated', 'swarm'],
      skill_delivery: ['filesystem', 'native'],
    },
  }],
]);

export const KNOWN_RUNTIME_IDS = Object.freeze(Array.from(DESCRIPTORS.keys()));

export function getRuntimeDescriptor(runtimeId: string | null | undefined): RuntimeDescriptor {
  const normalized = String(runtimeId ?? '').trim().toLowerCase();
  if (!normalized) {
    throw new RuntimeSelectionError(
      'runtime_not_configured',
      null,
      'Agent runtime is not configured',
    );
  }
  const descriptor = DESCRIPTORS.get(normalized);
  if (!descriptor) {
    throw new RuntimeSelectionError(
      'runtime_unknown',
      normalized,
      `Unknown agent runtime: ${normalized}`,
    );
  }
  return descriptor;
}

function invalid(runtimeId: string, message: string): never {
  throw new RuntimeSelectionError('runtime_config_invalid', runtimeId, message);
}

export function validateRuntimeConfig(
  runtimeId: string,
  input: unknown,
): AgentRuntimeConfig {
  const descriptor = getRuntimeDescriptor(runtimeId);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return invalid(descriptor.id, 'Runtime configuration must be an object');
  }

  const raw = input as Record<string, unknown>;
  const strategy = raw.strategy;
  if (strategy !== 'single' && strategy !== 'delegated' && strategy !== 'swarm') {
    return invalid(descriptor.id, 'Runtime strategy must be explicitly configured');
  }
  if (
    strategy !== 'single'
    && !descriptor.capabilities.collaboration.includes(strategy)
  ) {
    return invalid(
      descriptor.id,
      `Runtime ${descriptor.id} does not support ${strategy} collaboration`,
    );
  }

  const permissionMode = raw.permission_mode;
  if (
    permissionMode !== 'strict'
    && permissionMode !== 'approve'
    && permissionMode !== 'trusted'
  ) {
    return invalid(descriptor.id, 'Runtime permission mode must be explicitly configured');
  }

  const config: AgentRuntimeConfig = {
    strategy,
    permission_mode: permissionMode,
  };

  if (raw.profile !== undefined) {
    if (typeof raw.profile !== 'string' || !raw.profile.trim()) {
      return invalid(descriptor.id, 'Runtime profile must be a non-empty string');
    }
    config.profile = raw.profile.trim();
  }

  for (const field of ['max_children', 'max_iterations'] as const) {
    const value = raw[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 1_000) {
      return invalid(descriptor.id, `${field} must be an integer between 1 and 1000`);
    }
    config[field] = Number(value);
  }

  if (raw.extra !== undefined) {
    if (!raw.extra || typeof raw.extra !== 'object' || Array.isArray(raw.extra)) {
      return invalid(descriptor.id, 'Runtime extra configuration must be an object');
    }
    config.extra = raw.extra as Record<string, unknown>;
  }

  return config;
}
