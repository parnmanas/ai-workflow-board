/**
 * OutreachResolveNotifierService — replies on the ORIGINAL external
 * thread/comment when the ticket it produced reaches Done (ticket d86d0c24
 * step 8, ticket body item 5: "역링크가 있는 티켓이 Done(terminal)에 도달하면
 * 원 Reddit 스레드에 처리 완료 답글을 남긴다").
 *
 * Subscribes to the SAME `activityEvents` 'activity' stream OnTicketDoneActionService
 * and QaRerunOnFixService already listen on — a separate listener, not a call
 * inside either of those services, so this module takes no dependency on the
 * actions/QA modules and vice versa (same reasoning those two files document).
 *
 * Idempotency anchor is DELIBERATELY NOT `Ticket.on_done_dispatched_at` (Plan
 * correction C3): that column is a single claim shared with
 * OnTicketDoneActionService's own atomic UPDATE — a second listener claiming
 * the SAME column would race it and steal its dispatch (and vice versa) on a
 * ticket that happens to carry both a bound Action AND an outreach backlink.
 * Instead, idempotency rides `OutreachOutboundPost`'s pre-existing
 * `(channel_id, dedupe_key)` unique index with `dedupe_key = "resolve:{item.id}"`
 * — the exact same claim-before-side-effect discipline
 * OutreachPublisherService's deploy path uses. A duplicate 'moved' activity
 * (re-entry, a second listener firing, a retried event) just hits the unique
 * constraint on INSERT and is absorbed as already-processed; no ticket column
 * is ever touched, so this can never starve or be starved by the on-done hook.
 *
 * Gate: `OutreachChannel.publish_policy` — the SAME field the deploy path
 * gates on (ticket body item 5: "이 발화도 위 승인 게이트 정책을 따른다").
 * NOT gated by `deploy_post_mode` — that field only controls whether/how a
 * DEPLOY announces itself; a resolution reply is a different kind of post
 * ('resolve') with its own row, independent of whether deploy announcements
 * are even turned on for the channel.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { OutreachOutboundPost } from '../../entities/OutreachOutboundPost';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { OutreachPublisherService } from './outreach-publisher.service';
import { BOT_DISCLOSURE_FOOTER } from './release-summary';

function isUniqueConstraintError(error: unknown): boolean {
  const value = error as {
    code?: string;
    errno?: number;
    message?: string;
    driverError?: { code?: string; errno?: number; message?: string };
  } | null;
  const driverError = value?.driverError;
  const code = driverError?.code ?? value?.code;
  const errno = driverError?.errno ?? value?.errno;
  const message = driverError?.message ?? value?.message ?? '';
  return code === '23505'
    || code === 'SQLITE_CONSTRAINT_UNIQUE'
    || code === 'ER_DUP_ENTRY'
    || errno === 1062
    || /unique constraint failed/i.test(message);
}

@Injectable()
export class OutreachResolveNotifierService implements OnModuleInit, OnModuleDestroy {
  private _activityListener?: (log: ActivityLog) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisherService: OutreachPublisherService,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('Outreach', 'OutreachResolveNotifierService _handleActivity error', { err: String(e) });
      });
    };
    activityEvents.on('activity', this._activityListener);
  }

  onModuleDestroy(): void {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
  }

  private async _handleActivity(log: ActivityLog): Promise<void> {
    // Only column moves can land a ticket on a terminal column.
    if (log.action !== 'moved' || !log.ticket_id) return;

    const ticketRepo = this.dataSource.getRepository(Ticket);
    const ticket = await ticketRepo.findOne({ where: { id: log.ticket_id } });
    if (!ticket || !ticket.column_id) return;

    const col = await this.dataSource.getRepository(BoardColumn).findOne({ where: { id: ticket.column_id } });
    if (!isTerminalColumn(col)) return;
    if (!ticket.terminal_entered_at) return;

    // Backlink lookup — a ticket with no outreach-origin item is simply
    // irrelevant to this hook (완료기준: "역링크 없는 티켓 무반응").
    const items = await this.dataSource.getRepository(OutreachInboundItem).find({ where: { ticket_id: ticket.id } });
    if (items.length === 0) return;

    for (const item of items) {
      try {
        await this._notifyItem(item, ticket);
      } catch (e: any) {
        this.logService.warn('Outreach', 'resolve notify failed for backlinked item (continuing)', {
          item_id: item.id, ticket_id: ticket.id, err: e?.message || String(e),
        });
      }
    }
  }

  private async _notifyItem(item: OutreachInboundItem, ticket: Ticket): Promise<void> {
    const channel = await this.dataSource.getRepository(OutreachChannel).findOne({ where: { id: item.channel_id } });
    if (!channel) return; // channel deleted since the item was collected — nothing to reply on.
    if (channel.publish_policy === ('off' as any)) return; // channel-wide outreach kill switch — no ledger row.

    const dedupeKey = `resolve:${item.id}`;
    const postRepo = this.dataSource.getRepository(OutreachOutboundPost);

    let claimed: OutreachOutboundPost;
    try {
      claimed = await postRepo.save(postRepo.create({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        dedupe_key: dedupeKey,
        kind: 'resolve',
        status: 'draft',
        target: '',
        title: '',
        body: this._buildResolveBody(ticket),
        thread_ref: item.external_item_id,
        source_ticket_id: ticket.id,
        source_item_id: item.id,
      }));
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        // Already claimed by a prior 'moved' event for this SAME item — the
        // ledger key is the idempotency anchor (see class docstring, C3).
        return;
      }
      throw e;
    }

    if (channel.publish_policy !== 'auto') {
      // 'approval' — left as a draft for a human; connector is NEVER called.
      this.logService.info('Outreach', 'resolve reply draft created, awaiting approval', {
        channel_id: channel.id, post_id: claimed.id, ticket_id: ticket.id,
      });
      return;
    }

    await this.publisherService.executeClaim(channel, claimed);
  }

  private _buildResolveBody(ticket: Ticket): string {
    return [
      `This has been resolved: "${ticket.title}"`,
      '',
      BOT_DISCLOSURE_FOOTER,
    ].join('\n');
  }
}
