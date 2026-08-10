/**
 * ReleaseConsistencyService — deploy-triggered release-changelog/doc
 * consistency check (ticket 31e7cd24 범위 3). Subscribes to the SAME
 * `DEPLOYMENT_REPORTED_EVENT` every other deploy-triggered outreach service
 * listens on (OutreachPublisherService) — the ticket's "기존 트리거 인프라를
 * 재사용할 것" convention, not a new event bus.
 *
 * Scoped to `kind='github'` channels only (the ticket's own repo-diff/issue
 * cross-reference requirements are GitHub-specific). Unlike
 * OutreachPublisherService's deploy announcement, this NEVER calls
 * OutreachConnector.publish/reply — the ticket's explicit "리포트는 채팅/티켓
 * 코멘트로 보고" scope keeps GitHub posting out of this piece entirely.
 *
 * Delivery target: a Comment on the most-recently-Done ticket in the release
 * window. There is no single "release ticket" concept in this codebase to
 * attach a report to instead, and OutreachChannel carries no configured chat
 * room — this is a pragmatic, documented choice (the ticket underspecifies
 * the exact delivery surface for this scope item, and unlike scope items 1-2
 * it has no completion-criteria test bound to it). A release with no Done
 * ticket in its window logs the report instead of dropping it silently.
 *
 * Idempotency: OutreachOutboundPost's pre-existing `(channel_id, dedupe_key)`
 * unique index, `dedupe_key = "release_report:{environment}:{sha}"` —
 * claimed BEFORE any GitHub call, same discipline as the deploy/resolve
 * paths (OutreachPublisherService / OutreachResolveNotifierService).
 *
 * Diff base: the channel's own most recent `kind='release_report'`
 * `status='published'` row (mirrors OutreachPublisherService's
 * `_findLatestPublished` pattern for `kind='deploy'`) — no prior report for
 * this channel → first-ever report, diff-based analysis is skipped (nothing
 * to compare against yet, same "no baseline" fallback
 * TemplateReleaseSummarizer documents for a channel's first deploy post).
 */
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, MoreThan } from 'typeorm';
import { Comment } from '../../entities/Comment';
import { Credential } from '../../entities/Credential';
import { Ticket } from '../../entities/Ticket';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachOutboundPost } from '../../entities/OutreachOutboundPost';
import { LogService } from '../../services/log.service';
import { activityEvents } from '../../services/activity.service';
import { compareCommits, listOpenIssuesSince } from '../../services/github-connector.service';
import { DEPLOYMENT_REPORTED_EVENT, DeploymentReportedSignal } from '../deployments/deployment.service';
import { resolveOutreachCredential } from './outreach-credential';
import { analyzeReleaseConsistency, ReleaseConsistencyDoneTicket } from './release-consistency';

const MAX_DONE_TICKETS = 50;

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

