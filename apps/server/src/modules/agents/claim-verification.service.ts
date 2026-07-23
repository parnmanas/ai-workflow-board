/**
 * ClaimVerificationService — claim-vs-state mismatch detector (ticket
 * dcb9d661).
 *
 * Problem: an assignee subagent in an active column can post a "done"
 * comment and exit without actually pushing a commit or calling
 * `move_ticket`. The trigger loop's existing dedup (`52e581ce`) treats
 * the re-fire as a live-process reuse, the supervisor's stale-resend is
 * 30 min, and the ticket effectively hangs — visible motion in
 * comments, zero motion in git/board state.
 *
 * Detection (intentionally text-agnostic):
 *   1. Ticket lives in a kind='active' (non-intake, non-terminal) column.
 *   2. Latest non-system comment was authored by the ticket's assignee.
 *   3. No `moved` ActivityLog row newer than that comment.
 *   4. (now - comment.created_at) ≥ `claim_verification_grace_ms`.
 *   5. Workspace has `claim_verification_enabled = 1`.
 *
 * If all five hold, call the same flow `pend_ticket` runs:
 *   - flip `pending_user_action = true`, write a structured reason that
 *     references the branch tip SHA we snapshotted at trigger time when
 *     available;
 *   - drop a comment that mentions the reporter and reviewer via
 *     structured `@[role:…]` tokens so the User tab gets routed
 *     attention;
 *   - log an `updated`/`pending_user_action` activity row — this is
 *     the canonical surface for the `ticket_pended` SSE the spec asks
 *     for (no separate event type exists).
 *
 * Timer reset semantics:
 *   The "first observation timestamp" is whatever the LATEST assignee
 *   comment's `created_at` reports. A fresh assignee comment within
 *   the grace pushes the deadline forward implicitly — no in-memory
 *   timer state, the sweep just recomputes from raw rows every tick.
 *   A move_ticket call (or any column move) likewise clears the
 *   candidate state on the next sweep.
 *
 * Storage:
 *   Stateless — no dedicated alert table. The gating evidence
 *   (ticket.pending_*) and the audit trail (ActivityLog) are the only
 *   surfaces. A pended ticket cannot re-pend because the candidate
 *   filter excludes pending tickets up front.
 */
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ActivityLog } from '../../entities/ActivityLog';
import { BoardColumn } from '../../entities/BoardColumn';
import { Board } from '../../entities/Board';
import { Comment } from '../../entities/Comment';
import { Credential } from '../../entities/Credential';
import { Resource } from '../../entities/Resource';
import { Ticket } from '../../entities/Ticket';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { Workspace } from '../../entities/Workspace';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { Agent } from '../../entities/Agent';
import { User } from '../../entities/User';
import { sinceBoundaryParam } from '../../common/created-at-since-param';
import { ActivityService } from '../../services/activity.service';
import { LogService } from '../../services/log.service';
import { listRepoBranches, resolveGitCredential } from '../mcp/shared/git-branches';

const DEFAULTS = {
  SWEEP_MS: 60_000,         // 1 min — cheap O(active tickets) DB pass
  FETCH_TIMEOUT_MS: 8_000,  // git ls-remote cap; below the helper's 15s default
} as const;

function readSweepMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAIM_VERIFICATION_SWEEP_MS;
  if (!raw) return DEFAULTS.SWEEP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.SWEEP_MS;
}

function readFetchTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.CLAIM_VERIFICATION_FETCH_TIMEOUT_MS;
  if (!raw) return DEFAULTS.FETCH_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULTS.FETCH_TIMEOUT_MS;
}

interface SweepStats {
  scanned: number;
  pended: number;
  skipped_workspaces_disabled: number;
}

