/**
 * Canonical list of agent CLI `type` values the system accepts.
 *
 * Single source of truth for the two server-side consumers:
 *   - agent-manager.controller.ts → ALLOWED_CLI_TYPES (managed-agent create/spawn `cli` validation)
 *   - mcp/tools/agent-tools.ts    → create_agent / update_agent `type` enum
 *
 * Two further mirrors live outside this package (separate build units) and
 * must be kept in sync by hand — keep this comment and theirs pointing at
 * each other:
 *   - apps/agent-manager .../cli-adapters/index.ts → KNOWN_ADAPTER_CLI_TYPES
 *     (this list minus 'custom', which has no adapter)
 *   - apps/client .../AgentsPage.tsx + admin/AgentManager.tsx → CLI pickers
 *
 * `claude | deepseek | codex | antigravity | pi` each ship a real adapter in
 * the agent-manager; `custom` is a valid identity the manager refuses to
 * auto-spawn (the operator supplies the launch script). Legacy `gpt` /
 * `gemini` were retired — do not re-add them. `manager` is a separate
 * pairing-minted identity (not a CLI selector) so it is intentionally absent.
 * `pi` has no credential concept at all (unlike every other adapter, which at
 * least supports an optional per-agent credential) — see
 * common/effort-presets.ts and cli-adapters/pi.ts for the rest of its shape.
 */
export const CLI_TYPES = ['claude', 'deepseek', 'codex', 'antigravity', 'pi', 'custom'] as const;

export type CliType = (typeof CLI_TYPES)[number];

/** Set form for O(1) membership checks (validation in the REST controller). */
export const ALLOWED_CLI_TYPES: ReadonlySet<string> = new Set(CLI_TYPES);
