import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual } from 'typeorm';
import { TicketCompletionVerification } from '../../entities/TicketCompletionVerification';
import { LogService } from '../../services/log.service';
import { TriggerLoopService } from './trigger-loop.service';

const SWEEP_MS = 60_000;
const LEASE_MS = 10 * 60_000;

/**
 * not_before 도래, 프로세스 재시작, 실패 재시도를 하나의 DB 기반 작업 원장으로
 * 복구한다. next_dispatch_at 조건부 갱신이 임대 역할을 하므로 여러 인스턴스나
 * 중복 tick도 같은 조건을 동시에 완료 처리하지 않는다.
 */
@Injectable()
export class CompletionVerificationResumeService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly triggerLoop: TriggerLoopService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    const sweep = () => this.runOnce().catch(error => {
      this.logService.error('CompletionVerification', '완료 검증 재개 스윕 실패', { error: String(error) });
    });
    this.timer = setInterval(() => void sweep(), SWEEP_MS);
    this.timer.unref?.();
    void sweep();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(now = new Date()): Promise<{ claimed: string[] }> {
    if (this.sweeping) return { claimed: [] };
    this.sweeping = true;
    try {
      const repo = this.dataSource.getRepository(TicketCompletionVerification);
      const due = await repo.find({
        where: [
          { status: 'pending', next_dispatch_at: LessThanOrEqual(now) },
          { status: 'failed', next_dispatch_at: LessThanOrEqual(now) },
        ],
        order: { next_dispatch_at: 'ASC' },
        take: 100,
      });
      const claimed: string[] = [];
      for (const row of due) {
        const leasedUntil = new Date(now.getTime() + LEASE_MS);
        const result = await repo.createQueryBuilder().update()
          .set({ next_dispatch_at: leasedUntil, last_dispatched_at: now, dispatch_count: () => 'dispatch_count + 1' })
          .where('id = :id AND next_dispatch_at <= :now AND status IN (:...statuses)', {
            id: row.id, now, statuses: ['pending', 'failed'],
          })
          .execute();
        if (!result.affected) continue;
        claimed.push(row.id);
        try {
          await this.triggerLoop.dispatchCurrentColumn(row.ticket_id, 'completion_verification_due', 'system');
        } catch (error) {
          // 임대 만료 후 다시 실행된다. 여기서 행을 되돌리면 장애 루프가 과열된다.
          this.logService.warn('CompletionVerification', '완료 검증 재디스패치 실패', {
            verification_id: row.id, ticket_id: row.ticket_id, error: String(error),
          });
        }
      }
      return { claimed };
    } finally {
      this.sweeping = false;
    }
  }
}
