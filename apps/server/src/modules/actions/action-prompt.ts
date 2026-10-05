// `{{var.path}}` interpolation for Action prompts. Kept deliberately small —
// this is not Mustache. Substitutes whitelisted dotted paths from a context
// object; unresolved tokens render as the empty string. We resist falling back
// to the literal token text because the rendered prompt is what gets sent to
// the agent, and stray `{{user.name}}` strings in the prompt confuse the
// agent more than a clean substitution.

const TOKEN_RE = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

// 패키지 간 wire contract (티켓 9fd27487): agent-manager의 prompts.ts에 있는
// WORK_FOLDER_TOKEN과 짝을 이룬다. 서버는 에이전트의 절대경로 working_dir을
// 알 수 없으므로, 다른 모든 `{{var.path}}`와 달리 이 토큰만은 일부러 여기서
// 해석하지 않는다 — agent-manager가 `.awb/act/<leaf>` cwd를 확정한 뒤
// (composeChatRoomPrompt의 injectWorkFolder 호출) 그 하위 단계에서 이 토큰을
// 치환한다. 티켓 트리거 경로에서 column-workflow-guide 템플릿이 이미 의존하고
// 있는 것과 같은 패턴이다.
const AWB_WORK_FOLDER_PATH = 'AWB_WORK_FOLDER';

// Finished-ticket context exposed to on-ticket-done hook Actions (ticket
// 16a6339c). Lets the hook prompt reference the ticket that just completed via
// `{{ticket.id}}`, `{{ticket.title}}`, `{{ticket.status}}`, `{{ticket.tags}}`,
// etc. Only the hook dispatch path populates this; cron / manual runs leave it
// undefined so those tokens render empty.
export interface ActionTicketContext {
  id?: string;
  title?: string;
  priority?: string;
  status?: string;
  description?: string;
  // Repo / branch the ticket built against — the closest thing to a PR/diff
  // pointer the server holds without a GitHub round-trip.
  project_id?: string;
  base_branch?: string;
  // Comma-joined tags (the raw column is a JSON string; flattened here so
  // `{{ticket.tags}}` renders human-readably).
  tags?: string;
  // Assignee label (the RuntimeSpec's display label), '' when unassigned.
  assignee?: string;
  // Pre-board-removal spellings, kept so saved hook prompts that still say
  // `{{ticket.labels}}` / `{{ticket.base_repo_id}}` keep rendering: same
  // values as `tags` / `project_id` (repository ids became project ids).
  labels?: string;
  base_repo_id?: string;
}

export interface ActionRenderContext {
  account?: { id?: string; name?: string };
  /** Compatibility for previously saved templates. */
  workspace?: { id?: string; name?: string };
  // The finished ticket's project (hook runs only) — `{{project.name}}`,
  // `{{project.repo_url}}`, `{{project.default_branch}}`.
  project?: { id?: string; name?: string; repo_url?: string; default_branch?: string } | null;
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
  return template.replace(TOKEN_RE, (full, path) => {
    // {{AWB_WORK_FOLDER}}는 그대로 둔다 — 위 AWB_WORK_FOLDER_PATH 설명 참고.
    // 그 외 해석되지 않는 경로는 이 모듈 상단 설명대로 여전히 ''로 접힌다.
    if (path === AWB_WORK_FOLDER_PATH) return full;
    return resolvePath(ctx, path);
  });
}

// Build the standard render context out of the loaded entity rows. Centralized
// here so MCP `run_action` and the REST run endpoint produce identical output
// for the same inputs.
export function buildRenderContext(args: {
  workspace?: { id?: string; name?: string } | null;
  project?: { id?: string; name?: string; repo_url?: string; default_branch?: string } | null;
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
    account: args.workspace ? { id: args.workspace.id, name: args.workspace.name } : undefined,
    workspace: args.workspace ? { id: args.workspace.id, name: args.workspace.name } : undefined,
    project: args.project
      ? { id: args.project.id, name: args.project.name, repo_url: args.project.repo_url, default_branch: args.project.default_branch }
      : null,
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
