// CLI adapter factory — single entry point: `createAdapter(cliType)`.

import { ClaudeCliAdapter } from './claude.js';
import { GeminiCliAdapter } from './gemini.js';
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
    default:
      // codex and other unknown types fall back to the claude adapter so the
      // runtime still boots and the user sees a sensible default. main.ts
      // gates this earlier and warns when config.cli is unrecognized.
      return new ClaudeCliAdapter();
  }
}

export const KNOWN_ADAPTER_CLI_TYPES = Object.freeze(['claude', 'gemini']);

export { CliAdapter, ADAPTER_CAPABILITIES, PARSE_STAGE };
export { ClaudeCliAdapter } from './claude.js';
export { GeminiCliAdapter } from './gemini.js';
