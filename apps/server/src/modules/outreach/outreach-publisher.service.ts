/**
 * OutreachPublisherService — deploy-triggered publish/reply (ticket d86d0c24
 * steps 5+6, the ticket's core request). Subscribes to the SAME
 * `DEPLOYMENT_REPORTED_EVENT` on the shared `activityEvents` bus that
 * QaRerunOnFixService listens on (deployment.service.ts) — deliberately NOT a
 * new event bus (ticket's explicit "기존 트리거 인프라를 재사용할 것" requirement).
 * Listener bookkeeping mirrors qa-rerun-on-fix.service.ts's onModuleInit/
 * onModuleDestroy shape exactly.
 *
 * Two independent, stacked gates decide whether a Reddit post/comment ever
 * actually leaves the server (both DEFAULT to the safe side — ticket's
 * mandatory approval-gate requirement):
 *
 *   1. `OutreachChannel.deploy_post_mode` (default 'off') — WHETHER/HOW this
 *      deploy generates content at all: 'new_post' | 'reply_to_existing' |
 *      'auto' | 'off'. 'off' → the channel is excluded from the sweep
 *      entirely, no ledger row.
 *   2. `OutreachChannel.publish_policy` (pre-existing field, default
 *      'approval') — WHETHER generated content calls the connector:
 *        - 'off'      → also no ledger row (channel-wide outreach kill switch).
 *        - 'approval' → a `status='draft'` OutreachOutboundPost row is
 *          created; the connector is NEVER called. A human approves/rejects
 *          it via the REST endpoints below.
 *        - 'auto'     → the connector is called immediately; the row lands
 *          'published' or 'failed'.
 *
 * Idempotency (ticket's "동일 릴리스 두 번 트리거 → 게시 1회" completion
 * criterion): `OutreachOutboundPost`'s `@Index(['channel_id','dedupe_key'],
 * {unique})` is claimed via INSERT (status='draft', always, even for
 * publish_policy='auto') BEFORE any connector call — the same claim-first
 * discipline OutreachIngestService's inbound dedupe uses (see that entity's
 * docstring, lesson d8c72715 from ticket 2500fea3). A second trigger for the
 * SAME (channel, environment, commit) hits the unique constraint on INSERT
 * and is absorbed as "already processed" — no second connector call, ever,
 * regardless of publish_policy.
 *
 * Release-diff base: OutreachOutboundPost has no history table to join
 * against (Deployment itself is an UPSERT with no prior-sha memory — see this
 * ticket's Plan comment), so the most recently PUBLISHED kind='deploy' row
 * for a channel IS that base: its `deployed_commit_sha` is `previousCommitSha`
 * for the release summary, and its `published_at` is the "since" boundary for
 * collecting newly-Done tickets. `deploy_post_mode='auto'`'s reply-vs-new_post
 * decision reuses the SAME lookup — this is an APPROXIMATION of "is our post
 * still alive" (recency of our own publish record, not a live Reddit status
 * check — the connector interface has no such method).
 */
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { OutreachChannel, OutreachDeployPostMode } from '../../entities/OutreachChannel';
import { OutreachOutboundPost } from '../../entities/OutreachOutboundPost';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { DEPLOYMENT_REPORTED_EVENT, DeploymentReportedSignal } from '../deployments/deployment.service';
import { resolveChannelConnector } from './connector-resolver';
import { OUTREACH_RELEASE_SUMMARIZER, ReleaseSummarizer, ReleaseDoneTicket } from './release-summary';

// Bound how far back a first-ever publish (no prior published row) would
// otherwise have to scan — kept small since "no previous publish" already
// degrades to an empty changelog (TemplateReleaseSummarizer's fallback line).
const MAX_DONE_TICKETS = 50;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

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

interface ResolvedThread {
  mode: 'new_post' | 'reply';
  target: string; // subreddit, new_post only
  threadRef: string; // fullname being replied to, reply only
}

