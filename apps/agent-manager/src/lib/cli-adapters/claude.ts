// Claude CLI adapter — argv/format/parse logic for `claude --print` and
// `claude --input-format stream-json --output-format stream-json`.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

  configDirEnv(): string {
    // Claude CLI honors CLAUDE_CONFIG_DIR; setting it redirects ~/.claude
    // (settings, plugins, projects, sessions) to the per-agent dir so
    // multi-tenant managers don't cross-contaminate state.
    return 'CLAUDE_CONFIG_DIR';
  }

  async prepareCliHome(cliHomeDir: string): Promise<void> {
    // Claude authenticates via .credentials.json (OAuth tokens written
    // by `claude login`). A fresh per-agent home has none, so without
    // help every spawn would exit immediately with an auth error
    // (observed: 0.6s to is_error=true, no useful work done). Symlink
    // the operator's main credentials so all managed agents share auth
    // while sessions / projects stay isolated under cli-home.
    //
    // Source resolution mirrors constants.ts: $CLAUDE_CONFIG_DIR if the
    // operator has redirected the manager's main claude home, else
    // ~/.claude. Skip silently when the source doesn't exist — the
    // operator simply hasn't `claude login`-ed yet, and claude itself
    // will then surface a clearer "not authenticated" error than a
    // missing-file warning.
    const mainHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const src = join(mainHome, '.credentials.json');
    const dst = join(cliHomeDir, '.credentials.json');

    try {
      await fsp.access(src);
    } catch {
      return;
    }

    // Replace whatever's at dst — handles re-spawn after the operator
    // re-authed (symlink target may have changed) and the legacy case
    // where a copy was left there before this hook existed.
    try {
      await fsp.unlink(dst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }
    await fsp.symlink(src, dst);
  }
}
