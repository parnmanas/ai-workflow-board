// CliAdapter base interface — one adapter per CLI flavor. Managers
// (SubagentManager / BaseSessionManager subclasses) hold a single adapter
// instance and consult it for everything that varies across CLIs:
//
//   - bin resolution
//   - argv construction (one-shot vs persistent session)
//   - stdin turn formatting (persistent only)
//   - stdout line parsing (turn-progress + completion signals)
//   - one-shot result aggregation (so non-MCP CLIs can post their answer
//     back to AWB through the manager's REST connection)

import type { ChildProcess, StdioOptions } from 'node:child_process';

export const ADAPTER_CAPABILITIES = Object.freeze({
  /** Bidirectional stream-json over stdin/stdout, multi-turn over one process. */
  PERSISTENT_SESSION: 'persistent_session' as const,
  /** The spawned CLI itself can call AWB MCP tools (claude). When false, the
   *  manager collects the CLI's stdout via collectOneshotResult() and posts the
   *  answer to AWB on the adapter's behalf. */
  NATIVE_MCP: 'native_mcp' as const,
});

export type AdapterCapability =
  (typeof ADAPTER_CAPABILITIES)[keyof typeof ADAPTER_CAPABILITIES];

export const PARSE_STAGE = Object.freeze({
  THINKING: 'thinking' as const,
  COMPOSING: 'composing' as const,
});

export type ParseStage = (typeof PARSE_STAGE)[keyof typeof PARSE_STAGE];

export interface OneshotSpec {
  rolePrompt: string;
  taskText: string;
  mcpConfigPath: string | null;
}

export interface SessionSpec {
  rolePrompt: string;
  mcpConfigPath: string | null;
}

export interface SpawnDescriptor {
  args: string[];
  stdio: StdioOptions;
  shell?: boolean;
  writePrompt?: (child: ChildProcess) => void;
  needsMcpConfig?: boolean;
}

export interface ParseResult {
  stage: ParseStage | null;
  isResult: boolean;
  isError: boolean;
  raw: any;
}

export abstract class CliAdapter {
  static cliType = 'base';

  capabilities: Set<AdapterCapability> = new Set();

  has(cap: AdapterCapability): boolean {
    return this.capabilities.has(cap);
  }

  get cliType(): string {
    return (this.constructor as typeof CliAdapter).cliType;
  }

  abstract resolveBin(configured?: string | null): string;

  abstract buildOneshotSpawn(spec: OneshotSpec): SpawnDescriptor;

  buildSessionSpawn(_spec: SessionSpec): SpawnDescriptor {
    throw new Error(`${this.cliType}: buildSessionSpawn not implemented`);
  }

  formatTurn(_text: string): string {
    throw new Error(`${this.cliType}: formatTurn not implemented`);
  }

  abstract parseStdoutLine(line: string): ParseResult;

  collectOneshotResult(_lines: string[]): string | null {
    return null;
  }

  /**
   * Env-var name the underlying CLI consults to override its config home
   * directory. Manager uses this to point each managed agent at its own
   * `<MANAGER_HOME>/agents/<id>/cli-home/` so per-agent CLI state
   * (sessions, plugins, settings) stays isolated.
   *
   * Returning `null` means "this CLI has no config-home env var" — the
   * manager skips injection and the spawn shares whatever the manager
   * process inherited (typically the operator's $HOME).
   */
  configDirEnv(): string | null {
    return null;
  }

  /**
   * Names of operator-inherited environment variables that this CLI consults
   * for authentication (typically API keys). When the spawned agent has its
   * own per-agent credential configured, the manager removes these from the
   * child env BEFORE merging the per-agent credential's extraEnv — without
   * the strip, an operator-side `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`,
   * `GEMINI_API_KEY`, `GOOGLE_API_KEY`) silently overrides the per-agent
   * `.credentials.json` / `auth.json` / `oauth_creds.json` file the adapter
   * just wrote into the per-agent cli-home, defeating the whole point of
   * per-agent credentials.
   *
   * Returning [] (default) means "no env vars to strip" — used by adapters
   * that do not have a known operator-inherited auth env var.
   */
  authEnvKeys(): string[] {
    return [];
  }

  /**
   * Optional hook called once per spawn_agent after `ensureCliHomeDir`
   * creates the per-agent dir. Override to copy / symlink any
   * credentials or shared state the CLI needs before it can run — most
   * commonly the operator's auth token, which the CLI looks for inside
   * its config home and which a fresh per-agent home would miss.
   *
   * When the agent has its own per-agent credential configured (the
   * caller passes `credential` non-null), the adapter is expected to:
   *   - subscription kind → write the credential file(s) verbatim into
   *     cli-home and SKIP the operator-HOME symlink for any auth file
   *     it just wrote (otherwise the next call would clobber the
   *     per-agent value with the operator's).
   *   - api_key kind → return the matching `extraEnv` (ANTHROPIC_API_KEY,
   *     OPENAI_API_KEY, GEMINI_API_KEY) and remove any stale auth
   *     credential file that might still be symlinked from the operator
   *     HOME so the env var unambiguously decides auth.
   *
   * Returns extra environment variables to inject on every spawn for
   * this agent (api_key kind contributes; subscription kind returns {}).
   * Caller stores them in ManagedAgentContext.extra_env so both
   * subagents (one-shot) and persistent sessions pick them up.
   *
   * Throws on real I/O failures so the caller can surface them; the
   * caller is expected to wrap in try/catch since prep failure is
   * usually non-fatal (the CLI will surface its own "not authed"
   * error on next run, which is more actionable than a manager log
   * line about a missing file).
   */
  async prepareCliHome(
    _cliHomeDir: string,
    _credential?: AdapterCredential | null,
  ): Promise<{ extraEnv: Record<string, string> }> {
    return { extraEnv: {} };
  }
}

/** Decrypted per-agent credential payload as it reaches the adapter. The
 *  manager has already validated AWB ownership; the adapter only checks the
 *  provider prefix matches its CLI before applying. */
export interface AdapterCredential {
  credential_id: string;
  provider: string;
  fields: Record<string, string>;
}
