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
   * Optional hook called once per spawn_agent after `ensureCliHomeDir`
   * creates the per-agent dir. Override to copy / symlink any
   * credentials or shared state the CLI needs before it can run — most
   * commonly the operator's auth token, which the CLI looks for inside
   * its config home and which a fresh per-agent home would miss.
   *
   * Throws on real I/O failures so the caller can surface them; the
   * caller is expected to wrap in try/catch since prep failure is
   * usually non-fatal (the CLI will surface its own "not authed"
   * error on next run, which is more actionable than a manager log
   * line about a missing file).
   */
  async prepareCliHome(_cliHomeDir: string): Promise<void> {
    /* default: no preparation needed */
  }
}
