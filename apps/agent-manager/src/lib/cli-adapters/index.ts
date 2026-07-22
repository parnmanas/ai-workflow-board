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

export function createAdapter(cliType: string | null | undefined): CliAdapter {
  const t = String(cliType || 'claude').toLowerCase();
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
    default:
      // Other unknown types fall back to the claude adapter so the runtime
      // still boots and the user sees a sensible default.
      return new ClaudeCliAdapter();
  }
}

export const KNOWN_ADAPTER_CLI_TYPES = Object.freeze(['claude', 'deepseek', 'antigravity', 'codex', 'pi']);

export { CliAdapter, ADAPTER_CAPABILITIES, PARSE_STAGE };
export { ClaudeCliAdapter } from './claude.js';
export { DeepSeekCliAdapter } from './deepseek.js';
export { AntigravityCliAdapter } from './antigravity.js';
export { CodexCliAdapter } from './codex.js';
export { PiCliAdapter } from './pi.js';
