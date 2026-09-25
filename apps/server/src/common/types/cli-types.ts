/**
 * Canonical list of agent CLI `type` values the system accepts.
 *
 * DERIVED from `common/cli-catalog.ts` — the single source of truth for every
 * per-CLI fact (transport, credential providers, login, sessions, effort keys,
 * runtime knobs). To add a CLI, add a descriptor there; this list, the
 * executable-runtime set, the effort-preset schema, the ACP session set, the
 * credential provider table and the login provider map all follow. Do NOT
 * add an id here by hand.
 *
 * Consumers in this package:
 *   - agent-manager.controller.ts → ALLOWED_CLI_TYPES (managed-agent create/spawn `cli` validation)
 *   - mcp/tools/agent-tools.ts    → create_agent / update_agent `type` enum
 *
 * Two further mirrors live outside this package (separate build units) and
 * must be kept in sync by hand — keep this comment and theirs pointing at
 * each other:
 *   - apps/agent-manager .../cli-adapters/index.ts → KNOWN_ADAPTER_CLI_TYPES
 *     (this list minus 'custom', which has no adapter)
 *   - apps/client .../AgentsPage.tsx + admin/ManagedAgentDialog.tsx → CLI pickers
 *     (the client can also read `GET /api/cli-catalog` instead of hardcoding)
 *
 * `custom` is a valid identity the manager refuses to auto-spawn (the operator
 * supplies the launch script). Legacy `gpt` / `gemini` were retired — do not
 * re-add them. `manager` is a separate pairing-minted identity (not a CLI
 * selector) so it is intentionally absent.
 */
import { CLI_IDS, type CliType } from '../cli-catalog';

export type { CliType };

export const CLI_TYPES: readonly CliType[] = CLI_IDS;

/** Set form for O(1) membership checks (validation in the REST controller). */
export const ALLOWED_CLI_TYPES: ReadonlySet<string> = new Set(CLI_TYPES);
