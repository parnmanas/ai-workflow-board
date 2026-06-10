// Antigravity CLI adapter — stateless one-shot. The Antigravity CLI (`agy`,
// Google's successor to gemini-cli) is invoked in non-interactive print mode
// (`-p`) and emits plain-text output on stdout.
// `collectOneshotResult()` concatenates stdout so the manager can post the
// answer back to AWB through its own REST connection.
//
// Per-agent isolation: the CLI stores config under `<home>/.antigravity/`.
// The manager injects a per-agent home directory via the base spawn site so
// per-agent sessions / plugins / settings stay isolated under
// `<MANAGER_HOME>/agents/<id>/cli-home/.antigravity/`.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import { resolveSelfCommand } from '../self-path.js';
import {
  type AdapterCredential,
  type AdapterMcpContext,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

// Antigravity stores its config under `<home>/.antigravity/`.
const ANTIGRAVITY_SUBDIR = '.antigravity';

export class AntigravityCliAdapter extends CliAdapter {
  static cliType = 'antigravity';

  constructor() {
    super();
    // Antigravity does not own persistent stream-json sessions the way claude
    // does, and the AWB-MCP path runs through its native mcp_config.json
    // (not a `--mcp-config` flag), so we deliberately leave both
    // capability bits off — the SubagentManager handles one-shot spawns,
    // collects stdout, and posts the result via REST.
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('agy', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText, model }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    // `agy -p "<prompt>"` runs in non-interactive print mode; the prompt
    // is passed as a positional arg after `-p`. For long prompts we pipe
    // through stdin to avoid argv limits.
    // `--dangerously-skip-permissions` auto-approves every tool call
    // (the spawn already runs in a per-agent sandbox so external
    // approvals are redundant).
    // Per-agent default model (Agent.model). `agy` gained `--model` in v1.0.5
    // (alongside an `agy models` subcommand); inject it when set so a model
    // chosen in the admin UI actually reaches the CLI. Omitted when unset so
    // antigravity keeps its own default — preserves prior behaviour, and
    // matches the claude/codex injection pattern. Antigravity is oneshot-only
    // (no persistent session), so there is no session-spawn path to mirror.
    return {
      args: ['-p', fullPrompt, ...(model ? ['--model', model] : []), '--dangerously-skip-permissions'],
      stdio: ['pipe', 'pipe', 'pipe'],
      needsMcpConfig: false,
      writePrompt: undefined,
    };
  }

  parseStdoutLine(line: string): ParseResult {
    // Antigravity's `--print` mode emits plain text, not stream-json.
    // We treat any non-empty line as composing output.
    const trimmed = String(line || '').trim();
    return {
      stage: trimmed ? PARSE_STAGE.COMPOSING : null,
      isResult: false,
      isError: false,
      raw: line,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Plain-text mode: concatenate all non-empty lines.
    const raw = (Array.isArray(lines) ? lines : [])
      .filter((l) => {
        const s = String(l || '').trim();
        if (!s) return false;
        // Strip common CLI noise / warnings
        if (s.startsWith('Warning:')) return false;
        return true;
      })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '') // Strip ANSI escape sequences
      .replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  configDirEnv(): string {
    // Antigravity uses the user's home directory as base; the CLI stores
    // its config under `<home>/.antigravity/`. We set HOME to a per-agent
    // directory so the config is isolated.
    return 'HOME';
  }

  authEnvKeys(): string[] {
    // Antigravity (like gemini-cli) honours GEMINI_API_KEY and
    // GOOGLE_API_KEY for direct-key auth. The env vars haven't changed
    // in the transition from gemini → antigravity.
    return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
    mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Antigravity stores everything under `<home>/.antigravity/`. Create
    // the subdir up front so subsequent writes don't ENOENT.
    const agyDir = join(cliHomeDir, ANTIGRAVITY_SUBDIR);
    await fsp.mkdir(agyDir, { recursive: true, mode: 0o700 });

    // Persist the AWB + host MCP servers into per-agent `mcp_config.json`
    // so the spawned antigravity child can call `mcp__awb__*` and
    // `mcp__host__*` tools natively.
    if (mcp?.url && mcp?.apiKey) {
      await this.#writeMcpConfig(agyDir, mcp.url, mcp.apiKey);
    }

    // Always start from a clean credential slate so credential mode
    // changes take effect on the next spawn without a leftover oauth
    // file winning.
    const oauthDst = join(agyDir, 'oauth_creds.json');
    try {
      await fsp.unlink(oauthDst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (credential && credential.provider === 'antigravity_subscription') {
      const body = credential.fields?.oauth_creds_json ?? '';
      if (body) {
        await fsp.writeFile(oauthDst, body, { mode: 0o600 });
      }
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'antigravity_api_key') {
      const apiKey = credential.fields?.api_key ?? '';
      // GEMINI_API_KEY is still the canonical env var for Antigravity;
      // GOOGLE_API_KEY is also honoured for compatibility.
      return {
        extraEnv: apiKey ? { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } : {},
      };
    }

    return { extraEnv: {} };
  }

  /** Write AWB + host MCP server entries into `<agyDir>/mcp_config.json`.
   *  Keeps any other servers the operator may have configured so this
   *  re-run is idempotent.
   *
   *  Two servers:
   *   - `awb` — central AWB Streamable HTTP endpoint (mcp__awb__*)
   *   - `host` — stdio MCP forked from this agent-manager binary,
   *     exposing host tools (screenshot, window, input, process, etc.)
   */
  async #writeMcpConfig(
    agyDir: string,
    awbUrl: string,
    apiKey: string,
  ): Promise<void> {
    const configPath = join(agyDir, 'mcp_config.json');
    let config: any = {};
    try {
      const raw = await fsp.readFile(configPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') config = parsed;
    } catch {
      /* missing / unparseable — start fresh */
    }
    const mcpServers = (config.mcpServers && typeof config.mcpServers === 'object')
      ? config.mcpServers
      : {};
    mcpServers.awb = {
      url: `${awbUrl.replace(/\/$/, '')}/mcp`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-AWB-Client-Type': 'managed-subagent',
      },
    };
    // Host-tools server — forked from the same agent-manager binary that
    // wrote this config so the spawned antigravity child has access to
    // screenshot / window / input / process / file / clipboard tools.
    const self = resolveSelfCommand();
    mcpServers.host = {
      command: self.command,
      args: [...self.prefixArgs, 'mcp-host'],
    };
    config.mcpServers = mcpServers;
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  }
}
