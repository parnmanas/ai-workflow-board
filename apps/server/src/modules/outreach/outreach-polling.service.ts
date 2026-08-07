/**
 * OutreachPollingService — the tick loop over OutreachChannel (ticket 2500fea3
 * D2). Background-loop shape mirrors QaScheduleService exactly (which itself
 * mirrors QaRunReaperService): a plain unref'd setInterval planted in
 * OnModuleInit, torn down in OnModuleDestroy, with an env on/off switch and a
 * clamped cadence, and `runOnce(now)` exposed as the deterministic test seam.
 *
 * D2 rejected WorkspaceSchedule/Action cron for this: both hard-code their
 * dispatch as "create a chat room → seat an agent → sendMessage", with no path
 * to call a plain deterministic server method — which is what a fast,
 * cursor-based, unit-testable poll needs (this is the SAME reason
 * QaSchedule/SecuritySchedule roll their own tick loop instead of reusing
 * those two). So OutreachChannel carries its own cursor columns directly
 * (poll_interval_ms/poll_cron/next_poll_at/last_poll_at) rather than pointing
 * at a WorkspaceSchedule row, and this service's ONLY job is scheduling —
 * every actual poll is one call to OutreachIngestService.pollChannel.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, LessThanOrEqual, Repository } from 'typeorm';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { Credential } from '../../entities/Credential';
import { LogService } from '../../services/log.service';
import { OutreachIngestService } from './outreach-ingest.service';
import { resolveOutreachCredential } from './outreach-credential';
import { FakeOutreachConnector } from './connectors/fake.connector';
import { OutreachConnector } from './connectors/types';
import { nextCronAfter } from '../qa/qa-cron';

const DEFAULT_TICK_MS = 30_000;        // 30s — same default as QaScheduleService
const MIN_TICK_MS = 5_000;             // 5s
const MAX_TICK_MS = 60 * 60_000;       // 1h
const TICK_BATCH = 100;                // max channels polled per tick
const DEFAULT_POLL_INTERVAL_MS = 3_600_000; // 1h — matches OutreachChannel.poll_interval_ms's column default

function clampEnv(name: string, def: number, min: number, max: number): number {
  const raw = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return def;
  return Math.min(max, Math.max(min, raw));
}

@Injectable()
export class OutreachPollingService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly tickMs = clampEnv('OUTREACH_SCHEDULER_TICK_MS', DEFAULT_TICK_MS, MIN_TICK_MS, MAX_TICK_MS);
  private readonly enabled = (process.env.OUTREACH_SCHEDULER_ENABLED || 'true').toLowerCase() !== 'false';

  constructor(
    @InjectRepository(OutreachChannel) private readonly channelRepo: Repository<OutreachChannel>,
    @InjectRepository(Credential) private readonly credentialRepo: Repository<Credential>,
    private readonly ingestService: OutreachIngestService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled) {
      this.logService.info('OutreachScheduler', 'disabled via OUTREACH_SCHEDULER_ENABLED=false');
      return;
    }
    this.tickHandle = setInterval(() => {
      this.runOnce().catch((e: unknown) => {
        this.logService.error('OutreachScheduler', 'tick failed', { err: String(e) });
      });
    }, this.tickMs);
    // Don't keep the event loop alive on the timer alone (mirrors QaScheduleService).
    this.tickHandle.unref?.();
    this.logService.info('OutreachScheduler', 'Service initialized', { tick_ms: this.tickMs });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * One scheduler sweep. Public so a test / operator endpoint can drive it
   * deterministically (mirrors QaScheduleService.runOnce). Returns the
   * channel ids polled vs. the ones whose poll failed this tick.
   */
  async runOnce(now: Date = new Date()): Promise<{ polled: string[]; failed: string[] }> {
    const polled: string[] = [];
    const failed: string[] = [];

    // Self-heal: an enabled channel with a null next_poll_at (legacy row /
    // cadence edited while disabled) gets its cursor computed forward —
    // without polling, so enabling never causes a surprise immediate poll.
    const orphans = await this.channelRepo.find({ where: { enabled: true, next_poll_at: IsNull() } });
    for (const c of orphans) {
      c.next_poll_at = this.computeNextPoll(c, now);
      await this.channelRepo.save(c);
    }

    const due = await this.channelRepo.find({
      where: { enabled: true, next_poll_at: LessThanOrEqual(now) },
      order: { next_poll_at: 'ASC' },
      take: TICK_BATCH,
    });

    for (const channel of due) {
      try {
        // Advance the cursor + persist BEFORE the (slow, async) poll so a
        // duplicate/overlapping tick sees next_poll_at already moved and
        // no-ops — same idempotency ordering QaScheduleService.runOnce uses.
        channel.next_poll_at = this.computeNextPoll(channel, now);
        await this.channelRepo.save(channel);

        const connector = await this._resolveConnector(channel);
        await this.ingestService.pollChannel(channel, connector, now);
        polled.push(channel.id);
      } catch (e: any) {
        // A bad channel (revoked credential, connector error) must not stall
        // the sweep. next_poll_at is already advanced, so it retries next
        // occurrence rather than spinning on the same failure every tick.
        failed.push(channel.id);
        this.logService.warn('OutreachScheduler', 'channel poll failed (continuing)', {
          channel_id: channel.id, err: e?.message || String(e),
        });
      }
    }

    if (polled.length || failed.length) {
      this.logService.info('OutreachScheduler', 'sweep done', { polled: polled.length, failed: failed.length });
    }
    return { polled, failed };
  }

  /** Next firing instant. Unlike QaSchedule's cron/interval_ms pair, this is
   *  never null — a disabled channel is excluded from the due query by
   *  `enabled=false` rather than by clearing this column. `poll_cron`
   *  optionally overrides `poll_interval_ms`; falling back to the column
   *  default (1h) only guards a malformed row, not a real "unset" state. */
  computeNextPoll(channel: Pick<OutreachChannel, 'poll_cron' | 'poll_interval_ms'>, from: Date): Date {
    if (channel.poll_cron) {
      const next = nextCronAfter(channel.poll_cron, from);
      if (next) return next;
    }
    const intervalMs = channel.poll_interval_ms && channel.poll_interval_ms > 0
      ? channel.poll_interval_ms
      : DEFAULT_POLL_INTERVAL_MS;
    return new Date(from.getTime() + intervalMs);
  }

  /** Reddit/GitHub real connectors are follow-up tickets (ticket 2500fea3
   *  scope) — every channel kind resolves to the same in-memory fake today.
   *  Credential resolution happens HERE, outside the connector (D1): the
   *  connector receives an already-resolved token, never a credential_id —
   *  and this also fails the poll fast (surfaced via `failed`, retried next
   *  occurrence) when a credential was revoked or its workspace scope no
   *  longer matches, instead of the connector silently running unauthenticated. */
  private async _resolveConnector(channel: OutreachChannel): Promise<OutreachConnector> {
    await resolveOutreachCredential(this.credentialRepo, channel.credential_id, channel.workspace_id);
    return new FakeOutreachConnector();
  }
}
