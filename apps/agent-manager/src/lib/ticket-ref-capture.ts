// Pure helpers for F-1 (ticket 24694916) — mechanical ticket-action card capture.
//
// The ChatSessionManager observes the CLI's stream-json: mcp__awb__* tool calls
// (tool_use) and their results (tool_result). These helpers turn that raw stream
// data into structured ticket refs WITHOUT any I/O or session state, so the
// capture correctness ("누락 없이") is unit-testable without booting a session.
// The manager keeps only the stateful glue (pending map, title cache, flush).

/** MCP ticket-action tools whose result becomes a card, keyed by the BARE tool
 *  name (suffix after the last `__`) so it matches whatever MCP server prefix the
 *  CLI uses (mcp__awb__… / mcp__ai-workflow-board__…). Reads (get_ticket, list_*)
 *  are excluded — they feed the title cache but never emit a card. delete_ticket
 *  is excluded too (its card would open a 404). */
export const TICKET_ACTION_TOOLS: Record<string, string> = {
  create_ticket: 'create',
  create_child_ticket: 'create',
  move_ticket: 'move',
  update_ticket: 'update',
  add_comment: 'comment',
  claim_ticket: 'claim',
  pend_ticket: 'pend',
  unpend_ticket: 'unpend',
  archive_ticket: 'archive',
};
/** Tools whose NEW ticket id is only in the tool RESULT (not the input). For every
 *  other tracked tool the input `ticket_id` is authoritative — the result `id` may
 *  be a comment id (add_comment) etc., so it must NOT be used as the ticket id. */
export const TICKET_CREATE_TOOLS = new Set(['create_ticket', 'create_child_ticket']);
/** Korean action label for the fallback content line — rendered on surfaces that
 *  don't understand metadata (history replay, notifications, legacy clients). */
export const TICKET_ACTION_LABEL_KO: Record<string, string> = {
  create: '생성', move: '이동', update: '수정', comment: '코멘트',
  claim: '클레임', pend: '보류', unpend: '보류 해제', archive: '아카이브',
};

export interface TicketToolContext {
  action: string;
  fromResult: boolean;
  inputTicketId?: string;
  inputTitle?: string;
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
  const action = TICKET_ACTION_TOOLS[bare];
  if (!action) return null;
  const inp = input && typeof input === 'object' ? input : {};
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

/** Compose the Korean fallback content line for a coalesced set of refs. */
export function formatTicketRefsContent(refs: TicketRef[]): string {
  return refs
    .map((r) => `📋 티켓 ${TICKET_ACTION_LABEL_KO[r.action] || r.action || '작업'}: ${r.title || r.ticket_id}`)
    .join('\n');
}
