// Gemini CLI adapter — stateless one-shot. Gemini doesn't speak AWB's MCP
// tools, so the manager collects gemini's stdout via collectOneshotResult()
// and posts the answer back to AWB through its own REST connection.

import { resolveCliBin } from '../cli-resolver.js';
import {
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

export class GeminiCliAdapter extends CliAdapter {
  static cliType = 'gemini';

  constructor() {
    super();
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('gemini', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    return {
      args: [],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: (child) => {
        try {
          child.stdin?.write(fullPrompt);
          child.stdin?.end();
        } catch {
          /* spawn already failed; manager's error handler logs it */
        }
      },
    };
  }

  parseStdoutLine(line: string): ParseResult {
    const trimmed = String(line || '').trim();
    return {
      stage: trimmed ? PARSE_STAGE.COMPOSING : null,
      isResult: false,
      isError: false,
      raw: line,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    const text = (Array.isArray(lines) ? lines : []).join('\n');
    return text.replace(/^\s+|\s+$/g, '');
  }
}
