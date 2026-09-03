// ─── Agent display name (ST-7) ───────────────────────────────────────
//
// CONTRACT + CHECKLIST: .claude/skills/awb-agent-display-name/SKILL.md — read it
// before adding any agent picker, roster, or label. Never render `{a.name}` and
// never hand-roll `${a.manager_name}/${a.name}`; always call
// formatAgentDisplayName. Note the usual trap: mapping an agent list to
// `{ id, name }` silently DROPS manager_name, so the label goes bare even
// though the API returned it.
// Single source of truth for the `<ManagerName>/<AgentName>` rendering of
// managed agents across the AWB UI. Centralized here so changing the
// separator (or adding badges, icons, etc.) is a one-line edit.
//
// Rendering rules:
//   - has manager_name → "<manager>/<name>"
//   - no manager_name (non-executable or historical identity) → "<name>"
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

/** 이름을 못 찾았을 때 쓰는 라벨. **id 를 이름 자리에 넣지 않기 위한** 것이다
 *  (ticket 20fff298) — 표시 계약상 raw agent id 는 이름이 아니고, 화면에
 *  `a1b2c3d4` 가 뜨면 운영자는 그게 이름인지 id 인지 알 수 없다. */
export const AGENT_NAME_UNRESOLVED = '(이름 미확인)';

/**
 * 에이전트 라벨과, 지원/디버깅용 id 툴팁을 함께 만든다 (ticket 20fff298).
 *
 * 이름을 못 찾은 자리에 id 를 fallback 으로 렌더하던 곳들을 대체한다. id 는
 * 여전히 필요하지만 **이름인 척하면 안 되므로** `title` 로 내린다 — 화면에는
 * "이름을 모른다"는 사실이 보이고, 커서를 올리면 id 가 나온다.
 *
 * `agent` 가 없다는 것과 `agent.name` 이 비었다는 것을 구분하지 않는 이유는,
 * 둘 다 "이 화면이 이름을 확보하지 못했다"는 같은 결론이기 때문이다.
 */
export function agentIdentityLabel(
  agent: AgentLike | null | undefined,
  agentId?: string | null,
): { text: string; title: string | undefined } {
  const title = agentId ? `agent id: ${agentId}` : undefined;
  if (!agent || !(agent.name ?? '').trim()) return { text: AGENT_NAME_UNRESOLVED, title };
  return { text: formatAgentDisplayName(agent), title };
}
