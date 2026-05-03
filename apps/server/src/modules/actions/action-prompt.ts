// `{{var.path}}` interpolation for Action prompts. Kept deliberately small —
// this is not Mustache. Substitutes whitelisted dotted paths from a context
// object; unresolved tokens render as the empty string. We resist falling back
// to the literal token text because the rendered prompt is what gets sent to
// the agent, and stray `{{user.name}}` strings in the prompt confuse the
// agent more than a clean substitution.

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface ActionRenderContext {
  workspace?: { id?: string; name?: string };
  board?: { id?: string; name?: string } | null;
  user?: { id?: string; name?: string; email?: string } | null;
  agent?: { id?: string; name?: string } | null;
  action?: { id?: string; name?: string };
  run?: { id?: string };
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
    date: iso.slice(0, 10),
    time: iso.slice(11, 19),
    datetime: iso,
  };
}
