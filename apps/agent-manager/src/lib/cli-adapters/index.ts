// CLI adapter factory — single entry point: `createAdapter(cliType)`.

import {
  ADAPTER_CAPABILITIES,
  CliAdapter,
  PARSE_STAGE,
} from './base.js';
import {
  createRuntimeCliAdapter,
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
  validateRuntimeConfig,
} from '../runtime/runtime-registry.js';

export function createAdapter(cliType: string | null | undefined): CliAdapter {
  return createRuntimeCliAdapter(cliType);
}

export const KNOWN_ADAPTER_CLI_TYPES = KNOWN_RUNTIME_IDS;

export { CliAdapter, ADAPTER_CAPABILITIES, PARSE_STAGE };
export { ClaudeCliAdapter } from './claude.js';
export { DeepSeekCliAdapter } from './deepseek.js';
export { AntigravityCliAdapter } from './antigravity.js';
export { CodexCliAdapter } from './codex.js';
export { PiCliAdapter } from './pi.js';
export { RuntimeSelectionError } from '../runtime/runtime-types.js';
export {
  getRuntimeDescriptor,
  validateRuntimeConfig,
} from '../runtime/runtime-registry.js';
export type {
  AgentRuntimeConfig,
  RuntimeCapabilities,
  RuntimeDescriptor,
} from '../runtime/runtime-types.js';
