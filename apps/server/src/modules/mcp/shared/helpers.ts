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
 * Strip ephemeral harness markers that a Claude / Codex / Gemini CLI subagent
 * sometimes echoes from its own model context into MCP tool arguments
 * (`<system-reminder>…</system-reminder>`, `<command-message>…`,
 * `<command-args>…`, `<local-command-stdout>…`, `<local-command-stderr>…`).
 *
 * Background: when the upstream CLI binary injects a "reminder" turn into the
 * model context, a confused model can echo that XML-tagged block verbatim into
 * the `content` parameter of `add_comment`, the `description` of
 * `update_ticket`, or any other long-text MCP arg — landing the marker as
 * literal user-visible text in the DB. See ticket ce6c8d58 for the LGTM-stuck
 * reproducer.
 *
 * This is a defense-in-depth filter at the server boundary. The real fix has
 * to happen inside the CLI harness (we can't reach that code), so we sanitize
 * on the way in.
 *
 * Behavior:
 *   - Removes well-formed `<tag>…</tag>` blocks for the known set of harness
 *     tag names (multiline, ungreedy).
 *   - Also removes a final unclosed `<tag>` … run-to-end-of-input — because
 *     the leaked content sometimes truncates mid-block, and leaving a stray
 *     open tag in stored content is worse than dropping the tail.
 *   - Returns `{ cleaned, removed }` so the caller can log which marker
 *     names were stripped (useful for tracking which model/CLI is leaking).
 *   - Trims trailing whitespace introduced by the removal but does NOT
 *     touch any other content.
 */
export interface HarnessMarkerStripResult {
  cleaned: string;
  removed: string[];
}

const HARNESS_TAG_NAMES = [
  'system-reminder',
  'command-message',
  'command-args',
  'command-name',
  'local-command-stdout',
  'local-command-stderr',
  'user-prompt-submit-hook',
] as const;

export function stripHarnessMarkers(input: string | null | undefined): HarnessMarkerStripResult {
  const text = input ?? '';
  if (typeof text !== 'string' || text.length === 0) {
    return { cleaned: text ?? '', removed: [] };
  }
  // Cheap pre-check — skip the regex pipeline entirely for the common
  // marker-free case (every legitimate comment, description, chat msg).
  if (!text.includes('<')) return { cleaned: text, removed: [] };
  let out = text;
  const removed: string[] = [];
  for (const tag of HARNESS_TAG_NAMES) {
    // Closed block: <tag …>…</tag>. The opening tag may carry attributes
    // (rare for the harness, but cheap to allow) and the inner content can
    // span newlines.
    const closedRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, 'gi');
    if (closedRe.test(out)) {
      out = out.replace(closedRe, '');
      removed.push(tag);
    }
    // Unclosed trailing block: <tag …>…(EOF). Anchored at end so an
    // unrelated `<tag>` earlier in the body that the model paired up
    // properly is untouched by this fallback — it'd have been caught
    // above. Matches greedy to end of string.
    const openTailRe = new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`, 'i');
    if (openTailRe.test(out)) {
      out = out.replace(openTailRe, '');
      if (!removed.includes(tag)) removed.push(tag);
    }
  }
  // Same-shape trailing whitespace collapse the model would have left behind.
  // We don't touch leading whitespace — that could be a deliberate code-block
  // indent in the comment body.
  if (removed.length > 0) {
    out = out.replace(/\s+$/, '');
  }
  return { cleaned: out, removed };
}

/**
 * Convenience wrapper for the common "sanitize this MCP arg, log if anything
 * was stripped" pattern. Returns the cleaned string. `logger` and
 * `fieldName` are optional — passing them lets the server keep an audit
 * trail of which tool / which arg leaked harness text from which agent.
 */
export interface SanitizeOpts {
  logger?: { warn: (category: string, message: string) => void };
  toolName?: string;
  fieldName?: string;
  agentId?: string;
}

export function sanitizeHarnessMarkers(input: string | null | undefined, opts: SanitizeOpts = {}): string {
  const { cleaned, removed } = stripHarnessMarkers(input);
  if (removed.length > 0 && opts.logger) {
    const tool = opts.toolName ?? 'mcp';
    const field = opts.fieldName ?? 'content';
    const who = opts.agentId ? ` agent=${opts.agentId.slice(0, 8)}` : '';
    opts.logger.warn(
      'MCP',
      `sanitizer: stripped harness markers from ${tool}.${field}${who} — tags=[${removed.join(',')}]`,
    );
  }
  return cleaned;
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
