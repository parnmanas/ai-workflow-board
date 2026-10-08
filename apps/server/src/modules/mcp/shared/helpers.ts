import { ARTIFACT_REF_DOC, ArtifactRefType, formatArtifactRef } from '../../../common/artifact-ref';

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

/** Add the canonical, copy-ready user-visible reference to an MCP entity row. */
export function withArtifactRef<T extends Record<string, any>>(
  type: ArtifactRefType,
  entity: T,
  displayName: string,
): T & { _ref: string } {
  return { ...entity, _ref: formatArtifactRef(type, String(entity.id), displayName) };
}

/**
 * Standard MCP tool error shape.
 */
export function err(message: string, details?: Record<string, unknown>) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ error: message, ...details }),
    }],
    isError: true,
  };
}

/**
 * Strip ephemeral harness markers that a Claude / Codex / Antigravity CLI subagent
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
  '  • `@[user:<uuid>|Alice]`          — mention a workspace user; writes UserMention row + fires user_mention SSE\n' +
  '  • `@[agent:<rt-key>|Worker]`      — mention an agent by its runtime identity key (`rt-…`). On a ticket only the ' +
  'ticket\'s assignee (`assignee_key` from `get_ticket`) can be woken this way; in a chat room, a participant agent. ' +
  'Agent-to-agent mentions from your own messages DO wake the target (same as a user mentioning them). ' +
  '`rt-…` keys dispatch reliably; a legacy/host agent UUID reaches only a KNOWN room participant (best-effort — ' +
  'it works when the target\'s manager hosts that identity, otherwise it is silently ignored). ' +
  'Copy the exact token from `list_chat_room_participants` instead of guessing it.\n' +
  'Role shortcuts (`@[role:…]`) no longer exist — they render as plain text and notify nobody. ' +
  'Resolve ids with `list_users` / `get_ticket` / `list_chat_room_participants` first. The `|Display Name` segment is optional but recommended — ' +
  'it\'s what humans read in the UI. A mention of yourself is dropped server-side, so it never wakes you in a loop. ' +
  'Discussion threading: reply with `parent_id` set to the comment you are answering (type `note`/`chat`) so a ' +
  'discussion stays one thread.\n\n' +
  ARTIFACT_REF_DOC;
