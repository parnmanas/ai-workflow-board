/**
 * GitHubConnector — the `kind='github'` OutreachConnector implementation
 * (ticket 31e7cd24, follow-up to 2500fea3's interface + FakeOutreachConnector
 * cut and d86d0c24's RedditConnector precedent — connector-resolver.ts named
 * this exact ticket as the place `kind='github'` stops falling back to the
 * fake). Reuses the EXISTING GitHub REST client path
 * (github-connector.service.ts's pure, token-parameterized helpers) rather
 * than a new HTTP client — the ticket's explicit "새 GitHub 클라이언트를 새로
 * 만들지 말 것" constraint.
 *
 * fetchInbound(since) combines three things per whitelisted target repo, all
 * sourced from ONE `listOpenIssuesSince` call (GitHub's `since` matches on
 * UPDATED time, so brand-new AND merely-edited issues come back together):
 *   - Genuinely NEW open issues (issue.created_at is itself after the cursor)
 *     become a top-level `issue:{owner}/{repo}#{number}` item — a fresh
 *     ticket-creation candidate.
 *   - An EXISTING issue (created_at at/before the cursor) that shows up
 *     anyway because its updated_at moved past the cursor — a body/metadata
 *     edit — becomes an `issue-update:{owner}/{repo}#{number}:{updated_at}`
 *     item tagged with `parent_external_item_id = issue:{owner}/{repo}#{number}`,
 *     so OutreachIngestService appends it as a Comment on the issue's
 *     existing ticket instead of dropping it (review round 1, point 2: an
 *     earlier version stamped `created_at` = the issue's ORIGINAL creation
 *     time on this case too, which the trailing since-filter on created_at
 *     then silently discarded — an edited issue's update never reached
 *     ingest at all). Using `updated_at` as the id's version component makes
 *     re-polling the SAME edit a no-op (identical id → the existing
 *     `(channel_id, external_item_id)` dedupe absorbs it) while a LATER edit
 *     produces a fresh id that appends again.
 *   - New comments on EVERY open issue the call returns (both brand-new and
 *     merely-updated ones), each tagged with the same
 *     `parent_external_item_id` convention (ticket's "이슈 본문/댓글이 갱신되면
 *     기존 티켓에 코멘트로 추가한다").
 * Issues/comments authored by the bot's own token identity (resolved once
 * via GET /user, cached for this connector instance's lifetime) are filtered
 * out of the "new issue"/comment cases — the ticket's explicit self-
 * referential-loop prevention requirement. An issue-update item is NOT
 * filtered this way: GitHub's issue object only ever names the ORIGINAL
 * poster, never the latest editor, so there is no editor identity to check
 * — harmless in practice since the bot itself never edits issue bodies
 * (only creates/comments/closes).
 *
 * Whitelist-only, same fail-closed contract as RedditConnector: `targets`
 * (OutreachChannel.targets, "owner/repo" strings) is the only universe this
 * connector ever touches — no auto-discovery; publish/reply/close reject a
 * target outside it.
 *
 * Rate limiting: OutreachChannel.rate_limit_per_hour (operator cap) is
 * enforced via the shared OutreachRateLimiter — the same channelId-keyed
 * counter RedditConnector uses (outreach-rate-limiter.ts). GitHub's OWN
 * limit is handled reactively: a 429 (primary limit) or a 403 that carries a
 * `Retry-After` header (secondary rate limit / abuse detection) is retried
 * with backoff up to MAX_RATE_LIMIT_RETRIES; a 403 WITHOUT one (bad token
 * scope, no repo access) is a hard failure — never retried, so a
 * misconfigured credential fails fast instead of burning the retry budget.
 */
import {
  GitHubApiError,
  GitHubForbiddenError,
  GitHubRateLimitError,
  closeIssue,
  createIssue,
  createIssueComment,
  getAuthenticatedLogin,
  listIssueCommentsSince,
  listOpenIssuesSince,
} from '../../../services/github-connector.service';
import { InboundItem, OutboundPost, OutboundResult, OutreachConnector } from './types';
import { OutreachRateLimiter, sharedOutreachRateLimiter } from '../outreach-rate-limiter';

export class GitHubConnectorConfigError extends Error {
  readonly code = 'config_error';
}

const MAX_RATE_LIMIT_RETRIES = 3;
const MAX_BACKOFF_MS = 30_000;

