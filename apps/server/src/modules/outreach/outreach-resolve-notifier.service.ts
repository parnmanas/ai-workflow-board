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
 *
 * Deployment-fact gate (ticket 31e7cd24 — "판정은 컬럼 도달만으로 끝내지 말 것":
 * reaching Done is necessary but not sufficient; the fix must actually be
 * live before the external thread hears "resolved"), scoped to `kind='github'`
 * only — Reddit's existing "fire on terminal-column arrival alone" behavior
 * is UNCHANGED, since that ticket never asked for this stricter evidence
 * requirement. `OutreachChannel.target_environment` (default '') names the
 * `Deployment.environment` to check; unset behaves as "evidence permanently
 * unavailable" (never fires) rather than skipping the gate — an unconfigured
 * GitHub channel must never post without evidence just because nobody named
 * an environment yet.
 *
 * UNLIKE QaRerunOnFixService's gate, there is NO freshness-ordering fallback
 * (review round 1, point 1): a `fix-commit:<sha>` ticket label — proving the
 * deployed commit actually INCLUDES this ticket's fix — is the only accepted
 * evidence. "some deployment landed after this ticket reached Done" was
 * REMOVED as evidence; it never proved inclusion, only timing, so an
 * unrelated deployment landing right after Done could get cited as proof
 * this ticket's fix shipped. QaRerunOnFixService keeps its own freshness
 * fallback deliberately (out of scope here) — a wrong QA rerun is cheap and
 * reversible, but this notifier posts an irreversible "resolved" claim to a
 * THIRD PARTY's public GitHub issue, matching the ticket's own explicit risk
 * note: "판정 근거가 불충분하면 코멘트 대신 사람 확인 대기로 보낼 것". No
 * fix-commit label on the ticket ⇒ evidence can never be proven ⇒ this
 * backlink simply never auto-fires (stays a standing candidate for the
 * periodic/event-driven reconcile below, and ultimately for a human to
 * confirm manually) — never eventually-fire-blind.
 *
 * Durable across restarts (review round 1, point 3): candidates are NOT
 * tracked in an in-memory map (an earlier version did this and lost pending
 * entries on restart, identical to QaRerunOnFixService's own acknowledged
 * limitation). Instead `_reconcileGithubResolves()` re-derives candidates
 * straight from the DB — every terminal-column ticket with a `kind='github'`
 * backlink and no existing `OutreachOutboundPost` row yet — and is called
 * from three points: (1) synchronously the moment a ticket reaches Done
 * (`_handleActivity`, unchanged), (2) on every `DEPLOYMENT_REPORTED_EVENT`
 * (scoped to that event's environment), and (3) once at `onModuleInit()` so
 * a deployment that already satisfied the gate while the server was down
 * gets picked up on the next boot instead of silently requiring a brand-new
 * deployment event to ever fire. Idempotency still rides `OutreachOutboundPost`'s
 * `(channel_id, dedupe_key)` unique index, so re-running reconcile against an
 * already-published item is always a safe no-op.
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { Ticket } from '../../entities/Ticket';
import { BoardColumn } from '../../entities/BoardColumn';
import { Credential } from '../../entities/Credential';
import { Deployment } from '../../entities/Deployment';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachInboundItem } from '../../entities/OutreachInboundItem';
import { OutreachOutboundPost } from '../../entities/OutreachOutboundPost';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { isTerminalColumn } from '../mcp/shared/archive-helpers';
import { deploymentIncludesCommit, findLatestDeployment, resolveFixCommitLabel } from '../../common/deployment-options';
import { DEPLOYMENT_REPORTED_EVENT, DeploymentReportedSignal } from '../deployments/deployment.service';
import { OutreachPublisherService } from './outreach-publisher.service';
import { resolveChannelConnector } from './connector-resolver';
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
  private _deploymentListener?: (signal: DeploymentReportedSignal) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisherService: OutreachPublisherService,
    private readonly logService: LogService,
  ) {}

  // Mirrors OutreachPublisherService's own credentialRepo getter (same
  // module, same "no separate @InjectRepository param" convention).
  private get credentialRepo(): Repository<Credential> {
    return this.dataSource.getRepository(Credential);
  }

  onModuleInit(): void {
    this._activityListener = (log: ActivityLog) => {
      this._handleActivity(log).catch((e: unknown) => {
        this.logService.error('Outreach', 'OutreachResolveNotifierService _handleActivity error', { err: String(e) });
      });
    };
    activityEvents.on('activity', this._activityListener);

    this._deploymentListener = (signal: DeploymentReportedSignal) => {
      this._onDeploymentReported(signal).catch((e: unknown) => {
        this.logService.error('Outreach', 'OutreachResolveNotifierService _onDeploymentReported error', { err: String(e) });
      });
    };
    activityEvents.on(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);

    // Restart durability (review round 1, point 3): re-derive candidates
    // from the DB once at boot too — a deployment may already have landed
    // (and satisfied the gate) while the server was down, with no future
    // DEPLOYMENT_REPORTED_EVENT ever guaranteed to re-trigger it otherwise.
    this._reconcileGithubResolves().catch((e: unknown) => {
      this.logService.error('Outreach', 'OutreachResolveNotifierService boot reconcile error', { err: String(e) });
    });
  }

  onModuleDestroy(): void {
    if (this._activityListener) {
      activityEvents.removeListener('activity', this._activityListener);
      this._activityListener = undefined;
    }
    if (this._deploymentListener) {
      activityEvents.removeListener(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);
      this._deploymentListener = undefined;
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

    // Deployment-fact gate — kind='github' only (class docstring). Reddit
    // keeps firing on terminal-column arrival alone, unchanged.
    if (channel.kind === 'github') {
      const environment = channel.target_environment || '';
      const fixCommitSha = resolveFixCommitLabel(ticket.labels);
      const dep = environment
        ? await findLatestDeployment(this.dataSource.getRepository(Deployment), channel.workspace_id, environment)
        : null;
      if (!dep || !this._deploymentSatisfies(dep, fixCommitSha)) {
        this.logService.info('Outreach', 'resolve notify waiting for deployment evidence — never auto-fires without a fix-commit:<sha> label match', {
          item_id: item.id, ticket_id: ticket.id, channel_id: channel.id,
          environment: environment || '(unset — will never fire until an operator configures target_environment)',
          fix_commit: fixCommitSha || '(none — this ticket has no fix-commit:<sha> label; freshness-only timing is not accepted as evidence)',
        });
        return;
      }
      await this._claimAndPublish(item, ticket, channel, this._evidenceOf(dep, fixCommitSha));
      return;
    }

    await this._claimAndPublish(item, ticket, channel, null);
  }

  /** Does `dep` prove the ticket's fix is live? Requires an EXACT match — a
   *  `fix-commit:<sha>` ticket label naming the commit that must be the
   *  deployed commit itself or a known ancestor of it (deploymentIncludesCommit).
   *  No freshness-ordering fallback (review round 1, point 1 — see class
   *  docstring): without a fix-commit label there is no way to PROVE
   *  inclusion, only to guess from timing, which this notifier no longer
   *  accepts. */
  private _deploymentSatisfies(dep: Deployment, fixSha: string): boolean {
    return !!fixSha && deploymentIncludesCommit(dep, fixSha);
  }

  /** Human-readable evidence line for the resolve body — the ticket's
   *  explicit "근거(커밋 SHA / 릴리스 버전)를 코멘트 본문에 포함한다" requirement.
   *  Only ever called once _deploymentSatisfies has confirmed an exact
   *  fix-commit match, so `fixCommitSha` is always non-empty here. */
  private _evidenceOf(dep: Deployment, fixCommitSha: string): string {
    const sha = (dep.deployed_commit_sha || '').slice(0, 12) || '(unknown)';
    return `Environment "${dep.environment}" deployed commit ${sha}, which includes the fix commit ${fixCommitSha.slice(0, 12)}.`;
  }

  /** A deployment landed for `signal.environment` — re-derive every github
   *  channel's still-unpublished, terminal-ticket backlinks from the DB and
   *  fire the ones the gate now satisfies (review round 1, point 3: replaces
   *  the old in-memory-pending re-evaluation, which lost its candidate set
   *  on every server restart). */
  private async _onDeploymentReported(signal: DeploymentReportedSignal): Promise<void> {
    const env = (signal.environment || '').trim();
    if (!env) return;
    await this._reconcileGithubResolves(env);
  }

  /**
   * Re-derives resolve-notify candidates straight from the DB instead of
   * relying on any in-memory state: every `kind='github'` channel with a
   * configured `target_environment` (unset can never satisfy the gate —
   * skipped entirely), every `OutreachInboundItem` on that channel that
   * already resolved to a ticket (`status='ticketed'`), whose ticket is on a
   * terminal column, filtered to `envFilter` when given. `_notifyItem`
   * itself re-checks the gate and is a safe no-op for an item that's already
   * published (the `(channel_id, dedupe_key)` unique index absorbs the
   * duplicate claim attempt) — so calling this repeatedly, or for items that
   * turn out already-satisfied, is always safe.
   */
  private async _reconcileGithubResolves(envFilter?: string): Promise<void> {
    const channelRepo = this.dataSource.getRepository(OutreachChannel);
    const allGithubChannels = await channelRepo.find({ where: { kind: 'github' } });
    const channels = allGithubChannels.filter((c) => c.target_environment
      && (envFilter === undefined || c.target_environment === envFilter));
    if (channels.length === 0) return;

    const itemRepo = this.dataSource.getRepository(OutreachInboundItem);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const columnRepo = this.dataSource.getRepository(BoardColumn);
    const postRepo = this.dataSource.getRepository(OutreachOutboundPost);

    for (const channel of channels) {
      const items = await itemRepo.find({ where: { channel_id: channel.id, status: 'ticketed' } });
      for (const item of items) {
        if (!item.ticket_id) continue;
        // Cheap pre-check to skip already-published items without an
        // unnecessary ticket/column lookup — not load-bearing for
        // correctness, _claimAndPublish's unique index still guards it.
        const alreadyClaimed = await postRepo.findOne({ where: { channel_id: channel.id, dedupe_key: `resolve:${item.id}` } });
        if (alreadyClaimed) continue;

        const ticket = await ticketRepo.findOne({ where: { id: item.ticket_id } });
        if (!ticket || !ticket.column_id || !ticket.terminal_entered_at) continue;
        const col = await columnRepo.findOne({ where: { id: ticket.column_id } });
        if (!isTerminalColumn(col)) continue;

        try {
          await this._notifyItem(item, ticket);
        } catch (e: any) {
          this.logService.warn('Outreach', 'resolve reconcile failed for backlinked item (continuing)', {
            item_id: item.id, ticket_id: ticket.id, channel_id: channel.id, err: e?.message || String(e),
          });
        }
      }
    }
  }

  private async _claimAndPublish(item: OutreachInboundItem, ticket: Ticket, channel: OutreachChannel, evidence: string | null): Promise<void> {
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
        body: this._buildResolveBody(ticket, evidence),
        thread_ref: item.external_item_id,
        source_ticket_id: ticket.id,
        source_item_id: item.id,
      }));
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        // Already claimed by a prior 'moved' event / deployment re-check for
        // this SAME item — the ledger key is the idempotency anchor (see
        // class docstring, C3).
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

    const published = await this.publisherService.executeClaim(channel, claimed);
    await this._maybeCloseThread(channel, published);
  }

  /**
   * Ticket's explicit "이슈 자동 close는 기본 off — 옵션으로만 제공" requirement.
   * Only ever reached for a SUCCESSFULLY published resolve post
   * (publish_policy='auto' — see class docstring on why the 'approval' path
   * doesn't wire this up too: OutreachPublisherService.approve() is shared
   * with kind='deploy' posts and deliberately stays connector-agnostic).
   * Best-effort: a close failure is logged, never re-thrown — the resolve
   * reply itself already succeeded and must not be undone by a secondary
   * side effect failing.
   */
  private async _maybeCloseThread(channel: OutreachChannel, post: OutreachOutboundPost): Promise<void> {
    if (channel.kind !== 'github' || !channel.close_on_resolve) return;
    if (post.status !== 'published') return;
    try {
      const connector = await resolveChannelConnector(channel, this.credentialRepo);
      await connector.close?.(post.thread_ref);
    } catch (e: any) {
      this.logService.warn('Outreach', 'close_on_resolve failed (resolve reply already posted, continuing)', {
        channel_id: channel.id, post_id: post.id, thread_ref: post.thread_ref, err: e?.message || String(e),
      });
    }
  }

  private _buildResolveBody(ticket: Ticket, evidence: string | null): string {
    const lines = [`This has been resolved: "${ticket.title}"`];
    if (evidence) lines.push('', evidence);
    lines.push('', BOT_DISCLOSURE_FOOTER);
    return lines.join('\n');
  }
}
