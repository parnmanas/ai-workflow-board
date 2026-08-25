import type { DataSource, EntityManager } from 'typeorm';
import { BoardColumn } from '../../../entities/BoardColumn';
import { TicketCompletionVerification } from '../../../entities/TicketCompletionVerification';

type RepoScope = DataSource | EntityManager;

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
  scope: RepoScope,
  ticketId: string,
  destination: BoardColumn | null | undefined,
): Promise<void> {
  if (destination?.kind !== 'terminal' && destination?.is_terminal !== true) return;
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
