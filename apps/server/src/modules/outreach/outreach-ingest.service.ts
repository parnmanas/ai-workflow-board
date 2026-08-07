/**
 * OutreachIngestService — the inbound feedback → ticket pipeline core (ticket
 * 2500fea3). `pollChannel` is the single entry point OutreachPollingService's
 * tick loop calls per due channel; it is also the unit this ticket's
 * completion criteria are tested against directly (stub repos + an injected
 * fake connector — no tick loop needed to exercise it).
 *
 * Per-item flow: dedupe lookup (the `(channel_id, external_item_id)` unique
 * index on OutreachInboundItem is the single source of truth — see that
 * entity's docstring) → classify → confidence gate → noise/question log-only
 * OR ticket creation. Every outcome (including 'skipped' dedupe hits) writes
 * exactly one durable signal, so a crash mid-poll can only ever under-advance
 * the cursor (safe: re-fetches and re-tries) and never double-tickets (the
 * unique index rejects a concurrent/rewound re-insert).
 *
 * Ticket creation mirrors QaFailureTicketService._createTicket (the
 * established "a background service, not an MCP tool call, creates a Ticket
 * row directly" precedent) rather than re-entering the MCP create_ticket tool,
 * which is tightly coupled to an MCP session/caller-agent context this
 * service doesn't have.
 */
import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Board } from '../../entities/Board';
import { BoardColumn } from '../../entities/BoardColumn';
import { Ticket } from '../../entities/Ticket';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachInboundItem, OutreachItemStatus } from '../../entities/OutreachInboundItem';
import { LogService } from '../../services/log.service';
import { ActivityService } from '../../services/activity.service';
import { TicketRoleAssignmentService } from '../workspace-roles/ticket-role-assignment.service';
import { maxTicketPosition } from '../mcp/shared/ticket-helpers';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { InboundItem, OutreachConnector } from './connectors/types';
import { OUTREACH_CLASSIFIER, OutreachCategory, OutreachClassifier } from './classifier/types';

export interface PollResult {
  fetched: number;
  ticketed: number;
  noise: number;
  question: number;
  held: number;
  skipped: number;
  errors: number;
}

const TICKETABLE: ReadonlySet<OutreachCategory> = new Set(['bug', 'feature_request']);

@Injectable()
export class OutreachIngestService {
  constructor(
    @InjectRepository(OutreachInboundItem) private readonly itemRepo: Repository<OutreachInboundItem>,
    @InjectRepository(OutreachChannel) private readonly channelRepo: Repository<OutreachChannel>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly roleAssignmentService: TicketRoleAssignmentService,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
    @Inject(OUTREACH_CLASSIFIER) private readonly classifier: OutreachClassifier,
  ) {}

  /**
   * Poll one channel: fetch since its cursor, classify+file every new item,
   * then persist the advanced cursor + last_poll_at. The cursor only ever
   * advances past items this call durably recorded (a dedupe skip counts —
   * it is already durably recorded from a PRIOR call); it freezes at the
   * first per-item error so a transient failure retries that item (and
   * everything after it in this batch) on the next poll instead of silently
   * losing it. Never throws for a single bad item — only a `fetchInbound`
   * failure (channel-level) propagates, which OutreachPollingService's sweep
   * catches so one broken channel can't block the others.
   */
  async pollChannel(channel: OutreachChannel, connector: OutreachConnector, now: Date = new Date()): Promise<PollResult> {
    const result: PollResult = { fetched: 0, ticketed: 0, noise: 0, question: 0, held: 0, skipped: 0, errors: 0 };
    const items = await connector.fetchInbound(channel.since_cursor || '');
    result.fetched = items.length;
    const sorted = items.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    let cursorMax = Date.parse(channel.since_cursor || '');
    if (!Number.isFinite(cursorMax)) cursorMax = 0;
    let sawError = false;

    for (const item of sorted) {
      try {
        await this._processItem(channel, item, result);
        if (!sawError && item.created_at.getTime() > cursorMax) cursorMax = item.created_at.getTime();
      } catch (e: any) {
        sawError = true;
        result.errors++;
        this.logService.error('Outreach', `item processing failed on channel ${channel.id}`, {
          channel_id: channel.id, external_item_id: item.external_item_id, err: e?.message || String(e),
        });
      }
    }

    if (cursorMax > 0) channel.since_cursor = new Date(cursorMax).toISOString();
    channel.last_poll_at = now;
    await this.channelRepo.save(channel);

    this.logService.info('Outreach', `poll complete for channel ${channel.id}`, { channel_id: channel.id, ...result });
    return result;
  }

