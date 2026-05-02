// Codex CLI adapter — stateless one-shot, mirrors the Gemini path.
// Like Gemini, codex doesn't speak AWB MCP tools natively, so the
// manager collects codex's stdout via collectOneshotResult() and posts
// the answer back through its own REST connection.
//
// configDirEnv returns CODEX_HOME so per-agent isolation puts codex's
// settings / auth / history under <MANAGER_HOME>/agents/<id>/cli-home/
// rather than sharing the operator's $HOME.

import { resolveCliBin } from '../cli-resolver.js';
import {
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

export class CodexCliAdapter extends CliAdapter {
  static cliType = 'codex';

  constructor() {
    super();
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('codex', configured);
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

  configDirEnv(): string {
    return 'CODEX_HOME';
  }
}
