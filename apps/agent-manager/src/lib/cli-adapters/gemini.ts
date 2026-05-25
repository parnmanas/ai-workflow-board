// Gemini CLI adapter — stateless one-shot. The gemini CLI (`@google/gemini-cli`)
// is invoked in non-interactive mode (`-p` + `--yolo`) and emits stream-json
// events on stdout (`{"type":"message"|"tool_use"|"tool_result"|...}`).
// `collectOneshotResult()` walks the stream and concatenates the final
// assistant message text so the manager can post the answer back to AWB
// through its own REST connection.
//
// Per-agent isolation: the CLI honours `GEMINI_CLI_HOME` for its config
// home. When set, it creates a `.gemini/` subdirectory under that path and
// stores `settings.json`, `oauth_creds.json`, history, etc. inside. The
// manager injects this env var via the base spawn site so per-agent
// sessions / plugins / settings stay isolated under
// `<MANAGER_HOME>/agents/<id>/cli-home/.gemini/`.

import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { resolveCliBin } from '../cli-resolver.js';
import {
  type AdapterCredential,
  type AdapterMcpContext,
  CliAdapter,
  PARSE_STAGE,
  type OneshotSpec,
  type ParseResult,
  type SpawnDescriptor,
} from './base.js';

// Gemini's `GEMINI_CLI_HOME` value is the *user home* equivalent; the CLI
// always reads/writes under a `.gemini/` subdirectory of it (matching the
// default `~/.gemini/` layout when the env var is unset). All per-agent
// files this adapter writes therefore live under `<cliHomeDir>/.gemini/`.
const GEMINI_SUBDIR = '.gemini';

export class GeminiCliAdapter extends CliAdapter {
  static cliType = 'gemini';

  constructor() {
    super();
    // Gemini does not own persistent stream-json sessions the way claude
    // does, and the AWB-MCP path runs through its native settings.json
    // (not a `--mcp-config` flag), so we deliberately leave both
    // capability bits off — the SubagentManager handles one-shot spawns,
    // collects stdout, and posts the result via REST.
    this.capabilities = new Set();
  }

  resolveBin(configured?: string | null): string {
    return resolveCliBin('gemini', configured);
  }

