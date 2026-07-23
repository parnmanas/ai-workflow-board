import type { Repository } from 'typeorm';
import type { Comment } from '../entities/Comment';

/**
 * One author turn in a chain, latest-first. Shared shape for the chat-room
 * chain (room-messaging.service.ts, keyed on sender_type/sender_id) and the
 * ticket-comment mention chain below (keyed on author_type/author_id) so
 * both loop guards agree on one counting rule.
 */
export interface ChainAuthorEntry {
  isAgent: boolean;
  authorKey: string;
}

/**
 * Trailing strictly-alternating agent-authorship chain length ending at the
 * latest (index 0) entry. Consecutive entries from the same author
 * consolidate into one chain "step" so a single agent's own multi-part turn
 * never inflates the counter — only genuine back-and-forth between
 * *different* agents does. Breaks on the first non-agent-authored entry
 * (user or system) walking backwards from latest.
 */
export function computeChainDepth(entriesLatestFirst: ChainAuthorEntry[]): number {
  let depth = 0;
  let prevAuthorKey: string | null = null;
  for (const entry of entriesLatestFirst) {
    if (!entry.isAgent) break;
    if (entry.authorKey !== prevAuthorKey) {
      depth++;
      prevAuthorKey = entry.authorKey;
    }
  }
  return depth;
}

// Same lookback size room-messaging.service.ts uses for the chat-room chain
// (AGENT_CHAIN_LOOKBACK) — wide enough to expose a realistic ping-pong,
// cheap enough to query on every mention dispatch.
export const TICKET_COMMENT_CHAIN_LOOKBACK = 8;

/**
 * Ticket-comment analog of room-messaging.service.ts's
 * `_computeAgentChainDepth`. Call AFTER the triggering comment is saved so
 * it is itself the latest entry — matching the chat path, where
 * `_computeAgentChainDepth` runs after the message save.
 */
export async function computeTicketCommentChainDepth(
  commentRepo: Repository<Comment>,
  ticketId: string,
): Promise<number> {
  const recent = await commentRepo.find({
    where: { ticket_id: ticketId },
    order: { created_at: 'DESC', id: 'DESC' },
    take: TICKET_COMMENT_CHAIN_LOOKBACK,
  });
  return computeChainDepth(
    recent.map((c) => ({ isAgent: c.author_type === 'agent', authorKey: c.author_id })),
  );
}
