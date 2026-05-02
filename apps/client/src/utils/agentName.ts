// ─── Agent display name (ST-7) ───────────────────────────────────────
// Single source of truth for the `<ManagerName>/<AgentName>` rendering of
// managed agents across the AWB UI. Centralized here so changing the
// separator (or adding badges, icons, etc.) is a one-line edit.
//
// Rendering rules:
//   - has manager_name → "<manager>/<name>"
//   - no manager_name (legacy / standalone) → "<name>"
//   - missing both (defensive) → "(unnamed)"

export interface AgentLike {
  name?: string | null;
  manager_name?: string | null;
}

const SEPARATOR = '/';

/**
 * Format an agent for human display. Stable across agent listings, ticket
 * panel role rows, mention textarea suggestions, comment renderers, chat
 * participants, subagent monitors — anything that shows an agent name.
 */
export function formatAgentDisplayName(agent: AgentLike | null | undefined): string {
  if (!agent) return '(unknown)';
  const name = (agent.name ?? '').trim();
  const mgr = (agent.manager_name ?? '').trim();
  if (!name) return '(unnamed)';
  return mgr ? `${mgr}${SEPARATOR}${name}` : name;
}

/**
 * Inverse of formatAgentDisplayName for free-form input (mention search,
 * filter boxes). Returns the manager-side and agent-side fragments.
 *
 *   "manager/agent"  → { manager: "manager", agent: "agent" }
 *   "agent"          → { agent: "agent" }
 *   "manager/"       → { manager: "manager", agent: "" }    // partial input
 *
 * Only splits on the FIRST `/` so an agent name containing `/` (rare but
 * legal) round-trips when prefixed with a manager.
 */
export function parseAgentDisplayName(input: string): { manager?: string; agent: string } {
  const trimmed = input.trim();
  const slash = trimmed.indexOf(SEPARATOR);
  if (slash === -1) return { agent: trimmed };
  return { manager: trimmed.slice(0, slash), agent: trimmed.slice(slash + 1) };
}

/**
 * Predicate for autocomplete / filter inputs. Matches when EITHER the
 * display name (manager/agent) OR the bare agent name contains the query
 * substring (case-insensitive). Lets the user type "ralf" to find
 * "engineering/ralf-coder" as well as the bare "ralf-coder".
 */
export function agentMatchesQuery(agent: AgentLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const display = formatAgentDisplayName(agent).toLowerCase();
  if (display.includes(q)) return true;
  const bare = (agent.name ?? '').toLowerCase();
  return bare.includes(q);
}
