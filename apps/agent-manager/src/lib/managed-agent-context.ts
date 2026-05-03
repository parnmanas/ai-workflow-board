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
