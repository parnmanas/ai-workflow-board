// CLI adapter factory — single entry point: `createAdapter(cliType)`.

import { ClaudeCliAdapter } from './claude.js';
import { DeepSeekCliAdapter } from './deepseek.js';
import { AntigravityCliAdapter } from './antigravity.js';
import { CodexCliAdapter } from './codex.js';
import { PiCliAdapter } from './pi.js';
import {
  ADAPTER_CAPABILITIES,
  CliAdapter,
  PARSE_STAGE,
} from './base.js';
import { RuntimeSelectionError } from '../runtime/runtime-types.js';
import {
  getRuntimeDescriptor,
  KNOWN_RUNTIME_IDS,
  validateRuntimeConfig,
} from '../runtime/runtime-registry.js';

export function createAdapter(cliType: string | null | undefined): CliAdapter {
  const t = String(cliType ?? '').trim().toLowerCase();
  if (!t) {
    throw new RuntimeSelectionError(
      'runtime_not_configured',
      null,
      'Agent runtime is not configured',
    );
  }
  switch (t) {
    case 'claude':
      return new ClaudeCliAdapter();
    case 'deepseek':
      return new DeepSeekCliAdapter();
    case 'antigravity':
      return new AntigravityCliAdapter();
    case 'codex':
      return new CodexCliAdapter();
    case 'pi':
      return new PiCliAdapter();
    case 'hermes':
      throw new RuntimeSelectionError(
        'runtime_unavailable',
        t,
        'Hermes runtime adapter is not available yet',
      );
    default:
      throw new RuntimeSelectionError(
        'runtime_unknown',
        t,
        `Unknown agent runtime: ${t}`,
      );
  }
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
