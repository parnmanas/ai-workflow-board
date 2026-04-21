/**
 * Shared helpers for MCP tools.
 *
 * Extracted from mcp-tools.ts during Phase 3 refactor so that each domain
 * tool file can import them without pulling in the whole monolith.
 */

/**
 * Tolerant JSON parse: returns `fallback` for null/undefined/malformed input.
 * Used extensively to decode `labels` and `channel_ids` columns that are
 * stored as JSON strings.
 */
export function safeJsonParse(val: string | null | undefined, fallback: any = []): any {
  try { return JSON.parse(val || JSON.stringify(fallback)); }
  catch { return fallback; }
}

/**
 * Standard MCP tool success shape.
 */
export function ok(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/**
 * Standard MCP tool error shape.
 */
export function err(message: string) {
  return { content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }], isError: true };
}

/**
 * Mention-syntax documentation embedded in every comment/chat tool description.
 *
 * Agents were getting this wrong — writing `@Name`, `@[Name]`, or `@user:Name`
 * instead of the structured token MentionService expects. A malformed mention
 * degrades silently (the `@` renders as plain text and no notification fires),
 * so the cost of an unclear doc is high. Keep this text in sync with the
 * TOKEN_RE regex in `mention.service.ts`.
 */
export const MENTION_SYNTAX_DOC =
  'MENTION SYNTAX — use structured `@[type:id|Display Name]` tokens so the server can notify the target. ' +
  'Plain `@Name`, `@Name#1234`, or markdown links do NOT fire notifications and render as raw text. ' +
  'Valid forms:\n' +
  '  • `@[user:<uuid>|Alice]`          — DM-style mention of a workspace user; writes UserMention row + fires user_mention SSE\n' +
  '  • `@[agent:<uuid>|BuildBot]`      — mention a specific agent; fires comment_mention SSE scoped to that agent\n' +
  '  • `@[role:assignee|Alice]`        — role shortcut, expands to the ticket\'s current assignee\n' +
  '  • `@[role:reporter|Bob]`          — role shortcut, expands to the ticket\'s reporter\n' +
  '  • `@[role:reviewer|Carol]`        — role shortcut, expands to the ticket\'s reviewer (dropped if unset)\n' +
  'Resolve ids by calling `list_users` / `list_agents` / `get_ticket` first. The `|Display Name` segment is ' +
  'optional but recommended — it\'s what humans read in the UI when the link target is a UUID. ' +
  'Self-mention rule: never write `@[role:<your-role>|...]` pointing at yourself inside a subagent comment — ' +
  'it triggers a recursive spawn loop. Mention the other role(s) instead.';
