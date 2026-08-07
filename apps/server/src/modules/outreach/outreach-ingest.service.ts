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
 *
 * Stale-claim lease fencing (review 4th pass): a claim can be reclaimed by
 * another poll once STALE_CLAIM_LEASE_MS elapses (see that constant), which
 * means the original owner can still be mid-_createTicket() when it loses
 * ownership. Losing ownership must never surface as a second ticket, so the
 * claim row's own id is the fencing token — a takeover always deletes and
 * re-inserts (never UPDATEs in place), so the original owner's final
 * `itemRepo.update({ id: claimed.id }, ...)` link step is itself the
 * ownership check: 0 rows affected means the id is gone, i.e. someone else
 * now owns this external item, so the ticket just built is a duplicate and
 * gets compensated away instead of counted.
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

// How long a claim (status='ticketed', ticket_id=null) may sit unlinked
// before a later/racing poll is allowed to treat it as abandoned rather than
// still in-flight. Ticket creation normally completes in well under a
// second — this is a generous safety margin against a genuine crash, not a
// tuned SLA. See the stale-claim reclaim block in _processItem (review 3rd
// pass): a claim younger than this lease is never deleted, only skipped.
export const STALE_CLAIM_LEASE_MS = 2 * 60 * 1000;

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
    // Real wall-clock reading at sweep entry, paired with `now` below to let
    // per-item claim timestamps track real elapsed processing time within
    // this sweep (see _processItem's claimed_at comment) while staying in
    // the SAME clock domain as `now` — callers that pass a synthetic `now`
    // (tests) get synthetic claimed_at values; production's real default
    // `now` gets real claimed_at values either way.
    const pollStartRealMs = Date.now();
    const items = await connector.fetchInbound(channel.since_cursor || '');
    result.fetched = items.length;
    const sorted = items.slice().sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    let cursorMax = Date.parse(channel.since_cursor || '');
    if (!Number.isFinite(cursorMax)) cursorMax = 0;
    let sawError = false;

    for (const item of sorted) {
      try {
        await this._processItem(channel, item, result, now, pollStartRealMs);
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

  private async _processItem(channel: OutreachChannel, item: InboundItem, result: PollResult, now: Date, pollStartRealMs: number): Promise<void> {
    const existing = await this.itemRepo.findOne({
      where: { channel_id: channel.id, external_item_id: item.external_item_id },
    });
    if (existing) {
      if (existing.status === 'ticketed' && !existing.ticket_id) {
        // 정체된 것처럼 "보이는" claim — status는 'ticketed'인데 ticket_id가
        // 없다. 이 모양은 두 가지 서로 다른 상황에서 나온다: (a) 지금 이
        // 순간에도 다른 poll이 정상적으로 _createTicket()을 실행 중인 경우
        // (claim INSERT와 ticket_id UPDATE 사이 — 정상적인 처리 중간 상태),
        // (b) claim만 남기고 그 poll이 죽었거나 보상삭제까지 거친 경우(진짜
        // 정체). 리뷰 3차 지적: status/ticket_id만 보고 (a)와 (b)를 구분하지
        // 않은 채 즉시 삭제하면, 아직 살아서 _createTicket()을 실행 중인
        // poll의 claim을 빼앗아 같은 외부 항목이 티켓 2개로 중복 생성된다.
        // claimed_at 기준 lease로 (a)/(b)를 구분한다: lease가 아직 유효하면
        // "지금 누군가 처리 중"으로 보고 삭제 없이 skip만 기록한다 — 그
        // poll이 끝나면 ticket_id UPDATE로 이 행이 스스로 정상 상태가 된다.
        const claimedAtMs = existing.claimed_at ? existing.claimed_at.getTime() : 0;
        const staleCutoffMs = now.getTime() - STALE_CLAIM_LEASE_MS;
        if (claimedAtMs > staleCutoffMs) {
          result.skipped++;
          return;
        }

        // lease 만료 — 진짜 정체된 claim으로 보고 회수한다. 다만 우리가 읽은
        // 시점과 삭제 시점 사이에 다른 poll이 먼저 회수했거나(레이스) 정상
        // 완료했을 수 있으므로, id뿐 아니라 관측했던 모양(status='ticketed'
        // AND ticket_id IS NULL) 그대로 남아있을 때만 지우는 조건부 DELETE로
        // 원자적으로 확인한다. FindOperator(IsNull())를 repo.delete()
        // criteria에 넘기면 이 TypeORM 버전에서 조건이 조용히 빠지는 사례가
        // 이미 있었으므로(database.module.ts 참고) QueryBuilder의 raw SQL
        // WHERE로 우회한다. affected===0이면 이미 남이 처리했다는 뜻이니
        // 우리는 손대지 않고 skip한다.
        //
        // 리뷰 4차 지적: staleness를 이 DELETE 문의 WHERE 절 자체에도 다시
        // 넣는다(claimed_at <= cutoff) — 앞선 `if (claimedAtMs > staleCutoffMs)`
        // 체크만으로는 "읽은 시점엔 stale이었다"만 보장할 뿐, DELETE가 실제로
        // 실행되는 시점까지도 그 관측이 유효하다는 보장이 없다(check-then-act
        // TOCTOU). 지금은 claimed_at을 갱신하는 lease 갱신(heartbeat) 경로가
        // 없어 이 창이 실질적으로는 열리지 않지만, WHERE 절 자체를 CAS
        // 조건으로 완결시켜 두면 향후 갱신 경로가 생겨도 안전하다.
        const cutoffDate = new Date(staleCutoffMs);
        const { affected } = await this.itemRepo
          .createQueryBuilder()
          .delete()
          .from(OutreachInboundItem)
          .where('id = :id', { id: existing.id })
          .andWhere('status = :status', { status: 'ticketed' })
          .andWhere('ticket_id IS NULL')
          .andWhere('(claimed_at IS NULL OR claimed_at <= :cutoff)', { cutoff: cutoffDate })
          .execute();
        if (!affected) {
          result.skipped++;
          return;
        }
      } else {
        result.skipped++;
        return;
      }
    }

    const { category, confidence } = await this.classifier.classify(item);
    let status: OutreachItemStatus;
    let needsTicket = false;

    if (confidence < channel.classify_threshold) {
      status = 'held';
    } else if (category === 'question') {
      status = 'question';
    } else if (!TICKETABLE.has(category)) {
      status = 'noise';
    } else {
      status = 'ticketed';
      needsTicket = true;
    }

    // Claim the dedupe row BEFORE creating a ticket. The unique
    // (channel_id, external_item_id) index is the actual dedupe guard, but
    // it must be crossed before _createTicket() runs, not after — otherwise
    // two overlapping polls of the same item can both pass the `existing`
    // check above and both build a ticket before either notices the other.
    //
    // 티켓 생성 자체와 이 claim INSERT를 하나의 DB 트랜잭션으로 묶는 방안도
    // 시도했으나, sql.js 드라이버가 진짜 동시(overlap) 트랜잭션을 지원하지
    // 않아("cannot start a transaction within a transaction") 두 pollChannel이
    // Promise.all로 경쟁하는 순간 양쪽 다 실패하는 것을 직접 재현해 확인했다.
    // 대신 claim-first 순서(원래 구조)는 유지하고, 아래에서 실패 유형별로
    // 명시적으로 보상(compensate)해 트랜잭션 결합과 동등한 내구성을 얻는다.
    // 리뷰 4차 지적: claimed_at을 이 sweep 전체가 공유하는 `now` 그대로
    // 찍으면, 한 sweep 안에서 앞선 아이템의 _createTicket()이 오래 걸릴 때
    // 뒤쪽 아이템은 방금 claim되었어도 이미 lease가 지난 것처럼 기록되어
    // 다른 poll에게 즉시 stale 취급당할 수 있었다. sweep 시작 이후 실제로
    // 흐른 실시간(real elapsed ms)을 `now`에 더해 claimed_at을 남긴다 —
    // `now`와 같은 clock domain을 유지하면서도(테스트가 주입한 synthetic
    // `now`를 쓰는 호출은 synthetic claimed_at을, 운영의 실시각 기본값
    // `now`를 쓰는 호출은 실시각 claimed_at을 각각 얻는다) 이 항목이 실제로
    // claim된 시점을 정확히 반영한다.
    let claimed: OutreachInboundItem;
    try {
      claimed = await this.itemRepo.save(this.itemRepo.create({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        external_item_id: item.external_item_id,
        classification: category,
        confidence,
        status,
        ticket_id: null,
        claimed_at: new Date(now.getTime() + (Date.now() - pollStartRealMs)),
        permalink: item.permalink,
        author: item.author,
        collected_at: item.created_at,
      }));
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        result.skipped++;
        return;
      }
      throw e;
    }

    if (needsTicket) {
      let ticketId: string;
      try {
        ticketId = await this._createTicket(channel, item, category);
      } catch (e) {
        // 티켓이 아예 만들어지지 않았으니 보상할 것이 없다 — claim만 지워
        // 다음 sweep이 이 항목을 처음부터 다시 처리하게 한다.
        await this.itemRepo.delete({ id: claimed.id });
        throw e;
      }

      let linkAffected = 0;
      try {
        const linkResult = await this.itemRepo.update({ id: claimed.id }, { ticket_id: ticketId });
        linkAffected = linkResult.affected ?? 0;
      } catch (e) {
        // 티켓은 커밋됐지만 claim에 연결하는 데 실패했다(리뷰 2차 지적
        // 시나리오 1). 고아가 된 티켓을 best-effort로 보상삭제하고, claim
        // 행은 일부러 그대로 둔다 — 이제 이 행은 claim 직후 죽은 크래시와
        // 구별할 수 없는 모양(status='ticketed', ticket_id=null)이 되고, 위
        // stale-claim 복구 경로가 다음 poll에서 그대로 재활용해 정리한다.
        await this._deleteOrphanedTicket(channel, item, ticketId, 'failed to compensate an orphaned ticket after a ledger link failure');
        throw e;
      }

      if (linkAffected === 0) {
        // 리뷰 4차 지적 — lease fencing: UPDATE가 0행에 적중했다는 것은
        // claim.id가 더는 존재하지 않는다는 뜻이다. 즉 우리가 _createTicket()
        // 을 실행하는 동안(수 분 걸릴 수 있음) lease가 만료되어 다른 poll이
        // 이미 이 claim을 회수(delete+재insert)해 갔다 — 그 poll은 자신만의
        // claim.id로 스스로 티켓을 만들어 정상적으로 연결할 것이다. 우리가
        // 방금 만든 티켓은 같은 외부 항목에 대한 순수 중복이므로 여기서
        // 보상삭제하고, 재시도가 필요한 에러가 아니라 skip으로 집계한다 —
        // 이 외부 항목은 이미(또는 곧) 다른 소유자가 durable하게 처리한다.
        await this._deleteOrphanedTicket(channel, item, ticketId, 'failed to compensate a duplicate ticket after losing claim ownership to a stale-lease takeover');
        result.skipped++;
        return;
      }
      result.ticketed++;
    } else if (status === 'noise' || status === 'question') {
      result[status]++;
    } else {
      result.held++;
    }
  }

  private async _deleteOrphanedTicket(channel: OutreachChannel, item: InboundItem, ticketId: string, context: string): Promise<void> {
    try {
      await this.dataSource.getRepository(Ticket).delete({ id: ticketId });
    } catch (compensateErr: any) {
      this.logService.error('Outreach', context, {
        channel_id: channel.id, external_item_id: item.external_item_id, ticket_id: ticketId,
        err: compensateErr?.message || String(compensateErr),
      });
    }
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
