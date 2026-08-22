import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { LogService } from '../../services/log.service';
import { CliLoginSessionService } from './cli-login-session.service';

const SWEEP_INTERVAL_MS = 60_000;
// 매니저 자체 타임아웃(10분)보다 여유를 둬 정상 완료 직전 세션을 오탐하지
// 않도록 한다 — 매니저 크래시/네트워크 단절로 progress POST가 영영 오지
// 않는 경우에 대한 백스톱.
const MAX_AGE_MS = 12 * 60_000;

/**
 * QaRunReaperService와 동일한 패턴(OnModuleInit + setInterval, 즉시 1회
 * 스윕 후 주기 반복) — 매니저가 죽거나 네트워크가 끊겨 cli_login_start 이후
 * 아무 progress도 보고하지 않는 세션을 회수해 timed_out으로 마감한다.
 */
@Injectable()
export class CliLoginSessionReaperService implements OnModuleInit, OnModuleDestroy {
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessions: CliLoginSessionService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    void this.runOnce();
    this.#timer = setInterval(() => void this.runOnce(), SWEEP_INTERVAL_MS);
    this.#timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  async runOnce(): Promise<number> {
    try {
      const reaped = await this.sessions.reapStale(MAX_AGE_MS);
      if (reaped > 0) {
        this.logService.warn(
          'Credentials',
          `CliLoginSessionReaperService: reaped ${reaped} stale login session(s)`,
        );
      }
      return reaped;
    } catch (err: any) {
      this.logService.error('Credentials', `CliLoginSessionReaperService sweep failed: ${err?.message ?? err}`);
      return 0;
    }
  }
}
