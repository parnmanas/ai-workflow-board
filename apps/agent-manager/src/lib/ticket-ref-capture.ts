// Pure helpers for F-1 (ticket 24694916) — mechanical ticket-action card capture.
//
// The ChatSessionManager observes the CLI's stream-json: mcp__awb__* tool calls
// (tool_use) and their results (tool_result). These helpers turn that raw stream
// data into structured ticket refs WITHOUT any I/O or session state, so the
// capture correctness ("누락 없이") is unit-testable without booting a session.
// The manager keeps only the stateful glue (pending map, title cache, flush).

/**
 * MCP ticket-mutation surface → card action, keyed by the BARE tool name (suffix
 * after the last `__`) so it matches whatever MCP server prefix the CLI uses
 * (mcp__awb__… / mcp__ai-workflow-board__…).
 *
 * CONTRACT (ticket 24694916, acceptance #1 "누락 없이") — every MCP tool that
 * mutates a ticket's own row / lifecycle / workflow state emits a card. The scope
 * is classified explicitly and exhaustively so a newly-added tool is a deliberate
 * decision, never a silent gap:
 *
 *   EMIT (this map) — create / move (incl. cross-board) / update (incl. child),
 *     comment, claim / release, pend / unpend, archive / unarchive, prerequisite
 *     add / remove, handoff, and the consensus micro-protocol (propose_move +
 *     record_agreement). batch_operations is EMIT too but fans ONE result out to
 *     many refs → BATCH_TICKET_TOOL below.
 *
 *   EXCLUDE (intentional — never a card) —
 *     • Reads (get_ticket, get_*, list_*, search_*) — feed the title cache only.
 *     • Deletes (delete_ticket, delete_child_ticket) — the card would deep-link a
 *       ticket that no longer exists (404).
 *     • reject_handoff — keys on `followup_ticket_id` (not `ticket_id`) and is a
 *       rare relay rejection; excluded so a mis-resolved id never ships a bad ref.
 *     • Ticket attachments (add/delete_ticket_attachment) — sub-resource I/O, not
 *       a ticket-lifecycle action.
 *     • send_chat_room_message — the assistant's own reply, not a ticket action.
 *     • Every non-ticket tool (board / workspace / agent / channel / resource / qa
 *       / security / feature / action / user / …) — not a ticket-row mutation.
 */
export const TICKET_ACTION_TOOLS: Record<string, string> = {
  create_ticket: 'create',
  create_child_ticket: 'create',
  move_ticket: 'move',
  move_ticket_to_board: 'move',
  update_ticket: 'update',
  update_child_ticket: 'update',
  add_comment: 'comment',
  claim_ticket: 'claim',
  release_ticket: 'release',
  pend_ticket: 'pend',
  unpend_ticket: 'unpend',
  archive_ticket: 'archive',
  unarchive_ticket: 'unarchive',
  add_ticket_prerequisites: 'prereq',
  remove_ticket_prerequisite: 'prereq',
  handoff_to_agent: 'handoff',
  propose_move: 'propose',
  record_agreement: 'consensus',
};
/** Tools whose NEW ticket id is only in the tool RESULT (not the input). For every
 *  other tracked tool the input `ticket_id` is authoritative — the result `id` may
 *  be a comment id (add_comment) etc., so it must NOT be used as the ticket id. */
export const TICKET_CREATE_TOOLS = new Set(['create_ticket', 'create_child_ticket']);

/** The one MCP ticket tool whose single tool_result fans out to MANY refs:
 *  batch_operations runs N ops in a transaction, so its result carries a
 *  `results[]` array parallel to the input `operations[]`. Handled by
 *  resolveBatchTicketRefs (multi-ref), NOT the 1-result→1-ref path above. */
export const BATCH_TICKET_TOOL = 'batch_operations';
/** batch_operations sub-action → card action. An op whose action isn't here (or
 *  that failed) emits no ref. Legacy aliases (add-subtask / update-subtask) fold
 *  onto the same action as their current name. */
