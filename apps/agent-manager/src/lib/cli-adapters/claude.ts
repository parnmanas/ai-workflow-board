// Claude CLI adapter — argv/format/parse logic for `claude --print` and
// `claude --input-format stream-json --output-format stream-json`.

import { resolveCliBin } from '../cli-resolver.js';
import {
  ADAPTER_CAPABILITIES,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SessionSpec,
  type SpawnDescriptor,
} from './base.js';

const { PERSISTENT_SESSION, NATIVE_MCP } = ADAPTER_CAPABILITIES;

export class ClaudeCliAdapter extends CliAdapter {
  static cliType = 'claude';

  constructor() {
    super();
    this.capabilities = new Set([PERSISTENT_SESSION, NATIVE_MCP]);
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('claude', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText, mcpConfigPath }: OneshotSpec): SpawnDescriptor {
    return {
      args: [
        '--print',
        '--output-format',
        'json',
        '--mcp-config',
        mcpConfigPath ?? '',
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__awb__*',
        '--append-system-prompt',
        rolePrompt || '',
        '--dangerously-skip-permissions',
        taskText,
      ],
      stdio: ['ignore', 'pipe', 'pipe'],
      needsMcpConfig: true,
    };
  }

  buildSessionSpawn({ rolePrompt, mcpConfigPath }: SessionSpec): SpawnDescriptor {
    return {
      args: [
        '--verbose',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--mcp-config',
        mcpConfigPath ?? '',
        '--strict-mcp-config',
        '--allowedTools',
        'mcp__awb__*',
        '--append-system-prompt',
        rolePrompt || '',
        '--dangerously-skip-permissions',
      ],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: true,
    };
  }

  formatTurn(text: string): string {
    const obj = {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: String(text) }] },
    };
    return JSON.stringify(obj);
  }

  parseStdoutLine(line: string): ParseResult {
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      /* non-JSON; manager treats as null */
    }
    if (!obj) {
      return { stage: null, isResult: false, isError: false, raw: null };
    }
    return {
      stage: obj.type === 'assistant' ? PARSE_STAGE.COMPOSING : PARSE_STAGE.THINKING,
      isResult: obj.type === 'result',
      isError: obj.is_error === true,
      raw: obj,
    };
  }

  collectOneshotResult(_lines: string[]): string | null {
    return null;
  }
}