@Injectable()
export class OutreachPublisherService implements OnModuleInit, OnModuleDestroy {
  private _deploymentListener?: (signal: DeploymentReportedSignal) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
    @Inject(OUTREACH_RELEASE_SUMMARIZER) private readonly summarizer: ReleaseSummarizer,
  ) {}

  onModuleInit(): void {
    this._deploymentListener = (signal: DeploymentReportedSignal) => {
      this._onDeploymentReported(signal).catch((e: unknown) => {
        this.logService.error('Outreach', 'OutreachPublisherService _onDeploymentReported error', { err: String(e) });
      });
    };
    activityEvents.on(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);
  }

  onModuleDestroy(): void {
    if (this._deploymentListener) {
      activityEvents.removeListener(DEPLOYMENT_REPORTED_EVENT, this._deploymentListener);
      this._deploymentListener = undefined;
    }
  }

  private get channelRepo(): Repository<OutreachChannel> {
    return this.dataSource.getRepository(OutreachChannel);
  }

  private get postRepo(): Repository<OutreachOutboundPost> {
    return this.dataSource.getRepository(OutreachOutboundPost);
  }

  private get credentialRepo(): Repository<Credential> {
    return this.dataSource.getRepository(Credential);
  }

  private async _onDeploymentReported(signal: DeploymentReportedSignal): Promise<void> {
    // Fail-closed on a GLOBAL deployment (workspace_id=null): fanning it out
    // to every workspace's Reddit channels would post on behalf of workspaces
    // that never asked for it. A future global-broadcast feature would be an
    // explicit opt-in, not this default (lesson e45829b8).
    if (!signal.workspace_id) {
      this.logService.info('Outreach', 'deploy publish skipped — global (workspace_id=null) deployment, fail-closed', {
        environment: signal.environment,
      });
      return;
    }
    const environment = (signal.environment || '').trim();
    const deployedCommitSha = (signal.deployed_commit_sha || '').trim();
    if (!environment || !deployedCommitSha) return;

    const channels = await this.channelRepo.find({
      where: { workspace_id: signal.workspace_id, enabled: true, kind: 'reddit' },
    });
    const eligible = channels.filter((c) => c.deploy_post_mode !== 'off' && c.publish_policy !== ('off' as any));

    for (const channel of eligible) {
      try {
        await this._publishForChannel(channel, environment, deployedCommitSha);
      } catch (e: any) {
        this.logService.warn('Outreach', 'deploy publish failed for channel (continuing)', {
          channel_id: channel.id, environment, err: e?.message || String(e),
        });
      }
    }
  }

  private async _publishForChannel(channel: OutreachChannel, environment: string, deployedCommitSha: string): Promise<void> {
    const dedupeKey = `deploy:${environment}:${deployedCommitSha}`;
    const latestPublished = await this._findLatestPublished(channel.id);

    const resolved = await this._resolveThread(channel, latestPublished);
    if (!resolved) {
      this.logService.warn('Outreach', 'deploy publish skipped — mode could not resolve a target', {
        channel_id: channel.id, mode: channel.deploy_post_mode,
      });
      return;
    }

    const doneTickets = await this._collectDoneTickets(channel.workspace_id, latestPublished?.published_at ?? null);
    const summary = await this.summarizer.summarize({
      environment,
      deployedCommitSha,
      previousCommitSha: latestPublished?.deployed_commit_sha || '',
      doneTickets,
    });

    let claimed: OutreachOutboundPost;
    try {
      claimed = await this.postRepo.save(this.postRepo.create({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        dedupe_key: dedupeKey,
        kind: 'deploy',
        status: 'draft',
        target: resolved.mode === 'new_post' ? resolved.target : '',
        title: resolved.mode === 'new_post' ? summary.title : '',
        body: summary.body,
        thread_ref: resolved.mode === 'reply' ? resolved.threadRef : '',
        deployed_commit_sha: deployedCommitSha,
      }));
    } catch (e) {
      if (isUniqueConstraintError(e)) {
        this.logService.info('Outreach', 'deploy publish skipped — already processed (idempotent)', {
          channel_id: channel.id, dedupe_key: dedupeKey,
        });
        return;
      }
      throw e;
    }

    if (channel.publish_policy !== 'auto') {
      // 'approval' — the draft is left for a human. NO connector call.
      this.logService.info('Outreach', 'deploy publish draft created, awaiting approval', {
        channel_id: channel.id, post_id: claimed.id,
      });
      return;
    }

    await this._executePublish(channel, claimed, resolved);
  }

  /**
   * Actually call the connector for a claimed row (either immediately, for
   * publish_policy='auto', or from the approve endpoint). Updates the row to
   * 'published' or 'failed' — never throws (errors are recorded on the row).
   */
  async executeClaim(channel: OutreachChannel, post: OutreachOutboundPost): Promise<OutreachOutboundPost> {
    const resolved: ResolvedThread = post.thread_ref
      ? { mode: 'reply', target: '', threadRef: post.thread_ref }
      : { mode: 'new_post', target: post.target, threadRef: '' };
    return this._executePublish(channel, post, resolved);
  }

  /**
   * Human approval of a draft (step 6 REST surface). Consumed exactly once:
   * the draft→'approving' UPDATE is the single-winner mutex — two concurrent
   * `approve()` calls for the SAME post can only ever have one succeed the
   * conditional UPDATE, so the connector is called at most once regardless
   * of how many approve requests race. The loser throws 409 rather than
   * silently no-op'ing, since this is a direct human action (not a
   * best-effort background sweep).
   */
  async approve(postId: string, workspaceId: string, bodyOverride?: string): Promise<OutreachOutboundPost> {
    const existing = await this.postRepo.findOne({ where: { id: postId, workspace_id: workspaceId } });
    if (!existing) throw makeError(404, 'outbound post not found');

    if (typeof bodyOverride === 'string' && bodyOverride.trim()) {
      // Best-effort — only takes effect if still a draft; the claim below is
      // the real mutex, this just lets a human edit the template body first.
      await this.postRepo.update({ id: postId, status: 'draft' }, { body: bodyOverride });
    }

    const claim = await this.postRepo
      .createQueryBuilder()
      .update(OutreachOutboundPost)
      .set({ status: 'approving' })
      .where('id = :id', { id: postId })
      .andWhere('status = :draft', { draft: 'draft' })
      .execute();
    const claimed = (claim.affected ?? 0) > 0;
    if (!claimed) {
      const current = await this.postRepo.findOne({ where: { id: postId } });
      throw makeError(409, `post is not awaiting approval (current status: ${current?.status ?? 'not found'})`);
    }

    const channel = await this.channelRepo.findOne({ where: { id: existing.channel_id } });
    if (!channel) throw makeError(404, 'owning channel not found');
    const claimedPost = await this.postRepo.findOne({ where: { id: postId } });
    return this.executeClaim(channel, claimedPost!);
  }

  /** Reject a draft — terminal, never calls the connector. Same single-winner
   *  conditional UPDATE shape as approve() (draft→rejected only). */
  async reject(postId: string, workspaceId: string): Promise<OutreachOutboundPost> {
    const existing = await this.postRepo.findOne({ where: { id: postId, workspace_id: workspaceId } });
    if (!existing) throw makeError(404, 'outbound post not found');

    const result = await this.postRepo
      .createQueryBuilder()
      .update(OutreachOutboundPost)
      .set({ status: 'rejected' })
      .where('id = :id', { id: postId })
      .andWhere('status = :draft', { draft: 'draft' })
      .execute();
    if ((result.affected ?? 0) === 0) {
      const current = await this.postRepo.findOne({ where: { id: postId } });
      throw makeError(409, `post is not awaiting approval (current status: ${current?.status ?? 'not found'})`);
    }
    return (await this.postRepo.findOne({ where: { id: postId } }))!;
  }

  /** List a channel's outbound ledger rows, optionally filtered by status —
   *  the "승인 대기 큐 조회" REST surface (`?status=draft`). */
  async listOutbound(channelId: string, workspaceId: string, status?: string): Promise<OutreachOutboundPost[]> {
    const channel = await this.channelRepo.findOne({ where: { id: channelId, workspace_id: workspaceId } });
    if (!channel) throw makeError(404, 'outreach channel not found');
    const where: Record<string, string> = { channel_id: channelId };
    if (status) where.status = status;
    return this.postRepo.find({ where, order: { created_at: 'DESC' } });
  }

  private async _executePublish(channel: OutreachChannel, post: OutreachOutboundPost, resolved: ResolvedThread): Promise<OutreachOutboundPost> {
    try {
      const connector = await resolveChannelConnector(channel, this.credentialRepo);
      const result = resolved.mode === 'new_post'
        ? await connector.publish({ target: resolved.target, title: post.title, body: post.body })
        : await connector.reply(resolved.threadRef, post.body);

      post.status = 'published';
      post.external_item_id = result.external_item_id;
      post.permalink = result.permalink;
      post.published_at = new Date();
      post.error = '';
      await this.postRepo.save(post);
      this.logService.info('Outreach', 'deploy publish succeeded', {
        channel_id: channel.id, post_id: post.id, permalink: result.permalink,
      });
    } catch (e: any) {
      post.status = 'failed';
      post.error = String(e?.message || e).slice(0, 2000);
      await this.postRepo.save(post);
      this.logService.warn('Outreach', 'deploy publish connector call failed', {
        channel_id: channel.id, post_id: post.id, err: post.error,
      });
    }
    return post;
  }

  /** Most recent successfully published kind='deploy' row for a channel, or null. */
  private async _findLatestPublished(channelId: string): Promise<OutreachOutboundPost | null> {
    return this.postRepo.findOne({
      where: { channel_id: channelId, kind: 'deploy', status: 'published' },
      order: { published_at: 'DESC' },
    });
  }

  /** thread_ref if the row was itself a reply (keep threading under the SAME
   *  root across repeated 'auto' cycles), else its own external_item_id
   *  (the row WAS the root post). */
  private _activeThreadOf(row: OutreachOutboundPost): string {
    return row.thread_ref || row.external_item_id;
  }

  private async _resolveThread(channel: OutreachChannel, latestPublished: OutreachOutboundPost | null): Promise<ResolvedThread | null> {
    const mode: OutreachDeployPostMode = channel.deploy_post_mode;
    if (mode === 'new_post') {
      const target = (channel.targets || [])[0];
      if (!target) return null; // no subreddit configured to post into
      return { mode: 'new_post', target, threadRef: '' };
    }
    if (mode === 'reply_to_existing') {
      if (!channel.reply_thread_ref) return null;
      return { mode: 'reply', target: '', threadRef: channel.reply_thread_ref };
    }
    if (mode === 'auto') {
      if (latestPublished?.published_at) {
        const windowMs = Math.max(1, channel.auto_reuse_window_days) * 24 * 60 * 60 * 1000;
        const ageMs = Date.now() - new Date(latestPublished.published_at).getTime();
        if (ageMs <= windowMs) {
          return { mode: 'reply', target: '', threadRef: this._activeThreadOf(latestPublished) };
        }
      }
      const target = (channel.targets || [])[0];
      if (!target) return null;
      return { mode: 'new_post', target, threadRef: '' };
    }
    return null; // 'off' — never reached (filtered upstream)
  }

  /** Tickets that reached a terminal column strictly after `since` (null =
   *  no prior publish on record → no changelog, not "everything ever"). */
  private async _collectDoneTickets(workspaceId: string, since: Date | null): Promise<ReleaseDoneTicket[]> {
    if (!since) return [];
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const rows = await ticketRepo.find({
      where: { workspace_id: workspaceId, terminal_entered_at: MoreThan(since) },
      order: { terminal_entered_at: 'ASC' },
      take: MAX_DONE_TICKETS,
    });
    return rows.map((t) => ({ id: t.id, title: t.title }));
  }
}
