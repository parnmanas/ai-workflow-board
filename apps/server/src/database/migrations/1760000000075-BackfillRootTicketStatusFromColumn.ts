import { MigrationInterface, QueryRunner } from 'typeorm';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';

/**
 * Backfill: re-derive every ROOT ticket's `status` from its current column's
 * terminal/non-terminal meaning (ticket 35b43ee9).
 *
 * Why: before this ticket's fix, `status` was written once at create time
 * (hardcoded/default 'todo', ignoring the destination column) and only
 * touched on a move that crossed the terminal boundary — a ticket already
 * sitting in a terminal column with `status='todo'` (or, symmetrically, a
 * non-terminal column with `status='done'`) stayed wrong forever unless it
 * happened to cross the boundary again. The concrete example that surfaced
 * this ticket: a Done ticket whose `status` still read 'todo' with no move
 * left to re-sync it. The runtime fix (archive-helpers.ts
 * `applyTerminalEnteredAtForMove`) now re-derives `status` on every move,
 * boundary-crossing or not, so any ticket that moves again self-heals — but
 * that does nothing for a ticket that never moves again. This migration
 * heals every existing row in one pass.
 *
 * Scope: root tickets only (`parent_id IS NULL`) — matches
 * `deriveRootTicketStatus`'s documented scope. Child/subtask status is
 * independent and untouched here, exactly as the runtime helper leaves it.
 *
 * Invariants (matching 1760000000020 / 1760000000051):
 * - DATA only, no DDL. Repository API, portable across sqlite/mysql/postgres.
 * - Idempotent — a row whose status already matches its column is untouched;
 *   re-running touches zero rows.
 * - A root ticket whose `column_id` doesn't resolve to an existing column
 *   (orphan FK) is treated as non-terminal ('todo') — mirrors
 *   `deriveRootTicketStatus(null)`'s fail-open default.
 *
 * down() is a no-op — there is no faithful inverse without an audit log of
 * the prior (divergent) value.
 */
export class BackfillRootTicketStatusFromColumn1760000000075 implements MigrationInterface {
  name = 'BackfillRootTicketStatusFromColumn1760000000075';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const ticketRepo = manager.getRepository(Ticket);
    const columnRepo = manager.getRepository(BoardColumn);

    const columns = await columnRepo.find();
    const terminalByColumnId = new Map<string, boolean>();
    for (const col of columns) {
      terminalByColumnId.set(col.id, (col as any).is_terminal === true || (col as any).kind === 'terminal');
    }

    // Filtering to roots in JS (rather than a `parent_id: null` where-clause)
    // keeps this portable — no raw IS NULL, same approach as
    // 1760000000020's full-table scan-and-check.
    const allTickets = await ticketRepo.find();
    let updated = 0;
    for (const t of allTickets) {
      if (t.parent_id) continue;
      const isTerminal = t.column_id ? (terminalByColumnId.get(t.column_id) ?? false) : false;
      const expected = isTerminal ? 'done' : 'todo';
      if (t.status !== expected) {
        await ticketRepo.update(t.id, { status: expected });
        updated++;
      }
    }

    if (updated > 0) {
      // eslint-disable-next-line no-console
      console.log(`[Migration] BackfillRootTicketStatusFromColumn: re-derived status on ${updated} root ticket row(s)`);
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // No faithful inverse — see header.
  }
}
