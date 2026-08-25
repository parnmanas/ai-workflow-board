import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { Comment } from '../../../entities/Comment';
import { TicketCompletionVerification } from '../../../entities/TicketCompletionVerification';
import { TicketCompletionVerificationAttempt } from '../../../entities/TicketCompletionVerificationAttempt';
import { ok, err } from '../shared/helpers';
import type { ToolContext } from './context';
import { lockTicketForCompletionVerification } from '../shared/completion-verification-gate';
import { BoardColumn } from '../../../entities/BoardColumn';

const EvidenceSchema = z.object({
  summary: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
});

export function registerCompletionVerificationTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource } = ctx;

  server.tool(
    'register_completion_verification',
    '티켓이 terminal 컬럼으로 이동하기 전에 반드시 통과해야 하는 durable 완료조건을 등록합니다. ticket_id와 dedupe_key 조합은 멱등적입니다.',
    {
      ticket_id: z.string(),
      dedupe_key: z.string().min(1).max(160),
      description: z.string().min(1),
      not_before: z.string().datetime().optional(),
    },
    async ({ ticket_id, dedupe_key, description, not_before }) => {
      try {
        const row = await dataSource.transaction(async manager => {
          const ticket = await lockTicketForCompletionVerification(manager, ticket_id);
          const column = ticket.column_id
            ? await manager.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } })
            : null;
          // 늦은 등록 정책: 이미 terminal인 티켓에는 조건을 붙이지 않는다. 재개될
          // 수 없는 pending 행을 만드는 대신 먼저 명시적으로 티켓을 reopen해야 한다.
          if (column?.kind === 'terminal' || column?.is_terminal === true) {
            throw new Error('terminal 티켓에는 완료 검증을 늦게 등록할 수 없습니다. 먼저 티켓을 명시적으로 다시 여세요');
          }
          const repo = manager.getRepository(TicketCompletionVerification);
          const due = not_before ? new Date(not_before) : new Date();
          await repo.createQueryBuilder().insert().values({
            ticket_id,
            dedupe_key,
            description,
            not_before: not_before ? due : null,
            next_dispatch_at: due,
          }).orIgnore().execute();
          return repo.findOneOrFail({ where: { ticket_id, dedupe_key } });
        });
        return ok(row);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );

  server.tool(
    'record_completion_verification',
    'durable 완료조건의 실행 증거와 판정을 기록합니다. attempt_key는 재시도/중복 전달에서 한 번만 반영됩니다. failed는 Done 게이트를 계속 닫고, passed만 조건을 완료합니다.',
    {
      ticket_id: z.string(),
      dedupe_key: z.string().min(1).max(160),
      attempt_key: z.string().min(1).max(160),
      status: z.enum(['passed', 'failed']),
      evidence: EvidenceSchema,
    },
    async ({ ticket_id, dedupe_key, attempt_key, status, evidence }) => {
      try {
        const result = await dataSource.transaction(async manager => {
          await lockTicketForCompletionVerification(manager, ticket_id);
          const verificationRepo = manager.getRepository(TicketCompletionVerification);
          const attemptRepo = manager.getRepository(TicketCompletionVerificationAttempt);
          const commentRepo = manager.getRepository(Comment);
          const verification = await verificationRepo.findOne({ where: { ticket_id, dedupe_key } });
          if (!verification) throw new Error('Completion verification not found');
          if (verification.not_before && verification.not_before.getTime() > Date.now()) {
            throw new Error(`Verification cannot run before ${verification.not_before.toISOString()}`);
          }

          const candidateAttemptId = randomUUID();
          await attemptRepo.createQueryBuilder().insert().values({
            id: candidateAttemptId,
            verification_id: verification.id,
            attempt_key,
            status,
            evidence: JSON.stringify(evidence),
          }).orIgnore().execute();
          const attempt = await attemptRepo.findOneOrFail({
            where: { verification_id: verification.id, attempt_key },
          });
          if (attempt.id !== candidateAttemptId) return { verification, attempt, duplicate: true };
          verification.status = status;
          verification.attempt_count += 1;
          verification.evidence = JSON.stringify(evidence);
          verification.completed_at = status === 'passed' ? new Date() : null;
          verification.next_dispatch_at = status === 'passed'
            ? null
            : new Date(Date.now() + Math.min(60 * 60_000, 60_000 * 2 ** Math.min(verification.attempt_count, 6)));
          await verificationRepo.save(verification);

          // 판정과 사람이 읽을 수 있는 증거를 한 트랜잭션에 묶어 상태만 완료되고
          // 감사 흔적이 빠지는 크래시 창을 없앤다.
          await commentRepo.save(commentRepo.create({
            ticket_id,
            author_type: 'system',
            author: 'CompletionVerification',
            content: `[durable 검증:${dedupe_key}] ${status} — ${evidence.summary}`,
            type: 'note',
            metadata: JSON.stringify({
              completion_verification_id: verification.id,
              completion_verification_attempt_id: attempt.id,
              attempt_key,
              status,
              evidence,
            }),
          }));
          return { verification, attempt, duplicate: false };
        });
        return ok(result);
      } catch (error) {
        return err(error instanceof Error ? error.message : String(error));
      }
    },
  );
}
