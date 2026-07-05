/**
 * Deferral-to-terminal guard (ticket 9f2adfd0).
 *
 * A review / merge / handoff comment often defers scope to another ticket
 * ("tracked in <id>", "→ INV-6", "EPIC 트랙과 함께 이관"). When the referenced
 * ticket is already terminal (Done / archived), the deferral is void: a
 * terminal ticket is never picked up again, so the handed scope silently
 * vanishes. INV-5 (d5b53a1b) deferred its restart-persist demonstration to the
 * already-Done INV-2 (8294bc2b) TWICE (assignee handoff + reviewer LGTM),
 * orphaning the shipped persistence feature until this guard + INV-6 recovered
 * it.
 *
 * This is the NON-BLOCKING sibling of the terminal-reopen / gate-cascade
 * guards. Those BLOCK a structural move; this only FLAGS a comment — a comment
 * is discussion, and hard-rejecting it for merely naming a Done ticket would be
 * wrong and false-positive prone. The warning is surfaced back to the deferring
 * agent at post time (the exact moment they can fix it by opening a live
 * ticket) and persisted on the comment metadata so future readers see the flag.
 *
 * Pure + dependency-free so it unit-tests without a DataSource: the caller
 * injects a `resolve(token)` that maps a ticket-id token to its terminal state.
 */

/**
 * Deferral-intent phrases (English + Korean), matched case-insensitively as
 * substrings. A phrase alone never triggers a warning — a resolved TERMINAL
 * ticket id must also appear within `window` characters of the phrase
 * (see `referencedUnderDeferral`), which keeps ordinary "함께 확인" / "move to
 * the left" prose from firing.
 */
export const DEFERRAL_KEYWORDS: readonly string[] = [
  'defer',
  'tracked in',
  'track in',
  'tracking in',
  'tracked by',
  'follow-up',
  'followup',
  'follow up',
  'moved to',
  'move to',
  'rolled into',
  'roll into',
  'absorb',
  'handed to',
  'hand off',
  'handoff',
  'hand-off',
  '이관',
  '트래킹',
  '트랙',
  '후속',
  '넘김',
  '넘겨',
  '넘긴',
  '함께',
  '흡수',
  '재배정',
  '이월',
  '위임',
];

/** Terminal state of a ticket referenced as a deferral target. */
export interface DeferralTargetResolution {
  id: string;
  title: string;
  columnName: string | null;
  /** Column is terminal (Done / kind='terminal'). */
  isTerminal: boolean;
  /** Ticket.archived_at is set. */
  archived: boolean;
}

/**
 * Maps a ticket-id token (full UUID or 8-hex short id) to its terminal state,
 * or `null` when the token does not resolve to a ticket (e.g. it was actually a
 * git SHA). May be async — the DB-backed caller queries the ticket + column.
 */
export type DeferralRefResolver = (
  token: string,
) => DeferralTargetResolution | null | Promise<DeferralTargetResolution | null>;

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
// Board short-ids are exactly 8 hex (e.g. `8294bc2b`). Requiring EXACTLY 8 —
// not part of a longer hex run and not the leading group of a full UUID —
// disambiguates from the 9+/40-char git SHAs the board writes in backticks, so
// those are never mistaken for ticket ids.
const SHORT_ID_RE = /(?<![0-9a-f])[0-9a-f]{8}(?![0-9a-f-])/gi;

/** True when the content contains any deferral-intent phrase. Cheap early-out. */
export function hasDeferralIntent(content: string): boolean {
  if (!content) return false;
  const lc = content.toLowerCase();
  return DEFERRAL_KEYWORDS.some((k) => lc.includes(k));
}

/**
 * Extract candidate ticket-id tokens — full UUIDs plus bare 8-hex short ids —
 * lower-cased and deduped. The leading group of a full UUID is NOT re-emitted
 * as a short id (the lookahead rejects a trailing `-`).
 */
export function extractTicketIdCandidates(content: string): string[] {
  if (!content) return [];
  const out = new Set<string>();
  for (const m of content.matchAll(UUID_RE)) out.add(m[0].toLowerCase());
  for (const m of content.matchAll(SHORT_ID_RE)) out.add(m[0].toLowerCase());
  return [...out];
}

/**
 * Does a deferral keyword occur within `window` chars of any occurrence of
 * `token` in `content`? Proximity keeps an unrelated Done-ticket mention that
 * is NOT part of a deferral (e.g. "참고: `<id>`") from being flagged just
 * because the comment happens to contain a deferral phrase elsewhere.
 */
export function referencedUnderDeferral(content: string, token: string, window = 90): boolean {
  if (!content || !token) return false;
  const lc = content.toLowerCase();
  const t = token.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = lc.indexOf(t, from);
    if (idx === -1) return false;
    const start = Math.max(0, idx - window);
    const end = Math.min(lc.length, idx + t.length + window);
    const around = lc.slice(start, end);
    if (DEFERRAL_KEYWORDS.some((k) => around.includes(k))) return true;
    from = idx + t.length;
  }
}

/**
 * Terminal-ticket deferral targets referenced under deferral intent in a
 * comment. Empty when the comment has no deferral phrasing (cheap early-out) or
 * references no terminal ticket. Never throws for a single unresolved token — a
 * resolver returning null (or throwing) just drops that candidate, so the other
 * candidates are still evaluated.
 */
export async function detectDeferralToTerminal(
  content: string,
  resolve: DeferralRefResolver,
  opts: { window?: number; selfTicketId?: string } = {},
): Promise<DeferralTargetResolution[]> {
  if (!hasDeferralIntent(content)) return [];
  const candidates = extractTicketIdCandidates(content);
  if (candidates.length === 0) return [];

  const seen = new Set<string>();
  const out: DeferralTargetResolution[] = [];
  for (const token of candidates) {
    if (!referencedUnderDeferral(content, token, opts.window)) continue;
    let res: DeferralTargetResolution | null = null;
    try {
      res = await resolve(token);
    } catch {
      res = null;
    }
    if (!res) continue;
    if (opts.selfTicketId && res.id === opts.selfTicketId) continue;
    if (!(res.isTerminal || res.archived)) continue;
    if (seen.has(res.id)) continue;
    seen.add(res.id);
    out.push(res);
  }
  return out;
}

/** Human-readable advisory for the flagged terminal deferral targets. */
export function formatDeferralTerminalWarning(targets: DeferralTargetResolution[]): string {
  if (targets.length === 0) return '';
  const lines = targets.map((t) => {
    const state = t.archived ? 'archived' : `terminal (${t.columnName ?? 'Done'})`;
    return `  • ${t.id} "${t.title}" — ${state}`;
  });
  return (
    `⚠ Deferral-to-terminal warning: this comment appears to hand scope to ${targets.length} already-terminal ticket(s):\n` +
    lines.join('\n') +
    `\nA terminal (Done/archived) ticket is never picked up again, so any scope deferred to it silently vanishes. ` +
    `Open a NEW live ticket for the deferred work (or keep the scope on this ticket) instead of deferring to a closed one.`
  );
}