export interface GitHubCredentialLike {
  username?: string;
  token: string;
  extra: Record<string, string>;
}

export interface GitHubConnectorOptions {
  /** "owner/repo" whitelist — OutreachChannel.targets for a kind='github' channel. */
  targets: string[];
  // Operator-configured hourly request cap (OutreachChannel.rate_limit_per_hour,
  // 0/omitted = unlimited) — see outreach-rate-limiter.ts. channelId is the
  // cap's counter key, so it must be passed together with rateLimitPerHour.
  channelId?: string;
  rateLimitPerHour?: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  // Test seam — defaults to the shared process-wide limiter (mirrors
  // RedditConnectorOptions.rateLimiter's reasoning).
  rateLimiter?: OutreachRateLimiter;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** "owner/repo" → {owner, repo}, or null if not exactly two non-empty segments. */
function parseTarget(target: string): { owner: string; repo: string } | null {
  const parts = (target || '').trim().split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { owner: parts[0], repo: parts[1] };
}

export class GitHubConnector implements OutreachConnector {
  private readonly token: string;
  private readonly targets: Set<string>; // normalized lowercase "owner/repo"
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly channelId: string;
  private readonly rateLimitPerHour: number;
  private readonly rateLimiter: OutreachRateLimiter;

  private botLogin: string | null = null;
  private botLoginPromise: Promise<string> | null = null;

