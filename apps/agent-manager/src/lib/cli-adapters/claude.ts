// Claude CLI adapter — argv/format/parse logic for `claude --print` and
// `claude --input-format stream-json --output-format stream-json`.

import { promises as fsp } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  ADAPTER_CAPABILITIES,
  type AdapterCredential,
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

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Always start from a clean slate so a switch between
    // operator-default → subscription → api_key takes effect on the
    // next spawn (the previous mode's file would otherwise win).
    const dst = join(cliHomeDir, '.credentials.json');
    try {
      await fsp.unlink(dst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (credential && credential.provider === 'claude_subscription') {
      // Operator pasted the literal `.credentials.json` content into the
      // AWB UI; replay it verbatim. Mode 0600 because OAuth tokens are
      // bearer credentials at rest.
      const body = credential.fields?.credentials_json ?? '';
      if (body) {
        await fsp.writeFile(dst, body, { mode: 0o600 });
      }
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'claude_api_key') {
      // ANTHROPIC_API_KEY overrides the credentials.json path inside the
      // claude CLI; skipping the operator-HOME symlink keeps the env-var
      // path unambiguous so an operator-side `claude login` change can't
      // accidentally take precedence.
      const apiKey = credential.fields?.api_key ?? '';
      return { extraEnv: apiKey ? { ANTHROPIC_API_KEY: apiKey } : {} };
    }

    // No per-agent credential — fall back to the operator's main HOME
    // (legacy behaviour). Source resolution mirrors constants.ts:
    // $CLAUDE_CONFIG_DIR if the operator has redirected the manager's
    // main claude home, else ~/.claude. Skip silently when the source
    // doesn't exist — the operator simply hasn't `claude login`-ed yet,
    // and claude itself will surface a clearer "not authenticated" error.
    const mainHome = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
    const src = join(mainHome, '.credentials.json');
    try {
      await fsp.access(src);
    } catch {
      return { extraEnv: {} };
    }
    try {
      await fsp.symlink(src, dst);
    } catch (err: any) {
      // Windows CreateSymbolicLink requires admin or Developer Mode;
      // without that privilege fs.symlink fails with EPERM. Fall back
      // to a plain copy — this hook reruns on every spawn, so the
      // operator's next `claude login` propagates on the next restart.
      if (err?.code === 'EPERM' || err?.code === 'EACCES') {
        await fsp.copyFile(src, dst);
      } else {
        throw err;
      }
    }
    return { extraEnv: {} };
  }
}
