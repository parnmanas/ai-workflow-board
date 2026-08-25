import type { DataSource, EntityManager } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { Ticket } from '../../../entities/Ticket';
import { TicketCompletionVerification } from '../../../entities/TicketCompletionVerification';

type RepoScope = DataSource | EntityManager;

/**
 * 완료 검증의 등록·판정·terminal 전이가 공유하는 티켓 단위 직렬화 경계다.
 * 운영 DB에서는 Ticket 행을 FOR UPDATE로 잠근다. sql.js는 단일 연결에서
 * transaction 자체가 직렬화되며 행 잠금을 지원하지 않으므로 평범한 조회를 쓴다.
 */
export async function lockTicketForCompletionVerification(
  manager: EntityManager,
  ticketId: string,
): Promise<Ticket> {
  const repo = manager.getRepository(Ticket);
  const driver = manager.connection.options.type;
  const query = repo.createQueryBuilder('ticket').where('ticket.id = :ticketId', { ticketId });
  if (driver !== 'sqljs' && driver !== 'sqlite' && driver !== 'better-sqlite3') {
    query.setLock('pessimistic_write');
  }
  const ticket = await query.getOne();
  if (!ticket) throw new Error('티켓을 찾을 수 없습니다');
  return ticket;
}

export async function getIncompleteCompletionVerifications(scope: RepoScope, ticketId: string) {
  return scope.getRepository(TicketCompletionVerification).find({
    where: [
      { ticket_id: ticketId, status: 'pending' },
      { ticket_id: ticketId, status: 'failed' },
    ],
    order: { created_at: 'ASC' },
  });
}

export async function assertCompletionVerificationsPassed(
  scope: EntityManager,
  ticketId: string,
  destination: BoardColumn | null | undefined,
): Promise<void> {
  if (destination?.kind !== 'terminal' && destination?.is_terminal !== true) return;
  await lockTicketForCompletionVerification(scope, ticketId);
  const incomplete = await getIncompleteCompletionVerifications(scope, ticketId);
  if (incomplete.length > 0) throw new CompletionVerificationRequiredError(ticketId, incomplete);
}

export class CompletionVerificationRequiredError extends Error {
  status = 409;
  code = 'completion_verification_required';
  hint = 'record_completion_verification으로 모든 durable 완료조건을 passed 처리한 뒤 다시 이동하세요.';

  constructor(ticketId: string, rows: TicketCompletionVerification[]) {
    super(
      `Ticket ${ticketId}에는 완료되지 않은 durable 검증 ${rows.length}건이 있어 terminal 컬럼으로 이동할 수 없습니다: ` +
      rows.map(row => `${row.dedupe_key}(${row.status})`).join(', '),
    );
    this.name = 'CompletionVerificationRequiredError';
  }
}
