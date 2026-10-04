import type { DataSource, EntityManager } from 'typeorm';
import { Comment } from '../../entities/Comment';
import { UserMention } from '../../entities/UserMention';
import type { Ticket } from '../../entities/Ticket';

/**
 * The humans who follow a ticket. Tickets have no reporter / assignee / reviewer
 * user roles anymore — the assignee is an agent (docs/tickets.md) — so the
 * people to tell about a ticket are whoever filed it, plus every user who
 * commented on it or was @-mentioned on it. Shared by the Discord channel
 * broadcast (NotificationService) and the per-user channels
 * (UserChannelDispatcherService) so both ping the same people.
 */
export async function ticketParticipantUserIds(
  scope: Pick<DataSource, 'getRepository'> | Pick<EntityManager, 'getRepository'>,
  ticket: Pick<Ticket, 'id' | 'created_by_type' | 'created_by_id'>,
): Promise<string[]> {
  const ids = new Set<string>();
  if (ticket.created_by_type === 'user' && ticket.created_by_id) ids.add(ticket.created_by_id);

  const commenters = await scope.getRepository(Comment)
    .createQueryBuilder('c')
    .select('DISTINCT c.author_id', 'id')
    .where('c.ticket_id = :ticketId', { ticketId: ticket.id })
    .andWhere('c.author_type = :type', { type: 'user' })
    .getRawMany<{ id: string }>();
  for (const row of commenters) if (row.id) ids.add(String(row.id));

  const mentioned = await scope.getRepository(UserMention)
    .createQueryBuilder('m')
    .select('DISTINCT m.user_id', 'id')
    .where('m.ticket_id = :ticketId', { ticketId: ticket.id })
    .getRawMany<{ id: string }>();
  for (const row of mentioned) if (row.id) ids.add(String(row.id));

  return [...ids];
}
