import { z } from 'zod';

/**
 * Board-level default role holders (ticket d94a1b87).
 *
 * A board can declare, per workspace role slug, the holder(s) a freshly-created
 * ticket should get when the caller does NOT explicitly staff that role. At
 * create time the common priority is **explicit holder > board default >
 * unassigned** (see TicketRoleAssignmentService.applyBoardDefaults and the four
 * ticket-creation sites — MCP create_ticket, REST POST, QA/Security auto-ticket).
 * The goal: a new ticket lands on the loop without a human manually wiring
 * assignee/reviewer/reporter every time (the single most-repeated manual step in
 * the board activity logs).
 *
 * Shape mirrors the multi-holder (다중담당자 T1) role-assignment model — a slug
 * maps to an ARRAY of holders, each holder pinning exactly one of agent_id /
 * user_id:
 *
 *   { "assignee": [{ "agent_id": "…" }],
 *     "reviewer": [{ "agent_id": "…" }, { "user_id": "…" }],
 *     "reporter": [{ "agent_id": "…" }] }
 *
 * Storage is a `boards.default_role_assignments` TEXT column holding this JSON
 * (null / '{}' = no defaults, behaviour unchanged). Read path is null-tolerant
 * and drops malformed/empty entries; write path (validate*Input) REJECTS bad
 * shapes so a typo surfaces as a 400 instead of a silently-vanishing key —
 * same contract as respawn-storm-config / environment-config. Slug/holder-id
 * EXISTENCE (does this workspace actually have that role / agent / user) needs
 * the DB, so it lives in TicketRoleAssignmentService.validateBoardDefaults —
 * this module only owns the JSON shape (like routing_config's dynamic keys).
 */

/** A single default holder — at most one of agent_id / user_id may be set. */
const HolderSchema = z
  .object({
    agent_id: z.string().optional(),
    user_id: z.string().optional(),
  })
  .strict()
  .refine(
    (h) => !((h.agent_id || '').trim() && (h.user_id || '').trim()),
    { message: 'a default holder may set at most one of agent_id / user_id' },
  );

/**
 * role slug (e.g. "assignee", "reviewer", "reporter", "planner", or any
 * workspace-custom slug) → ordered list of holders. Keys are dynamic (like
 * routing_config's column-name keys) so they can't be `.strict()`-validated
 * here; unknown slugs are caught semantically at write time by the service.
 */
export const DefaultRoleAssignmentsSchema = z.record(
  z.string().min(1),
  z.array(HolderSchema),
);

export type DefaultRoleHolder = { agent_id?: string; user_id?: string };
export type DefaultRoleAssignments = Record<string, DefaultRoleHolder[]>;

/**
 * Normalize a validated/raw config into the applied read-model: trims ids,
 * drops all-empty holders, and drops slugs left with no holder. The result
 * only ever contains slugs that carry ≥1 concrete holder, so consumers can
 * iterate it without re-filtering.
 */
function normalize(raw: unknown): DefaultRoleAssignments {
  const out: DefaultRoleAssignments = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [slugRaw, holdersRaw] of Object.entries(raw as Record<string, unknown>)) {
    const slug = (slugRaw || '').trim();
    if (!slug || !Array.isArray(holdersRaw)) continue;
    const holders: DefaultRoleHolder[] = [];
    const seen = new Set<string>();
    for (const h of holdersRaw) {
      if (!h || typeof h !== 'object') continue;
      const agent_id = String((h as any).agent_id || '').trim();
      const user_id = String((h as any).user_id || '').trim();
      if (agent_id && user_id) continue; // illegal — mutually exclusive
      const key = agent_id ? `agent:${agent_id}` : user_id ? `user:${user_id}` : '';
      if (!key || seen.has(key)) continue; // skip vacant + duplicate holders
      seen.add(key);
      holders.push(agent_id ? { agent_id } : { user_id });
    }
    if (holders.length > 0) out[slug] = holders;
  }
  return out;
}

/** True when a normalized config carries no slug with any holder. */
function isEmpty(cfg: DefaultRoleAssignments): boolean {
  return Object.keys(cfg).length === 0;
}

/**
 * Parse a stored `default_role_assignments` text column. Returns `{}` for
 * null/empty/malformed input — a corrupt row must degrade to "no defaults",
 * never throw on a read path. The result is normalized (trimmed, de-duped,
 * empties dropped).
 */
export function parseDefaultRoleAssignments(raw: string | null | undefined): DefaultRoleAssignments {
  if (!raw) return {};
  try {
    return normalize(JSON.parse(raw));
  } catch {
    return {};
  }
}

/**
 * Validate write-path input (REST PATCH body / MCP update_board arg). Rejects
 * bad shapes so the caller can 400. Only checks the JSON SHAPE — slug/holder
 * existence is a separate DB-backed check (see service.validateBoardDefaults).
 */
export function validateDefaultRoleAssignmentsInput(
  input: unknown,
): { ok: true; value: DefaultRoleAssignments } | { ok: false; error: string } {
  const parsed = DefaultRoleAssignmentsSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Invalid default_role_assignments: ${issues}` };
  }
  return { ok: true, value: normalize(parsed.data) };
}

/**
 * Serialize for storage: an empty config (no slug with a holder) collapses to
 * null so the column's single falsy state = "no defaults".
 */
export function serializeDefaultRoleAssignments(
  value: DefaultRoleAssignments | null | undefined,
): string | null {
  if (!value) return null;
  const normalized = normalize(value);
  return isEmpty(normalized) ? null : JSON.stringify(normalized);
}
