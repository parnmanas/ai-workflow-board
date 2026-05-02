// CLI adapter factory — single entry point: `createAdapter(cliType)`.

import { ClaudeCliAdapter } from './claude.js';
import { GeminiCliAdapter } from './gemini.js';
import { CodexCliAdapter } from './codex.js';
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
    case 'gemini':
      return new GeminiCliAdapter();
    case 'codex':
      return new CodexCliAdapter();
    default:
      // Other unknown types fall back to the claude adapter so the runtime
      // still boots and the user sees a sensible default.
      return new ClaudeCliAdapter();
  }
}

export const KNOWN_ADAPTER_CLI_TYPES = Object.freeze(['claude', 'gemini', 'codex']);

export { CliAdapter, ADAPTER_CAPABILITIES, PARSE_STAGE };
export { ClaudeCliAdapter } from './claude.js';
export { GeminiCliAdapter } from './gemini.js';
export { CodexCliAdapter } from './codex.js';