export const BATCH_OP_ACTION: Record<string, string> = {
  'create-ticket': 'create',
  'move-ticket': 'move',
  'add-child': 'create',
  'add-subtask': 'create',
  'update-child': 'update',
  'update-subtask': 'update',
  'add-comment': 'comment',
};
/** Korean action label for the fallback content line — rendered on surfaces that
 *  don't understand metadata (history replay, notifications, legacy clients). */
export const TICKET_ACTION_LABEL_KO: Record<string, string> = {
  create: '생성', move: '이동', update: '수정', comment: '코멘트',
  claim: '클레임', release: '클레임 해제', pend: '보류', unpend: '보류 해제',
  archive: '아카이브', unarchive: '아카이브 해제', prereq: '선행조건',
  handoff: '핸드오프', propose: '이동 제안', consensus: '합의',
};

export interface TicketToolContext {
  action: string;
  fromResult: boolean;
  inputTicketId?: string;
  inputTitle?: string;
  /** Set ONLY for batch_operations: the raw input `operations[]`, zipped against
   *  the result `results[]` by resolveBatchTicketRefs. Presence of this field is
   *  what routes a capture down the multi-ref path instead of resolveTicketRef. */
  batchOps?: any[];
}
export interface TicketRef {
  action: string;
  ticket_id: string;
  title?: string;
}

export function bareToolName(name: string): string {
  // mcp__awb__create_ticket → create_ticket; a plain name (Bash) is unchanged.
  const i = name.lastIndexOf('__');
  return i >= 0 ? name.slice(i + 2) : name;
}

/** Map a tool_use block's name+input → a pending capture context, or null when the
 *  tool is not a tracked ticket action. */
export function trackedTicketTool(name: unknown, input: any): TicketToolContext | null {
  if (typeof name !== 'string') return null;
  const bare = bareToolName(name);
  const inp = input && typeof input === 'object' ? input : {};
  // batch_operations is a special case: one call, many ticket mutations. Capture
  // the raw operations[] here; resolveBatchTicketRefs zips it with results[] later.
  if (bare === BATCH_TICKET_TOOL) {
    return {
      action: 'batch',
      fromResult: true,
      batchOps: Array.isArray(inp.operations) ? inp.operations : [],
    };
  }
  const action = TICKET_ACTION_TOOLS[bare];
  if (!action) return null;
  return {
    action,
    fromResult: TICKET_CREATE_TOOLS.has(bare),
    inputTicketId: typeof inp.ticket_id === 'string' ? inp.ticket_id : undefined,
    inputTitle: typeof inp.title === 'string' ? inp.title : undefined,
  };
}

/** Parse a stream tool_result block's `content` (a plain string or an array of
 *  content blocks like [{type:'text', text}]) into the JSON value, or null. */
