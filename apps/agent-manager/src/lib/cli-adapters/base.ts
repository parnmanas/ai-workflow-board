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
  /** Per-agent default model to pass to the CLI (e.g. `--model <id>`). When
   *  empty/null the adapter omits the flag and the CLI uses its own default
   *  (current behaviour). Resolved from Agent.model at spawn time. */
  model?: string | null;
}

export interface SessionSpec {
  rolePrompt: string;
  mcpConfigPath: string | null;
  /** Per-agent default model — see OneshotSpec.model. */
  model?: string | null;
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

/** Per-turn image attachment payload handed to `formatTurn`. Currently
 *  Claude is the only adapter that consumes these (stream-json image
 *  content blocks); other adapters get the list but ignore it. */
export interface TurnImage {
  media_type: string;
  /** Base64 image bytes (no `data:` URI prefix). */
  data: string;
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

  /**
   * Encode a persistent-session turn. Persistent adapters (Claude) build
   * stream-json user messages here; one-shot adapters never call this path.
   *
   * `images` is an optional array of base64 image attachments the session
   * manager wants delivered inline (chat attachment vision). Adapters that
   * support inline image content blocks include them in the turn payload;
   * others ignore the list (the session manager already pushed the
   * metadata into the prompt text via composeChatRoomPrompt).
   */
  formatTurn(_text: string, _images?: TurnImage[]): string {
    throw new Error(`${this.cliType}: formatTurn not implemented`);
  }

  abstract parseStdoutLine(line: string): ParseResult;

  collectOneshotResult(_lines: string[]): string | null {
    return null;
  }

  /**
   * Best-effort enumeration of the model ids this CLI build accepts for its
   * `--model` flag (or model env). The manager calls this once at boot and
   * ships the result to AWB via the instance heartbeat (`available_models`)
   * so the admin UI can populate a per-agent model selector from the CLI
   * actually installed on this host — not a value hardcoded in AWB.
   *
   * Contract: MUST be best-effort and MUST NOT throw. Return [] when the CLI
   * can't be enumerated; the AWB client falls back to a free-text model
   * input in that case. Default [] = "no enumeration for this CLI".
   */
  async listModels(_credential?: AdapterCredential | null): Promise<string[]> {
    return [];
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
   * Snapshot of a managed agent's CLI credential at heartbeat time —
   * just enough for the AWB admin UI to flag agents whose OAuth token is
   * about to expire. Read on every InstanceHeartbeat tick by `main.ts`'s
   * `agentCredentialMetaProvider`; never persisted on disk.
   *
   * Adapter contract: read whatever auth file the CLI keeps in
   * `cli-home` (claude → `.credentials.json`) and compute the values
   * below. Return `null` to signal "not applicable / nothing to surface"
   * (the CLI uses an env var, the adapter doesn't model expirations,
   * etc.). Errors must NOT throw — the heartbeat is best-effort.
   *
   * Importantly, the adapter NEVER returns the raw token. The fields
   * here are all derived metadata; the heartbeat ships the same shape
   * verbatim to AWB. This keeps the credential body inside the cli-home
   * dir on the manager host and out of any network traffic.
   */
  async readCredentialMeta(_cliHomeDir: string): Promise<AgentCredentialMeta | null> {
    return null;
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
    _mcp?: AdapterMcpContext | null,
    // Per-agent default model (Agent.model). Most adapters pass the model via
    // the `--model` argv flag (see buildOneshotSpawn) and ignore this. The
    // deepseek adapter — which drives the claude binary against DeepSeek's
    // backend — uses it to set ANTHROPIC_MODEL so the env and the inherited
    // `--model` flag always carry the SAME value (precedence-independent).
    _model?: string | null,
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

/** AWB MCP endpoint + per-agent apiKey, threaded into `prepareCliHome` so
 *  adapters whose CLI consumes MCP servers via a static config file (e.g.
 *  antigravity's `mcp_config.json` `mcpServers`) can persist the AWB server into
 *  the per-agent cli-home at spawn_agent time. Adapters that pass MCP
 *  config via a per-spawn flag (claude `--mcp-config`) ignore this and
 *  return early — the manager still writes its own `mcp-config.json` for
 *  those at the per-agent dir level. */
export interface AdapterMcpContext {
  /** Base AWB URL (e.g. `https://awb.example.com`); the `/mcp` suffix is
   *  appended by the adapter. */
  url: string;
  /** Per-agent apiKey (the same one written to `<agent>/apikey`) for the
   *  `Authorization: Bearer ...` header on the MCP server entry. */
  apiKey: string;
}

/**
 * Heartbeat-side credential snapshot. Produced by
 * `CliAdapter.readCredentialMeta(cliHomeDir)` once per heartbeat tick;
 * shipped to AWB via `instance-heartbeat` so the admin UI can render
 * "expires in N hours" badges without ever seeing the raw token.
 *
 * `kind`:
 *   - 'subscription' — OAuth credential file present (claude
 *     `.credentials.json` with `claudeAiOauth`); `expires_at_ms` and
 *     `refresh_token_present` are meaningful.
 *   - 'api_key' — env-var auth (`ANTHROPIC_API_KEY` etc.); no expiry
 *     concept, both fields are null/false.
 *   - 'unknown' — file present but unreadable / not in expected shape.
 *     Surface this so the UI can warn instead of silently appearing
 *     "always healthy".
 */
export interface AgentCredentialMeta {
  kind: 'subscription' | 'api_key' | 'unknown';
  /** OAuth access-token expiry (Unix milliseconds) or null when not
   *  applicable. Refreshed on every heartbeat so the value tracks the
   *  CLI's own silent-rotate of the access token. */
  expires_at_ms: number | null;
  /** True when an OAuth refresh_token is present and the access token
   *  can auto-renew. False for api_key kind (no refresh concept) and
   *  for subscription credentials missing the refresh_token field —
   *  in that second case, expiry is silent failure waiting to happen. */
  refresh_token_present: boolean;
}
