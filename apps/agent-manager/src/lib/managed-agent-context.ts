// ─── Managed-agent runtime context registry (ST-6) ───────────────────
// In-memory hot path for "given an agent_id, what cwd/apiKey/mcp-config do
// I spawn its subagent under?". Filled by the spawn_agent command handler
// (which provisions / hydrates everything from disk) and read by the
// EventDispatcher when an SSE event targets a managed agent.
//
// Two things deliberately NOT here:
//   - the SubagentManager itself — there's still one manager-wide
//     SubagentManager so the concurrency cap is a single budget. Per-call
//     overrides (cwd + mcp-config + apiKey) come out of this registry.
//   - persistent claude/codex stream-json sessions. Same shape: one
//     ChatSessionManager + one TicketSessionManager, per-call overrides.
//
// Design intent: the manager process can survive a restart and rebuild
// this registry by walking <MANAGER_HOME>/agents/* — start() does exactly
// that, gated behind ManagedAgentRegistry.upsert so the existing
// "registry of state" surface (used by the heartbeat) stays the source of
// truth for status.

import type { ManagedAgentDiskConfig } from './managed-agent-store.js';

export interface ManagedAgentContext {
  agent_id: string;
  name: string;
  cli: string;
  /** Absolute path; used as cwd for subagent spawn. Empty = manager refuses. */
  working_dir: string;
  /** On-disk path to the mcp-config.json claude --mcp-config consumes. */
  mcp_config_path: string;
  /** Raw apiKey for this managed agent. In-memory cache of the disk file. */
  api_key: string;
  /** Per-agent subagent log file path (created lazily by SubagentManager). */
  subagent_log_path: string;
  /** ST-7 follow-up: per-agent CLI home dir
   *  (`<MANAGER_HOME>/agents/<id>/cli-home/`). Manager passes it via the
   *  adapter's configDirEnv() (CLAUDE_CONFIG_DIR / GEMINI_HOME / CODEX_HOME)
   *  so each managed agent's CLI sessions / plugins / settings stay
   *  isolated from siblings on the same manager host. */
  cli_home_dir: string;
  /** Extra environment variables exported on every spawn for this agent.
   *  Populated by adapter.prepareCliHome() when the agent's per-agent
   *  credential is the api_key kind (e.g. ANTHROPIC_API_KEY,
   *  OPENAI_API_KEY, GEMINI_API_KEY). Empty for subscription credentials
   *  or no credential at all. */
  extra_env?: Record<string, string>;
  /** Provider string of the per-agent credential applied at spawn (e.g.
   *  `claude_subscription`, `claude_api_key`, `codex_api_key`). null /
   *  undefined when the operator did NOT configure a per-agent credential
   *  for this agent (legacy operator-HOME fallback). Spawn sites use this
   *  to decide whether to strip operator-side auth env vars
   *  (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY)
   *  from the child env before applying the per-agent credential — without
   *  the strip, an inherited env var silently overrides the per-agent
   *  .credentials.json / auth.json / oauth_creds.json file. */
  credential_provider?: string | null;
  /** Spawn-time auth mode for this managed agent. Stamped here (rather
   *  than re-derived per heartbeat) because it's authoritative regardless
   *  of whether the OAuth file currently exists on disk:
   *    - 'subscription' — per-agent OAuth credential ('claude_subscription' /
   *      'codex_subscription' / 'antigravity_subscription'); the cli-home holds
   *      a `.credentials.json` (or equivalent) the CLI rotates in place.
   *    - 'api_key' — env-var auth (ANTHROPIC_API_KEY etc.). No expiry.
   *    - 'operator_home' — no per-agent credential set; the manager copied
   *      / symlinked the operator's HOME credential file into cli-home.
   *      Expiry monitoring still works because the on-disk file is present;
   *      the operator just sees the *operator's* token expiry, not a
   *      per-agent one.
   *  The InstanceHeartbeat consults this to short-circuit api_key agents
   *  to "no expiry" without paying a disk read each tick. */
  credential_kind?: 'subscription' | 'api_key' | 'operator_home';
  /** ISO timestamp of when this manager last hydrated the context. */
  registered_at: string;
}

export class ManagedAgentContextRegistry {
  #byId = new Map<string, ManagedAgentContext>();

  upsert(ctx: ManagedAgentContext): ManagedAgentContext {
    this.#byId.set(ctx.agent_id, ctx);
    return ctx;
  }

  get(agentId: string): ManagedAgentContext | null {
    return this.#byId.get(agentId) ?? null;
  }

  list(): ManagedAgentContext[] {
    return Array.from(this.#byId.values());
  }

  delete(agentId: string): boolean {
    return this.#byId.delete(agentId);
  }

  has(agentId: string): boolean {
    return this.#byId.has(agentId);
  }

  /** Mostly a debug helper; prefer get() in hot paths. */
  fromDiskConfig(
    cfg: ManagedAgentDiskConfig,
    apiKey: string,
    mcpConfigPath: string,
    subagentLogPath: string,
    cliHomeDir: string,
  ): ManagedAgentContext {
    return {
      agent_id: cfg.agent_id,
      name: cfg.name,
      cli: cfg.cli,
      working_dir: cfg.working_dir,
      mcp_config_path: mcpConfigPath,
      api_key: apiKey,
      subagent_log_path: subagentLogPath,
      cli_home_dir: cliHomeDir,
      registered_at: new Date().toISOString(),
    };
  }
}
