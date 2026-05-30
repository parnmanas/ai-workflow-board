// `{{var.path}}` interpolation for Action prompts. Kept deliberately small —
// this is not Mustache. Substitutes whitelisted dotted paths from a context
// object; unresolved tokens render as the empty string. We resist falling back
// to the literal token text because the rendered prompt is what gets sent to
// the agent, and stray `{{user.name}}` strings in the prompt confuse the
// agent more than a clean substitution.

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

// Finished-ticket context exposed to on-ticket-done hook Actions (ticket
// 16a6339c). Lets the hook prompt reference the ticket that just completed via
// `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.board_id}}`, etc. Only the
// hook dispatch path populates this; cron / manual runs leave it undefined so
// those tokens render empty.
export interface ActionTicketContext {
  id?: string;
  title?: string;
  board_id?: string;
  column_id?: string;
  priority?: string;
  status?: string;
  description?: string;
  // Repo / branch the ticket built against — the closest thing to a PR/diff
  // pointer the server holds without a GitHub round-trip.
  base_branch?: string;
  base_repo_id?: string;
  // Comma-joined labels (the raw column is a JSON string; flattened here so
  // `{{ticket.labels}}` renders human-readably).
  labels?: string;
  assignee?: string;
  reporter?: string;
}

export interface ActionRenderContext {
  workspace?: { id?: string; name?: string };
  board?: { id?: string; name?: string } | null;
  user?: { id?: string; name?: string; email?: string } | null;
  agent?: { id?: string; name?: string } | null;
  action?: { id?: string; name?: string };
  run?: { id?: string };
  // Populated only on the on-ticket-done hook path (ticket 16a6339c) — the
  // finished ticket that triggered the Run.
  ticket?: ActionTicketContext | null;
  // Convenience tokens — the action user expects `{{date}}` to just work
  // without diving into ISO formatting. Keep the surface tiny.
  date?: string;
  time?: string;
  datetime?: string;
}

function resolvePath(ctx: ActionRenderContext, path: string): string {
  const parts = path.split('.');
  let cur: any = ctx;
  for (const p of parts) {
    if (cur === null || cur === undefined) return '';
    cur = cur[p];
  }
  if (cur === null || cur === undefined) return '';
  if (typeof cur === 'string') return cur;
  if (typeof cur === 'number' || typeof cur === 'boolean') return String(cur);
  // Objects don't render — caller used the wrong path.
  return '';
}

export function renderActionPrompt(template: string, ctx: ActionRenderContext): string {
  if (!template) return '';
  return template.replace(TOKEN_RE, (_full, path) => resolvePath(ctx, path));
}

// Build the standard render context out of the loaded entity rows. Centralized
// here so MCP `run_action` and the REST run endpoint produce identical output
// for the same inputs.
export function buildRenderContext(args: {
  workspace?: { id?: string; name?: string } | null;
  board?: { id?: string; name?: string } | null;
  user?: { id?: string; name?: string; email?: string } | null;
  agent?: { id?: string; name?: string } | null;
  action: { id: string; name: string };
  runId: string;
  ticket?: ActionTicketContext | null;
  now?: Date;
}): ActionRenderContext {
  const now = args.now ?? new Date();
  const iso = now.toISOString();
  return {
    workspace: args.workspace ? { id: args.workspace.id, name: args.workspace.name } : undefined,
    board: args.board ? { id: args.board.id, name: args.board.name } : null,
    user: args.user ? { id: args.user.id, name: args.user.name, email: args.user.email } : null,
    agent: args.agent ? { id: args.agent.id, name: args.agent.name } : null,
    action: { id: args.action.id, name: args.action.name },
    run: { id: args.runId },
    ticket: args.ticket ?? null,
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    datetime: iso,
  };
}