export function parseStreamToolResult(raw: any): any {
  let text: string | null = null;
  if (typeof raw === 'string') text = raw;
  else if (Array.isArray(raw)) {
    const t = raw.find((c) => c && c.type === 'text' && typeof c.text === 'string');
    text = t ? t.text : null;
  }
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Shallow-collect {id,title} ticket pairs from a parsed result (a ticket object,
 *  an array of tickets, or a ticket with a `children` array) — bounded, no deep
 *  descent. Pure: returns the pairs; the caller decides how to cache them. */
export function harvestTicketTitles(result: any): Array<{ id: string; title: string }> {
  const out: Array<{ id: string; title: string }> = [];
  if (!result || typeof result !== 'object') return out;
  const consider = (o: any) => {
    if (o && typeof o === 'object' && typeof o.id === 'string' && typeof o.title === 'string') {
      out.push({ id: o.id, title: o.title });
    }
  };
  if (Array.isArray(result)) {
    for (const el of result.slice(0, 100)) consider(el);
    return out;
  }
  consider(result);
  if (Array.isArray(result.children)) for (const c of result.children.slice(0, 100)) consider(c);
  return out;
}

/** Resolve a tracked tool call + its parsed result into a ticket ref, or null when
 *  the ticket can't be identified or the action errored. `titleLookup` supplies a
 *  cached title for existing-ticket actions whose result carries none. */
export function resolveTicketRef(
  ctx: TicketToolContext,
  result: any,
  isError: boolean,
  titleLookup?: (id: string) => string | undefined,
): TicketRef | null {
  if (isError) return null;
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  let ticketId: string | undefined;
  if (ctx.fromResult) {
    // CREATE: the new ticket id is the result object's `id`.
    if (obj && typeof obj.id === 'string') ticketId = obj.id;
  } else {
    // EXISTING ticket: input ticket_id is authoritative (result.id may be a comment
    // id for add_comment). Fall back to result.ticket_id.
    ticketId = ctx.inputTicketId || (obj && typeof obj.ticket_id === 'string' ? obj.ticket_id : undefined);
  }
  if (!ticketId) return null;
  let title: string | undefined;
  if (obj && typeof obj.title === 'string' && obj.title) title = obj.title;
  if (!title) title = (titleLookup && titleLookup(ticketId)) || ctx.inputTitle;
  const ref: TicketRef = { action: ctx.action, ticket_id: ticketId };
  if (title) ref.title = title;
  return ref;
}

/** Resolve a batch_operations call into MANY ticket refs — the multi-ref path the
 *  1-result→1-ref resolveTicketRef can't cover. Zips the captured input
 *  `operations[]` with the result `results[]` (parallel arrays, same index):
 *  every op that SUCCEEDED and maps to a tracked BATCH_OP_ACTION yields one ref.
 *  The ticket id comes from the result row's `ticketId` (a create's NEW id, a
 *  move/update-child's target), except add-comment whose result carries only a
 *  `commentId` — there the ticket is the INPUT op's `ticketId`. Failed ops
 *  (`error`, or no `success`) and untracked ops emit nothing. */
export function resolveBatchTicketRefs(
  ctx: TicketToolContext,
  result: any,
  isError: boolean,
  titleLookup?: (id: string) => string | undefined,
): TicketRef[] {
  if (isError || !Array.isArray(ctx.batchOps)) return [];
  const obj = result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  const rows = obj && Array.isArray(obj.results) ? obj.results : null;
  if (!rows) return [];
  const ops = ctx.batchOps;
  const out: TicketRef[] = [];
  const n = Math.min(ops.length, rows.length);
  for (let i = 0; i < n; i++) {
    const op = ops[i];
    const row = rows[i];
    if (!op || typeof op !== 'object' || !row || typeof row !== 'object') continue;
    if (row.success !== true || row.error != null) continue; // failed op → no card
    const action = BATCH_OP_ACTION[String(op.action)];
    if (!action) continue; // untracked op (e.g. read/unknown) → no card
    const rowTicketId = typeof row.ticketId === 'string' ? row.ticketId : undefined;
    const opTicketId = typeof op.ticketId === 'string' ? op.ticketId : undefined;
    // add-comment's result is {success, commentId} — the ticket is the input's;
    // every other op's result row carries the (new or target) ticketId.
    const ticketId = action === 'comment' ? opTicketId : rowTicketId || opTicketId;
    if (!ticketId) continue;
    let title: string | undefined = typeof op.title === 'string' && op.title ? op.title : undefined;
    if (!title) title = titleLookup && titleLookup(ticketId);
    const ref: TicketRef = { action, ticket_id: ticketId };
    if (title) ref.title = title;
    out.push(ref);
  }
  return out;
}

/** Compose the Korean fallback content line for a coalesced set of refs. */
export function formatTicketRefsContent(refs: TicketRef[]): string {
  return refs
    .map((r) => `📋 티켓 ${TICKET_ACTION_LABEL_KO[r.action] || r.action || '작업'}: ${r.title || r.ticket_id}`)
    .join('\n');
}