@Injectable()
export class ClaimVerificationService implements OnModuleInit, OnModuleDestroy {
  private tickHandle: NodeJS.Timeout | null = null;
  private readonly sweepMs: number;
  private readonly fetchTimeoutMs: number;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly activityService: ActivityService,
    private readonly logService: LogService,
  ) {
    this.sweepMs = readSweepMs();
    this.fetchTimeoutMs = readFetchTimeoutMs();
  }

  /**
   * Snapshot the remote branch tip onto `tickets.branch_tip_sha_at_trigger`
   * + `branch_tip_snapshot_at`. Called by `TriggerLoopService._emitTrigger`
   * after a successful assignee emit on a kind='active' column. The trigger
   * path does NOT await this — failures (network, missing credential,
   * unconfigured repo) just leave the snapshot empty; the sweep degrades
   * gracefully to "branch tip snapshot unavailable" in the pend reason.
   *
   * Skipped silently when:
   *   - role !== 'assignee' (only the assignee's commit-vs-claim mismatch
   *     is what this service polices)
   *   - column.kind !== 'active' (intake / review / merging / terminal
   *     columns have different lifecycle expectations)
   *   - workspace flag is off
   *   - ticket has no base_repo / base_branch (nothing to snapshot)
   */
  async recordSnapshot(ticket: Ticket, col: BoardColumn, role: string): Promise<void> {
    if (role !== 'assignee') return;
    if (col.kind !== 'active') return;
    if (!ticket.workspace_id) return;

    const ws = await this.dataSource.getRepository(Workspace).findOne({
      where: { id: ticket.workspace_id },
    });
    if (!ws || !ws.claim_verification_enabled) return;

    const sha = await this._lookupRemoteSha(ticket);
    try {
      await this.dataSource.getRepository(Ticket).update(ticket.id, {
        branch_tip_sha_at_trigger: sha || '',
        branch_tip_snapshot_at: new Date(),
      });
      this.logService.info('ClaimVerification', 'snapshot recorded', {
        ticket_id: ticket.id, sha: sha ? sha.slice(0, 7) : '(none)',
      });
    } catch (e) {
      this.logService.warn('ClaimVerification', 'snapshot write failed (continuing)', {
        err: String(e), ticket_id: ticket.id,
      });
    }
  }

  /**
   * Reset the snapshot. Called from move_ticket / REST move flows when a
   * ticket leaves its column — the destination column may not be active,
   * and even if it is, the next assignee trigger will re-snapshot with a
   * fresh baseline. Safe to call on tickets that never had one.
   */
  async clearSnapshot(ticketId: string): Promise<void> {
    if (!ticketId) return;
    try {
      await this.dataSource.getRepository(Ticket).update(ticketId, {
        branch_tip_sha_at_trigger: '',
        branch_tip_snapshot_at: null,
      });
    } catch (e) {
      this.logService.warn('ClaimVerification', 'snapshot clear failed (continuing)', {
        err: String(e), ticket_id: ticketId,
      });
    }
  }

  /**
   * Resolve the current branch tip via `git ls-remote`. Best-effort —
   * returns null on any missing-config or network failure. Caller treats
   * null as "no live evidence" and the sweep falls back to the activity-log
   * gate alone.
   */
  private async _lookupRemoteSha(ticket: Ticket): Promise<string | null> {
    if (!ticket.base_repo_resource_id || !ticket.workspace_id) return null;
    const repo = await this.dataSource.getRepository(Resource).findOne({
      where: { id: ticket.base_repo_resource_id, workspace_id: ticket.workspace_id },
    });
    if (!repo?.url) return null;
    const branchName = ticket.base_branch || repo.default_branch || '';
    if (!branchName) return null;

    try {
      const credential = await resolveGitCredential(
        this.dataSource.getRepository(Credential),
        repo.credential_id,
        ticket.workspace_id,
      );
      const branches = await listRepoBranches({
        url: repo.url,
        credential,
        defaultBranch: branchName,
        timeoutMs: this.fetchTimeoutMs,
      });
      const match = branches.find(b => b.name === branchName);
      return match?.sha || null;
    } catch (e) {
      this.logService.warn('ClaimVerification', 'git ls-remote failed', {
        err: String(e), ticket_id: ticket.id, branch: branchName,
      });
      return null;
    }
  }

  onModuleInit(): void {
    this.tickHandle = setInterval(() => {
      this.sweep().catch((e: unknown) => {
        this.logService.error('ClaimVerification', 'sweep failed', { err: String(e) });
      });
    }, this.sweepMs);
    if (typeof this.tickHandle?.unref === 'function') this.tickHandle.unref();
    this.logService.info('ClaimVerification', 'sweep loop initialized', {
      sweep_ms: this.sweepMs,
    });
  }

  onModuleDestroy(): void {
    if (this.tickHandle) {
      clearInterval(this.tickHandle);
      this.tickHandle = null;
    }
  }

  /**
   * Public test hook — equivalent to one tick of the internal loop.
   * Returns stats so a spec can assert "one ticket pended".
   */
  async sweep(now: Date = new Date()): Promise<SweepStats> {
    const stats: SweepStats = {
      scanned: 0, pended: 0, skipped_workspaces_disabled: 0,
    };

    // Step 1 — find every workspace with the feature enabled. Workspaces
    // with `claim_verification_enabled=0` cost zero (no candidate scan,
    // no GitHub fetch, no SSE) per AC #5.
    const wsRepo = this.dataSource.getRepository(Workspace);
    const enabledWorkspaces = await wsRepo
      .createQueryBuilder('w')
      .where('w.claim_verification_enabled = 1')
      .getMany();
    if (enabledWorkspaces.length === 0) return stats;

    const colRepo = this.dataSource.getRepository(BoardColumn);
    const ticketRepo = this.dataSource.getRepository(Ticket);
    const commentRepo = this.dataSource.getRepository(Comment);
    const activityRepo = this.dataSource.getRepository(ActivityLog);

    for (const ws of enabledWorkspaces) {
      const graceMs = Number.isFinite(ws.claim_verification_grace_ms) && ws.claim_verification_grace_ms > 0
        ? Math.floor(ws.claim_verification_grace_ms)
        : 600_000;

      // Step 2 — candidate columns: active kind on any of this workspace's
      // boards. Restrict via an IN-clause so the per-ticket scan stays bounded.
      const boards = await this.dataSource.getRepository(Board).find({
        where: { workspace_id: ws.id },
      });
      if (boards.length === 0) continue;
      const boardIds = boards.map(b => b.id);
      const activeCols = await colRepo
        .createQueryBuilder('c')
        .where('c.board_id IN (:...boardIds)', { boardIds })
        .andWhere("c.kind = 'active'")
        .getMany();
      if (activeCols.length === 0) continue;
      const colIds = activeCols.map(c => c.id);

      // Step 3 — candidate tickets: in an active column, not pending, not
      // archived, has an assignee. The `assignee_id != ''` filter avoids
      // tickets that haven't been claimed (no one to verify against).
      // The `comment_age >= grace_ms` cutoff is applied per-ticket below
      // since SQLite's date math isn't portable.
      const candidates = await ticketRepo
        .createQueryBuilder('t')
        .where('t.workspace_id = :wsId', { wsId: ws.id })
        .andWhere('t.column_id IN (:...colIds)', { colIds })
        .andWhere('t.pending_user_action = :pending', { pending: false })
        .andWhere('t.archived_at IS NULL')
        .andWhere("t.assignee_id != ''")
        .getMany();

      for (const ticket of candidates) {
        stats.scanned += 1;
        try {
          const pended = await this._evaluateTicket(ticket, ws, graceMs, now,
            { commentRepo, activityRepo, ticketRepo });
          if (pended) stats.pended += 1;
        } catch (e) {
          this.logService.warn('ClaimVerification', 'per-ticket evaluation failed (continuing)', {
            err: String(e), ticket_id: ticket.id,
          });
        }
      }
    }

    if (stats.scanned > 0 || stats.pended > 0) {
      this.logService.info('ClaimVerification', 'sweep complete', { stats });
    }
    return stats;
  }

  /**
   * Evaluate one candidate ticket. Returns `true` if the ticket was
   * pended this tick. Pure function over the local state — no GitHub
   * calls inside (the SHA snapshot lives on the ticket already).
   */
  private async _evaluateTicket(
    ticket: Ticket,
    ws: Workspace,
    graceMs: number,
    now: Date,
    repos: {
      commentRepo: ReturnType<DataSource['getRepository']>;
      activityRepo: ReturnType<DataSource['getRepository']>;
      ticketRepo: ReturnType<DataSource['getRepository']>;
    },
  ): Promise<boolean> {
    // The assignee's most recent non-system comment is the "claim".
    // Restricting to author_id == ticket.assignee_id means a reassignment
    // (e.g. operator hands the ticket to a new agent) cleanly resets the
    // candidate state — the OLD assignee's claim no longer applies.
    const latestAssigneeComment = await (repos.commentRepo as any)
      .createQueryBuilder('c')
      .where('c.ticket_id = :tid', { tid: ticket.id })
      .andWhere('c.author_id = :aid', { aid: ticket.assignee_id })
      .andWhere("c.type != 'system'")
      .orderBy('c.created_at', 'DESC')
      .limit(1)
      .getOne();
    if (!latestAssigneeComment) return false;

    const commentAt = new Date(latestAssigneeComment.created_at);
    const elapsedMs = now.getTime() - commentAt.getTime();
    if (elapsedMs < graceMs) return false;

    // Any column move newer than the claim comment means the assignee
    // closed out the cycle — explicit AC #2 (or someone else moved it,
    // either way we no longer have a stale claim).
    //
    // sinceBoundaryParam()으로 sql.js 동일-초 사전식 비교 간극을 없앤다
    // (ticket 7200396a, 8fc94adf 후속) — 기존 인라인 floorSec은 commentAt이
    // 이미 밀리초=0인 DB 재조회 Date라 no-op이었고, 실제 문제는 TypeORM이
    // 파라미터 바인딩 시 값과 무관하게 항상 밀리초를 붙이는 포맷팅 쪽이었다.
    // 이 경계를 놓치면 "컬럼 이동이 없었다"고 오판해 거짓 auto-pend로
    // 이어지므로(hard-budget-guard.ts의 epoch-anchored 배제와는 반대로
    // 과소카운트가 안전하지 않다) 자세한 내용은 created-at-since-param.ts 참조.
    const moveCount = await (repos.activityRepo as any)
      .createQueryBuilder('a')
      .where('a.ticket_id = :tid', { tid: ticket.id })
      .andWhere('a.created_at >= :from', { from: sinceBoundaryParam(this.dataSource, commentAt) })
      .andWhere("a.action = 'moved'")
      .andWhere("a.field_changed = 'column'")
      .getCount();
    if (moveCount > 0) return false;

    // === Claim-without-action confirmed. Pend the ticket. ===

    const currentSha = ticket.branch_tip_sha_at_trigger || '';
    const snapshotAt = ticket.branch_tip_snapshot_at
      ? new Date(ticket.branch_tip_snapshot_at)
      : null;
    // The snapshot is only meaningful evidence if it was taken BEFORE the
    // claim comment. A snapshot newer than the comment came from a
    // re-trigger AFTER the claim — useless for "did the agent commit
    // before claiming done".
    const snapshotIsBeforeClaim = snapshotAt !== null && snapshotAt.getTime() <= commentAt.getTime();

    const reason = buildPendReason({
      commentAt,
      sha: snapshotIsBeforeClaim ? currentSha : '',
      graceMs,
      excerpt: oneLineExcerpt(latestAssigneeComment.content),
    });

    await this._pendTicket(ticket, ws, reason, latestAssigneeComment, now);
    return true;
  }

  /**
   * Pend the ticket the same way the `pend_ticket` MCP tool does, and
   * post a system-styled comment mentioning the reporter and reviewer
   * via structured tokens so the notification fan-out fires.
   */
  private async _pendTicket(
    ticket: Ticket,
    ws: Workspace,
    reason: string,
    claimComment: Comment,
    now: Date,
  ): Promise<void> {
    const wasPending = !!ticket.pending_user_action;
    // Defense-in-depth — even though the candidate filter excludes
    // pending tickets, a parallel pend by an operator could race the
    // sweep. Re-read inside the same tick before flipping.
    const fresh = await this.dataSource.getRepository(Ticket).findOne({
      where: { id: ticket.id },
    });
    if (!fresh || fresh.pending_user_action || fresh.archived_at) return;

    fresh.pending_user_action = true;
    fresh.pending_reason = reason;
    if (!wasPending) {
      fresh.pending_set_at = now;
      fresh.pending_set_by = 'ClaimVerification';
    }
    await this.dataSource.getRepository(Ticket).save(fresh);

    // Activity row — drives the SSE that the spec calls `ticket_pended`.
    // The wire-level event type is the standard `activity` event whose
    // body carries `action='updated'`, `field_changed='pending_user_action'`
    // (same shape pend_ticket emits).
    await this.activityService.logActivity({
      entity_type: 'ticket', entity_id: ticket.id, action: 'updated',
      field_changed: 'pending_user_action',
      old_value: 'false', new_value: 'true',
      ticket_id: ticket.id,
      actor_id: 'system',
      actor_name: 'ClaimVerification',
    });

    // Visible comment with role-token mentions. parseable by the
    // mention fan-out so reporter/reviewer get notified.
    try {
      const mentions = await this._composeRoleMentions(ticket);
      const commentRepo = this.dataSource.getRepository(Comment);
      const content = [
        `🚫 **Claim-without-action detected** — auto-pended.`,
        '',
        reason,
        '',
        `Latest comment:`,
        `> ${oneLineExcerpt(claimComment.content, 400)}`,
        '',
        mentions.length > 0 ? mentions.join(' ') : '',
      ].filter(Boolean).join('\n');
      await commentRepo.save(commentRepo.create({
        ticket_id: ticket.id,
        workspace_id: ws.id,
        author_type: 'system',
        author_id: '',
        author: 'ClaimVerification',
        content,
        type: 'note',
      }));
    } catch (e) {
      this.logService.warn('ClaimVerification', 'pend comment write failed (continuing)', {
        err: String(e), ticket_id: ticket.id,
      });
    }

    this.logService.info('ClaimVerification', 'ticket auto-pended', {
      ticket_id: ticket.id, workspace_id: ws.id, reason,
    });
  }

  /**
   * Build structured `@[role:…]` mention tokens for the ticket's
   * reporter and reviewer. Drops a role when no holder is assigned so
   * the comment doesn't render a dead mention.
   */
  private async _composeRoleMentions(ticket: Ticket): Promise<string[]> {
    const tokens: string[] = [];
    const roleRepo = this.dataSource.getRepository(WorkspaceRole);
    const assignRepo = this.dataSource.getRepository(TicketRoleAssignment);

    for (const slug of ['reporter', 'reviewer'] as const) {
      const role = await roleRepo.findOne({
        where: { workspace_id: ticket.workspace_id, slug },
      });
      if (!role) continue;
      const assignment = await assignRepo.findOne({
        where: { ticket_id: ticket.id, role_id: role.id },
      });
      if (!assignment) continue;
      const display = await this._resolveDisplayName(assignment as any);
      tokens.push(`@[role:${slug}|${display}]`);
    }
    return tokens;
  }

  private async _resolveDisplayName(assignment: TicketRoleAssignment): Promise<string> {
    // Best-effort lookup; structured-mention tokens render the display
    // segment in the UI so a missing name just shows the slug.
    try {
      if ((assignment as any).agent_id) {
        const agent = await this.dataSource.getRepository(Agent).findOne({
          where: { id: (assignment as any).agent_id },
        });
        if (agent?.name) return agent.name;
      }
      if ((assignment as any).user_id) {
        const user = await this.dataSource.getRepository(User).findOne({
          where: { id: (assignment as any).user_id },
        });
        if (user?.name) return user.name;
      }
    } catch {
      // fall through
    }
    return 'role';
  }
}