  buildOneshotSpawn({ rolePrompt, taskText }: OneshotSpec): SpawnDescriptor {
    const fullPrompt = rolePrompt ? `${rolePrompt}\n\n${taskText}` : taskText || '';
    // `gemini` with no args defaults to the interactive TUI and refuses
    // piped stdin. `-p ""` (or any value) switches to non-interactive
    // headless mode; per `gemini --help`, the `-p` argument is appended
    // to stdin, so piping the full prompt through stdin keeps argv
    // bounded for long prompts. `--yolo` auto-approves every tool call
    // (the spawn already runs in a per-agent sandbox so external
    // approvals are redundant). `--skip-trust` is required for headless
    // operation — without it gemini refuses to run in any cwd that
    // hasn't been interactively trusted, and also silently downgrades
    // `--yolo` to default approval mode. `stream-json` gives us one
    // event per line for the parser instead of ANSI-decorated text.
    return {
      args: ['-p', '', '--yolo', '--skip-trust', '--output-format', 'stream-json'],
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
    // `gemini --output-format stream-json` emits one JSON object per line.
    // Common types observed:
    //   init               — session start; ignore for stage tracking
    //   message (user)     — the prompt we piped in being echoed back
    //   message (assistant)— a model reply chunk; counts as composing
    //   tool_use           — model invoked a tool
    //   tool_result        — tool returned
    //   error / done       — terminal markers
    let obj: any = null;
    try {
      obj = JSON.parse(line);
    } catch {
      const trimmed = String(line || '').trim();
      return {
        stage: trimmed ? PARSE_STAGE.COMPOSING : null,
        isResult: false,
        isError: false,
        raw: line,
      };
    }
    const t = obj?.type;
    const isAssistantMessage = t === 'message' && obj?.role === 'assistant';
    const isResult = t === 'done' || t === 'result';
    const isError = t === 'error';
    return {
      stage: isAssistantMessage ? PARSE_STAGE.COMPOSING : t ? PARSE_STAGE.THINKING : null,
      isResult,
      isError,
      raw: obj,
    };
  }

  collectOneshotResult(lines: string[]): string | null {
    // Pull the assistant's reply text out of the JSONL stream. Prefer
    // `message` events with role=assistant; fall back to any string in
    // `content` / `text` fields for compatibility with minor schema
    // variations across gemini-cli releases.
    const parts: string[] = [];
    let lastError: string | null = null;
    for (const line of Array.isArray(lines) ? lines : []) {
      let obj: any = null;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (!obj || typeof obj !== 'object') continue;
      if (obj.type === 'message' && obj.role === 'assistant') {
        const text = typeof obj.content === 'string'
          ? obj.content
          : typeof obj.text === 'string'
            ? obj.text
            : '';
        const trimmed = String(text).trim();
        if (trimmed) parts.push(trimmed);
      } else if (obj.type === 'error') {
        const msg = typeof obj.message === 'string' ? obj.message : '';
        if (msg) lastError = msg;
      }
    }
    if (parts.length > 0) return parts.join('\n\n').replace(/^\s+|\s+$/g, '');
    if (lastError) return `[gemini error] ${lastError}`;
    // Fallback for plain-text mode or unexpected output: surface raw
    // stdout so the operator can see what happened instead of silently
    // posting nothing. Strip ANSI escape sequences and gemini's startup
    // warnings ("256-color support not detected", "Ripgrep is not
    // available") so the chat reply isn't polluted by environment noise.
    const raw = (Array.isArray(lines) ? lines : [])
      .filter((l) => {
        const s = String(l || '').trim();
        if (!s) return false;
        if (s.startsWith('Warning:')) return false;
        if (s.startsWith('Ripgrep is not available')) return false;
        return true;
      })
      .join('\n')
      .replace(/\x1b\[[0-9;]*m/g, '')
      .replace(/^\s+|\s+$/g, '');
    return raw || null;
  }

  configDirEnv(): string {
    // @google/gemini-cli reads `GEMINI_CLI_HOME` (NOT `GEMINI_HOME`) for
    // its config-home override. Setting it redirects the default
    // `~/.gemini/` to a per-agent dir so settings / auth / history /
    // mcp config don't leak across managed agents on the same host.
    return 'GEMINI_CLI_HOME';
  }

  authEnvKeys(): string[] {
    // Both GEMINI_API_KEY and GOOGLE_API_KEY are honored by the gemini CLI
    // (and various Google AI SDKs) for direct-key auth; either would shadow
    // the per-agent oauth_creds.json (subscription kind) or the per-agent
    // GEMINI_API_KEY (api_key kind).
    return ['GEMINI_API_KEY', 'GOOGLE_API_KEY'];
  }

  async prepareCliHome(
    cliHomeDir: string,
    credential?: AdapterCredential | null,
    mcp?: AdapterMcpContext | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    // Gemini stores everything under `<GEMINI_CLI_HOME>/.gemini/`. Create
    // the subdir up front so subsequent writes don't ENOENT.
    const geminiDir = join(cliHomeDir, GEMINI_SUBDIR);
    await fsp.mkdir(geminiDir, { recursive: true, mode: 0o700 });

    // Persist the AWB MCP server into per-agent `settings.json` so the
    // spawned gemini child can call `mcp__awb__*` tools natively. The
    // file is merged (not overwritten) so any operator-curated settings
    // — auth.selectedType, theme, etc. — survive a manager restart.
    if (mcp?.url && mcp?.apiKey) {
      await this.#writeAwbMcpSettings(geminiDir, mcp.url, mcp.apiKey);
    }

    // Always start from a clean credential slate so credential mode
    // changes (subscription → api_key, or operator-default → either)
    // take effect on the next spawn without a leftover oauth file
    // winning.
    const oauthDst = join(geminiDir, 'oauth_creds.json');
    try {
      await fsp.unlink(oauthDst);
    } catch (err: any) {
      if (err?.code !== 'ENOENT') throw err;
    }

    if (credential && credential.provider === 'gemini_subscription') {
      const body = credential.fields?.oauth_creds_json ?? '';
      if (body) {
        await fsp.writeFile(oauthDst, body, { mode: 0o600 });
      }
      return { extraEnv: {} };
    }

    if (credential && credential.provider === 'gemini_api_key') {
      const apiKey = credential.fields?.api_key ?? '';
      // GEMINI_API_KEY is the canonical env var; some integrations also
      // honour GOOGLE_API_KEY, set both for compatibility.
      return {
        extraEnv: apiKey ? { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } : {},
      };
    }

    return { extraEnv: {} };
  }

  /** Merge an `awb` MCP server entry into `<geminiDir>/settings.json`.
   *  Keeps any other settings the operator (or a previous `gemini mcp add`)
   *  may have written so this re-run is idempotent. */
  async #writeAwbMcpSettings(
    geminiDir: string,
    awbUrl: string,
    apiKey: string,
  ): Promise<void> {
    const settingsPath = join(geminiDir, 'settings.json');
    let settings: any = {};
    try {
      const raw = await fsp.readFile(settingsPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') settings = parsed;
    } catch {
      /* missing / unparseable — start fresh */
    }
    const mcpServers = (settings.mcpServers && typeof settings.mcpServers === 'object')
      ? settings.mcpServers
      : {};
    mcpServers.awb = {
      type: 'http',
      url: `${awbUrl.replace(/\/$/, '')}/mcp`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'X-AWB-Client-Type': 'managed-subagent',
      },
      // `trust: true` skips the per-tool approval prompt — the AWB MCP
      // surface is the operator's own server, and the spawned gemini
      // already runs with --yolo so the prompt would never be answered.
      trust: true,
    };
    settings.mcpServers = mcpServers;
    await fsp.writeFile(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 });
  }
}