  constructor(cred: GitHubCredentialLike, opts: GitHubConnectorOptions) {
    if (!cred.token) throw new GitHubConnectorConfigError('GitHub credential is missing a token');
    this.token = cred.token;
    this.targets = new Set((opts.targets || []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.sleepImpl = opts.sleepImpl || defaultSleep;
    this.channelId = opts.channelId || '';
    this.rateLimitPerHour = opts.rateLimitPerHour ?? 0;
    this.rateLimiter = opts.rateLimiter || sharedOutreachRateLimiter;
  }

  /**
   * Inbound = new issues + issue body/metadata updates + new comments across
   * every whitelisted repo's open issues. Empty `targets` short-circuits to
   * `[]` without any network call — fail-closed, never falls back to
   * "everything"/"discover repos".
   */
  async fetchInbound(since: string): Promise<InboundItem[]> {
    if (this.targets.size === 0) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    const threshold = Number.isFinite(sinceMs) ? sinceMs : 0;
    const botLogin = await this._ensureBotLogin();

    const items: InboundItem[] = [];
    for (const target of this.targets) {
      const parsed = parseTarget(target);
      if (!parsed) continue;
      const { owner, repo } = parsed;

      const issues = await this._withRetry(() =>
        listOpenIssuesSince(owner, repo, since, this.token, { fetchImpl: this.fetchImpl }));

      for (const issue of issues) {
        const issueRef = `issue:${owner}/${repo}#${issue.number}`;
        const createdAt = new Date(issue.created_at);
        if (createdAt.getTime() > threshold) {
          // Genuinely new to us — a fresh ticket-creation candidate.
          if (issue.user.toLowerCase() !== botLogin) {
            items.push({
              external_item_id: issueRef,
              title: issue.title,
              body: issue.body,
              author: issue.user,
              permalink: issue.html_url,
              created_at: createdAt,
            });
          }
        } else {
          // Already known to us (created before our cursor) but returned
          // anyway because updated_at moved past it — a body/metadata edit.
          // Threaded onto the issue's own ticket via parent_external_item_id
          // (review round 1, point 2 — see class docstring).
          items.push({
            external_item_id: `issue-update:${owner}/${repo}#${issue.number}:${issue.updated_at}`,
            title: issue.title,
            body: issue.body,
            author: issue.user,
            permalink: issue.html_url,
            created_at: new Date(issue.updated_at),
            parent_external_item_id: issueRef,
          });
        }

        const comments = await this._withRetry(() =>
          listIssueCommentsSince(owner, repo, issue.number, since, this.token, { fetchImpl: this.fetchImpl }));
        for (const comment of comments) {
          if (comment.user.toLowerCase() === botLogin) continue; // self-loop prevention
          items.push({
            external_item_id: `comment:${owner}/${repo}#${issue.number}:${comment.id}`,
            title: '',
            body: comment.body,
            author: comment.user,
            permalink: comment.html_url,
            created_at: new Date(comment.created_at),
            parent_external_item_id: issueRef,
          });
        }
      }
    }

    return items
      .filter((i) => i.created_at.getTime() > threshold)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  /** Opens a new issue — the closest GitHub analog to "a new top-level post". */
  async publish(post: OutboundPost): Promise<OutboundResult> {
    const { owner, repo } = this._assertTargetAllowed(post.target);
    const created = await this._withRetry(() =>
      createIssue(owner, repo, post.title, post.body, this.token, { fetchImpl: this.fetchImpl }));
    return { external_item_id: `issue:${owner}/${repo}#${created.number}`, permalink: created.html_url };
  }

  /** Comments on the issue `threadRef` refers to (`issue:{owner}/{repo}#{number}`). */
  async reply(threadRef: string, body: string): Promise<OutboundResult> {
    const { owner, repo, number } = this._parseIssueRef(threadRef);
    this._assertTargetAllowed(`${owner}/${repo}`);
    const created = await this._withRetry(() =>
      createIssueComment(owner, repo, number, body, this.token, { fetchImpl: this.fetchImpl }));
    return { external_item_id: `comment:${owner}/${repo}#${number}:${created.id}`, permalink: created.html_url };
  }

  /** Closes the issue `threadRef` refers to. Only ever called by the
   *  resolve-notify path, and only when the owning channel opted in
   *  (OutreachChannel.close_on_resolve=true, default false). */
  async close(threadRef: string): Promise<void> {
    const { owner, repo, number } = this._parseIssueRef(threadRef);
    this._assertTargetAllowed(`${owner}/${repo}`);
    await this._withRetry(() => closeIssue(owner, repo, number, this.token, { fetchImpl: this.fetchImpl }));
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _assertTargetAllowed(target: string): { owner: string; repo: string } {
    const normalized = (target || '').trim().toLowerCase();
    if (!this.targets.has(normalized)) {
      throw new GitHubApiError(`target "${target}" is not in this channel's repo whitelist`);
    }
    const parsed = parseTarget(target);
    if (!parsed) throw new GitHubApiError(`target "${target}" is not a valid "owner/repo" string`);
    return parsed;
  }

  private _parseIssueRef(ref: string): { owner: string; repo: string; number: number } {
    const match = (ref || '').match(/^issue:([^/]+)\/([^#]+)#(\d+)$/);
    if (!match) throw new GitHubApiError(`threadRef must be "issue:{owner}/{repo}#{number}", got: ${ref}`);
    return { owner: match[1], repo: match[2], number: Number(match[3]) };
  }

  private async _ensureBotLogin(): Promise<string> {
    if (this.botLogin !== null) return this.botLogin;
    if (!this.botLoginPromise) {
      this.botLoginPromise = this._withRetry(() => getAuthenticatedLogin(this.token, { fetchImpl: this.fetchImpl }))
        .then((login) => login.toLowerCase());
    }
    const login = await this.botLoginPromise;
    this.botLogin = login;
    return login;
  }

  /**
   * Wraps one logical GitHub call: the operator-configured hourly cap check
   * (throws before any network call when exceeded) and reactive retry on a
   * 429 or a 403 that carries a Retry-After header (secondary rate limit). A
   * 403 WITHOUT one is a hard failure (bad token scope, no repo access) —
   * never retried, so it propagates immediately instead of burning the retry
   * budget on a call that will never succeed.
   */
  private async _withRetry<T>(call: () => Promise<T>): Promise<T> {
    let attempt = 0;
    for (;;) {
      this.rateLimiter.checkAndRecord(this.channelId, this.rateLimitPerHour);
      try {
        return await call();
      } catch (e: any) {
        const retryAfterMs = e instanceof GitHubRateLimitError
          ? e.retryAfterMs
          : (e instanceof GitHubForbiddenError ? e.retryAfterMs : undefined);
        if (retryAfterMs === undefined || attempt >= MAX_RATE_LIMIT_RETRIES) throw e;
        attempt++;
        // retryAfterMs is guaranteed defined here (checked above) — a literal
        // 0 must sleep 0ms, not fall back to exponential backoff (0 is falsy,
        // so `retryAfterMs || fallback` would silently do the wrong thing).
        await this.sleepImpl(Math.min(retryAfterMs, MAX_BACKOFF_MS));
      }
    }
  }
}