/**
 * Compose the pend-reason text exactly as the spec dictates. Kept as a
 * pure function so the unit spec can compare expected strings without
 * standing up a DataSource. Exported for tests via __test_helpers__.
 */
function buildPendReason(opts: {
  commentAt: Date;
  sha: string;
  graceMs: number;
  excerpt: string;
}): string {
  const minutes = Math.round(opts.graceMs / 60_000);
  const shaLine = opts.sha
    ? `branch tip unchanged (\`${opts.sha.slice(0, 7)}\`)`
    : `branch tip snapshot unavailable`;
  return (
    `Assignee claimed completion at ${opts.commentAt.toISOString()} but ` +
    `${shaLine} and no move_ticket call. ` +
    `Auto-pended after ${minutes} min. ` +
    `Last comment: "${opts.excerpt}".`
  );
}

function oneLineExcerpt(content: string, max = 200): string {
  if (!content) return '(empty)';
  const firstLine = content
    .split('\n')
    .map(l => l.replace(/^\s*[-*>#]+\s*/g, '').trim())
    .find(l => l.length > 0) || content.trim();
  if (firstLine.length <= max) return firstLine;
  return firstLine.slice(0, max - 1).trimEnd() + '…';
}

// Exported for unit tests so a spec can assert the message format
// without booting the Nest app.
export const __test_helpers__ = { buildPendReason, oneLineExcerpt, readSweepMs };