function parseTarget(target: string): { owner: string; repo: string } | null {
  const parts = (target || '').trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

@Injectable()
export class ReleaseConsistencyService implements OnModuleInit, OnModuleDestroy {
  private _deploymentListener?: (signal: DeploymentReportedSignal) => void;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  onModuleInit(): void {
    this._deploymentListener = (signal: DeploymentReportedSignal) => {
      this._onDeploymentReported(signal).catch((e: unknown) => {
        this.logService.error('Outreach', 'ReleaseConsistencyService _onDeploymentReported error', { err: String(e) });
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

  private get channelRepo() {
    return this.dataSource.getRepository(OutreachChannel);
  }

  private get postRepo() {
    return this.dataSource.getRepository(OutreachOutboundPost);
  }

  private get credentialRepo() {
    return this.dataSource.getRepository(Credential);
  }

  private async _onDeploymentReported(signal: DeploymentReportedSignal): Promise<void> {
    // Fail-closed on a GLOBAL deployment (workspace_id=null) — same reasoning
    // as OutreachPublisherService: fanning it out to every workspace's
    // GitHub channels would generate reports for workspaces that never
    // asked for it.
    if (!signal.workspace_id) return;
    const environment = (signal.environment || '').trim();
    const deployedCommitSha = (signal.deployed_commit_sha || '').trim();
    if (!environment || !deployedCommitSha) return;

    const channels = await this.channelRepo.find({
      where: { workspace_id: signal.workspace_id, enabled: true, kind: 'github' },
    });
    for (const channel of channels) {
      try {
        await this._checkChannel(channel, environment, deployedCommitSha);
      } catch (e: any) {
        this.logService.warn('Outreach', 'release-consistency check failed for channel (continuing)', {
          channel_id: channel.id, environment, err: e?.message || String(e),
        });
      }
    }
  }

  private async _checkChannel(channel: OutreachChannel, environment: string, deployedCommitSha: string): Promise<void> {
    if (!Array.isArray(channel.targets) || channel.targets.length === 0) return;
    const dedupeKey = `release_report:${environment}:${deployedCommitSha}`;

    let claimed: OutreachOutboundPost;
    try {
      claimed = await this.postRepo.save(this.postRepo.create({
        workspace_id: channel.workspace_id,
        channel_id: channel.id,
        dedupe_key: dedupeKey,
        kind: 'release_report',
        status: 'draft',
        target: '',
        title: '',
        body: '',
        deployed_commit_sha: deployedCommitSha,
      }));
    } catch (e) {
      if (isUniqueConstraintError(e)) return; // already generated for this (channel, environment, sha)
      throw e;
    }

    try {
      const previous = await this.postRepo.findOne({
        where: { channel_id: channel.id, kind: 'release_report', status: 'published' },
        order: { published_at: 'DESC' },
      });
      const doneTickets = previous?.published_at
        ? await this._collectDoneTickets(channel.workspace_id, previous.published_at)
        : [];

      const body = await this._buildReport(channel, previous, deployedCommitSha, environment, doneTickets);
      await this._deliver(channel, doneTickets, body);

      claimed.status = 'published';
      claimed.body = body;
      claimed.published_at = new Date();
      await this.postRepo.save(claimed);
    } catch (e: any) {
      claimed.status = 'failed';
      claimed.error = String(e?.message || e).slice(0, 2000);
      await this.postRepo.save(claimed);
      throw e;
    }
  }

  private async _buildReport(
    channel: OutreachChannel,
    previous: OutreachOutboundPost | null,
    deployedCommitSha: string,
    environment: string,
    doneTickets: ReleaseConsistencyDoneTicket[],
  ): Promise<string> {
    if (!previous?.deployed_commit_sha) {
      return [
        '## 릴리스 변경사항 정합성 점검',
        '',
        `이 채널의 첫 리포트라 비교 기준 커밋이 없어 diff 기반 분석을 건너뜁니다.`,
        `환경 "${environment}", 배포 커밋 ${deployedCommitSha.slice(0, 12)}.`,
      ].join('\n');
    }

    const parsed = parseTarget(channel.targets[0]);
    if (!parsed) {
      return `## 릴리스 변경사항 정합성 점검\n\n채널의 첫 대상(${channel.targets[0]})이 "owner/repo" 형식이 아니어서 분석을 건너뜁니다.`;
    }

    const credential = await resolveOutreachCredential(this.credentialRepo, channel.credential_id, channel.workspace_id);
    if (!credential) {
      return '## 릴리스 변경사항 정합성 점검\n\n채널에 크레덴셜이 설정되지 않아 분석을 건너뜁니다.';
    }

    const changedFiles = await compareCommits(parsed.owner, parsed.repo, previous.deployed_commit_sha, deployedCommitSha, credential.token);
    const openIssues = await listOpenIssuesSince(parsed.owner, parsed.repo, '', credential.token);
    const report = analyzeReleaseConsistency({
      changedFiles,
      openIssues: openIssues.map((i) => ({ number: i.number, title: i.title, body: i.body, html_url: i.html_url })),
      doneTickets,
    });
    return report.summary;
  }

  /** A Comment on the most-recently-Done ticket in the window; log-only when
   *  the window produced no Done ticket (nothing to attach the report to). */
  private async _deliver(channel: OutreachChannel, doneTickets: ReleaseConsistencyDoneTicket[], body: string): Promise<void> {
    const target = doneTickets[doneTickets.length - 1];
    if (!target) {
      this.logService.info('Outreach', 'release-consistency report generated with no Done ticket to attach it to (logged only)', {
        channel_id: channel.id, body_preview: body.slice(0, 200),
      });
      return;
    }
    const commentRepo = this.dataSource.getRepository(Comment);
    await commentRepo.save(commentRepo.create({
      ticket_id: target.id,
      author_type: 'system',
      author_id: '',
      author: 'Outreach (release-consistency)',
      content: body,
      type: 'note',
    }));
  }

  /** Tickets that reached Done strictly after `since` (mirrors
   *  OutreachPublisherService._collectDoneTickets exactly). */
  private async _collectDoneTickets(workspaceId: string, since: Date): Promise<ReleaseConsistencyDoneTicket[]> {
    const rows = await this.dataSource.getRepository(Ticket).find({
      where: { workspace_id: workspaceId, terminal_entered_at: MoreThan(since) },
      order: { terminal_entered_at: 'ASC' },
      take: MAX_DONE_TICKETS,
    });
    return rows.map((t) => ({ id: t.id, title: t.title }));
  }
}