  private async _processItem(channel: OutreachChannel, item: InboundItem, result: PollResult): Promise<void> {
    const existing = await this.itemRepo.findOne({
      where: { channel_id: channel.id, external_item_id: item.external_item_id },
    });
    if (existing) {
      result.skipped++;
      return;
    }

    const { category, confidence } = await this.classifier.classify(item);
    let status: OutreachItemStatus;
    let ticketId: string | null = null;

    if (confidence < channel.classify_threshold) {
      status = 'held';
      result.held++;
    } else if (category === 'question') {
      status = 'question';
      result.question++;
    } else if (!TICKETABLE.has(category)) {
      status = 'noise';
      result.noise++;
    } else {
      ticketId = await this._createTicket(channel, item, category);
      status = 'ticketed';
      result.ticketed++;
    }

    // The unique (channel_id, external_item_id) index is the actual dedupe
    // guard — this INSERT is the only write path for a given external item,
    // so a concurrent/rewound re-poll of the same item fails here rather than
    // silently re-ticketing it.
    await this.itemRepo.save(this.itemRepo.create({
      workspace_id: channel.workspace_id,
      channel_id: channel.id,
      external_item_id: item.external_item_id,
      classification: category,
      confidence,
      status,
      ticket_id: ticketId,
      permalink: item.permalink,
      author: item.author,
      collected_at: item.created_at,
    }));
  }

  private async _createTicket(channel: OutreachChannel, item: InboundItem, category: OutreachCategory): Promise<string> {
    const board = await this._resolveBoard(channel);
    if (!board) {
      throw new Error(`no board available for outreach channel ${channel.id} in workspace ${channel.workspace_id}`);
    }
    const column = await this._resolveColumn(board.id);
    if (!column) {
      // Deliberately does NOT fall back to a terminal column (unlike
      // QaFailureTicketService's last-resort cols[0]) — a ticket landing in a
      // terminal column is invisible to every dispatch path (the same trap
      // create_ticket's own terminal-column guard exists to prevent). Better
      // to error (retried next poll) than to silently file a dead ticket.
      throw new Error(`board ${board.id} has no active column for outreach ticket creation`);
    }

    const title = this._buildTitle(channel, item);
    const description = this._buildDescription(channel, item);
    // related_ticket_id is intentionally left unset (ticket 2500fea3 D3): no
    // inbound signal populates it today (InboundItem carries no such
    // reference), so there is nothing to pass through yet. A future
    // classifier/connector that extracts one only needs to set the field —
    // nothing here blocks it.
    const ticket = await this.dataSource.transaction(async (manager) => {
      const tRepo = manager.getRepository(Ticket);
      const position = await maxTicketPosition(manager, column.id);
      return tRepo.save(tRepo.create({
        column_id: column.id,
        workspace_id: channel.workspace_id,
        title,
        description,
        priority: category === 'bug' ? 'high' : 'medium',
        labels: JSON.stringify(['outreach', `source:${channel.kind}`]),
        channel_ids: '[]',
        position,
        source_kind: channel.kind,
        created_by: 'Outreach',
        created_by_type: 'system',
        created_by_id: '',
      }));
    });

    // Board default role holders only (mirrors QaFailureTicketService) — an
    // outreach channel names no assignee, so an unstaffed role stays vacant
    // unless the board configures a default_role_assignments backfill.
    try {
      const defaults = parseDefaultRoleAssignments(board.default_role_assignments);
      if (Object.keys(defaults).length > 0) {
        await this.roleAssignmentService.applyBoardDefaults(ticket.id, channel.workspace_id, defaults);
      }
    } catch {
      /* non-fatal — degrade to "no defaults" */
    }

    await this.activityService.logActivity({
      entity_type: 'ticket',
      entity_id: ticket.id,
      action: 'created',
      ticket_id: ticket.id,
      actor_name: 'Outreach',
    });

    return ticket.id;
  }

  /** Explicit `target_board_id` → else the workspace's earliest-created board
   *  (mirrors agent-api.controller.ts's `operational-capability-ticket`
   *  fallback), so registering a channel never requires wiring a board id
   *  up front. */
  private async _resolveBoard(channel: OutreachChannel): Promise<Board | null> {
    if (channel.target_board_id) {
      const explicit = await this.dataSource.getRepository(Board).findOne({
        where: { id: channel.target_board_id, workspace_id: channel.workspace_id },
      });
      if (explicit) return explicit;
    }
    return this.dataSource.getRepository(Board).findOne({
      where: { workspace_id: channel.workspace_id },
      order: { created_at: 'ASC' },
    });
  }

  /** First active, non-terminal column (position order); null if none. */
  private async _resolveColumn(boardId: string): Promise<BoardColumn | null> {
    const cols = await this.dataSource.getRepository(BoardColumn).find({
      where: { board_id: boardId },
      order: { position: 'ASC' },
    });
    return cols.find((c) => c.kind === 'active' && !isTerminalColumn(c))
      || cols.find((c) => !isTerminalColumn(c))
      || null;
  }

  private _buildTitle(channel: OutreachChannel, item: InboundItem): string {
    return `[${channel.kind}] ${item.title || '(제목 없음)'}`.slice(0, 200);
  }

  private _buildDescription(channel: OutreachChannel, item: InboundItem): string {
    return [
      `Source: ${channel.kind}`,
      `Source URL: ${item.permalink}`,
      `Author: ${item.author}`,
      `Collected At: ${item.created_at.toISOString()}`,
      '',
      item.body || '',
    ].join('\n');
  }
}
