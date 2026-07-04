import { z } from 'zod';

/**
 * Cross-board handoff pipeline (ticket ac21a745).
 *
 * A ticket can declare a `handoff_spec` — an ordered list of "hops". When the
 * ticket lands on a terminal column, HandoffService pops the FIRST hop and
 * creates a follow-up ticket on that hop's target board (with the origin's
 * deliverable context carried over), then hands the REMAINING hops down to the
 * follow-up's own `handoff_spec`. So a single spec of N hops drives an N-board
 * relay (기획 → 그래픽 → 클라 → QA) with zero human intervention — each stage's
 * completion births the next stage's ticket. When the last hop is consumed the
 * follow-up carries an empty spec and the relay terminates naturally (the chain
 * is self-terminating — no recursion guard label needed, unlike the on-done
 * Action hook, because a hop is consumed exactly once).
 *
 * This module owns ONLY the JSON shape (like respawn-storm-config /
 * default-role-assignments-config). Board/column/agent EXISTENCE is checked at
 * dispatch time against the DB by HandoffService — a spec pointing at a board
 * that later disappears degrades to a logged skip, never a crash.
 *
 * Storage: `tickets.handoff_spec` VARCHAR holding this JSON ('' / '{}' / null =
 * no handoff, behaviour unchanged). Read path (parseHandoffSpec) is tolerant and
 * returns an empty spec on garbage; write path (validateHandoffSpecInput)
 * REJECTS malformed shapes so a typo surfaces as a 400 instead of a silently
 * dropped relay.
 */

/** One relay stage: create a follow-up ticket on `target_board_id`. */
const HandoffHopSchema = z
  .object({
    // The next functional board. Required — the whole point of a hop.
    target_board_id: z.string().min(1),
    // Column on the target board to drop the follow-up into. Omitted → the
    // board's first non-terminal column that routes a role (so it auto-dispatches).
    target_column_name: z.string().optional(),
    // Title of the follow-up. Supports {{source_title}}. Omitted → a default
    // "[핸드오프] <source_title>" is used.
    title_template: z.string().optional(),
    // Body of the follow-up. Supports {{source_title}} / {{source_link}} /
    // {{source_id}} / {{handoff_note}} / {{attachments}}. The carried-context
    // block (deep link + final handoff comment + attachments) is ALWAYS appended
    // even when a custom template is given, so downstream agents never have to
    // re-discover the predecessor's deliverable.
    description_template: z.string().optional(),
    // Explicit role holders on the follow-up. Omitted roles fall back to the
    // source ticket's holders, then the target board's default_role_assignments.
    assignee_id: z.string().optional(),
    reporter_id: z.string().optional(),
    reviewer_id: z.string().optional(),
    labels: z.array(z.string()).optional(),
    priority: z.string().optional(),
    effort_preset: z.string().optional(),
    // Carry EVERY attachment resource from the source ticket onto the follow-up.
    carry_attachments: z.boolean().optional(),
    // Carry only these specific resource ids (union'd with carry_attachments).
    carry_attachment_ids: z.array(z.string()).optional(),
  })
  .strict();

export const HandoffSpecSchema = z
  .object({
    hops: z.array(HandoffHopSchema),
  })
  .strict();

export type HandoffHop = z.infer<typeof HandoffHopSchema>;
export type HandoffSpec = z.infer<typeof HandoffSpecSchema>;

export const EMPTY_HANDOFF_SPEC: HandoffSpec = { hops: [] };

/**
 * Tolerant read parser. Accepts the stored string (or an already-parsed object)
 * and returns a normalized spec, dropping hops with no target_board_id. NEVER
 * throws — malformed / empty input yields `{ hops: [] }` so read paths
 * (parseTicket, board projection, the dispatch listener) stay crash-free.
 */
export function parseHandoffSpec(raw: unknown): HandoffSpec {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return { hops: [] };
    try {
      obj = JSON.parse(s);
    } catch {
      return { hops: [] };
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { hops: [] };
  const hopsRaw = (obj as { hops?: unknown }).hops;
  if (!Array.isArray(hopsRaw)) return { hops: [] };
  const hops: HandoffHop[] = [];
  for (const h of hopsRaw) {
    if (!h || typeof h !== 'object' || Array.isArray(h)) continue;
    const boardId = String((h as any).target_board_id || '').trim();
    if (!boardId) continue;
    const hop: HandoffHop = { target_board_id: boardId };
    const str = (k: string) => {
      const v = (h as any)[k];
      return typeof v === 'string' && v.trim() ? v.trim() : undefined;
    };
    hop.target_column_name = str('target_column_name');
    hop.title_template = typeof (h as any).title_template === 'string' ? (h as any).title_template : undefined;
    hop.description_template = typeof (h as any).description_template === 'string' ? (h as any).description_template : undefined;
    hop.assignee_id = str('assignee_id');
    hop.reporter_id = str('reporter_id');
    hop.reviewer_id = str('reviewer_id');
    const labels = (h as any).labels;
    if (Array.isArray(labels)) hop.labels = labels.filter((l) => typeof l === 'string' && l.trim()).map((l) => l.trim());
    hop.priority = str('priority');
    hop.effort_preset = str('effort_preset');
    if (typeof (h as any).carry_attachments === 'boolean') hop.carry_attachments = (h as any).carry_attachments;
    const cids = (h as any).carry_attachment_ids;
    if (Array.isArray(cids)) hop.carry_attachment_ids = cids.filter((c) => typeof c === 'string' && c.trim()).map((c) => c.trim());
    // Strip undefined keys so JSON.stringify stays compact.
    for (const k of Object.keys(hop) as (keyof HandoffHop)[]) {
      if (hop[k] === undefined) delete hop[k];
    }
    hops.push(hop);
  }
  return { hops };
}

/** True when the spec has at least one usable hop. */
export function handoffSpecHasHops(raw: unknown): boolean {
  return parseHandoffSpec(raw).hops.length > 0;
}

/**
 * Strict write validator (create_ticket / update_ticket / set_ticket_handoff).
 * Returns the canonical JSON STRING to persist. An empty/undefined input clears
 * the spec (returns ''). A malformed shape throws a 400-shaped Error so the typo
 * is loud, matching default-role-assignments-config's contract.
 */
export function validateHandoffSpecInput(raw: unknown): string {
  if (raw === undefined || raw === null || raw === '') return '';
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return '';
    try {
      obj = JSON.parse(s);
    } catch {
      throw badRequest('handoff_spec must be valid JSON');
    }
  }
  const parsed = HandoffSpecSchema.safeParse(obj);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw badRequest(`handoff_spec invalid: ${first ? `${first.path.join('.')} ${first.message}` : 'bad shape'}`);
  }
  // Re-run the tolerant normalizer so what we store is the trimmed read-model.
  const normalized = parseHandoffSpec(obj);
  if (normalized.hops.length === 0) return '';
  return JSON.stringify(normalized);
}

function badRequest(msg: string): Error {
  const e = new Error(msg) as Error & { status: number };
  e.status = 400;
  return e;
}
