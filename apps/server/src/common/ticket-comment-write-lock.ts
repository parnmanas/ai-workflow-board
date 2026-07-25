import { EntityManager } from 'typeorm';
import { Ticket } from '../entities/Ticket';

/**
 * Serialize comment writes and the silent-exit audit on the ticket row.
 *
 * Postgres/MySQL need an explicit row lock because their transactions may use
 * different pooled connections. sql.js has one connection, so the surrounding
 * transaction is already the serialization boundary and does not support
 * TypeORM's pessimistic lock mode.
 */
export async function lockTicketCommentWrites(
  manager: EntityManager,
  ticketId: string,
): Promise<void> {
  const driver = manager.connection.options.type;
  await manager.getRepository(Ticket).findOne({
    where: { id: ticketId },
    ...(driver === 'postgres' || driver === 'mysql'
      ? { lock: { mode: 'pessimistic_write' as const } }
      : {}),
  });
}
