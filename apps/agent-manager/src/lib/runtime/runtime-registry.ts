import { type AgentRuntimeConfig, type RuntimeDescriptor, RuntimeSelectionError } from './runtime-types.js';
import { type HermesRuntime, type HermesRuntimeOptions } from './hermes/hermes-runtime.js';
import { createBuiltinRuntimeRegistry } from './composition/builtin-plugins.js';
import { RuntimeAdapterResolver } from './composition/runtime-adapter-resolver.js';

export const runtimePluginRegistry = createBuiltinRuntimeRegistry();
export const KNOWN_RUNTIME_IDS = runtimePluginRegistry.ids();

export type RuntimeOwner = HermesRuntime;

/** Construct protocol-owned runtimes. Traditional CLI adapters continue
 * through createAdapter(); only ACP runtimes own a long-lived process here. */
export function createRuntimeOwner(
  runtimeId: string,
  options: HermesRuntimeOptions,
): RuntimeOwner {
  return runtimePluginRegistry.createOwner(runtimeId, options) as RuntimeOwner;
}

export function getRuntimeDescriptor(runtimeId: string | null | undefined): RuntimeDescriptor {
  return runtimePluginRegistry.descriptor(runtimeId);
}

export const createRuntimeCliAdapter = (runtimeId: string | null | undefined) =>
  runtimePluginRegistry.createCliAdapter(runtimeId);

/** 실행 소유자별 adapter 캐시. application 호출자는 registry 구현을 보지 않는다. */
export const createRuntimeAdapterResolver = () =>
  new RuntimeAdapterResolver(runtimePluginRegistry);

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
