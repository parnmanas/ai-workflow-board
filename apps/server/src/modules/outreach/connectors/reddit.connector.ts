/**
 * RedditConnector — the `kind='reddit'` OutreachConnector implementation
 * (ticket d86d0c24, follow-up to 2500fea3's interface + FakeOutreachConnector
 * cut). Deliberately conservative:
 *
 *   - `fetchInbound` ONLY ever hits `/r/{sub}/new` for subreddits listed in
 *     the caller-supplied `targets` (OutreachChannel.targets — a human-curated
 *     whitelist), plus the comment trees of the bot account's OWN submissions
 *     that happen to sit in one of those subreddits. There is no code path
 *     that discovers or expands to a subreddit not in `targets` — the ticket's
 *     explicit anti-scope-creep requirement (self-promotion rules differ per
 *     subreddit and auto-expansion risks a ban/shadowban).
 *   - `publish`/`reply` also reject a target outside `targets` — belt-and-
 *     suspenders on top of the same requirement, since OutreachChannel.targets
 *     is already validated upstream by OutreachChannelService.
 *   - Every request carries the caller-supplied `userAgent` (Reddit API rules
 *     require a descriptive, unique User-Agent identifying the client).
 *
 * `fetchImpl` (default `globalThis.fetch`) is the fake-HTTP seam this ticket
 * introduces — the server had no existing injection point for outbound fetch
 * (github-connector.service.ts, discord.service.ts etc. all call the global
 * directly), so this is the first of its kind here rather than an established
 * convention.
 *
 * Rate limiting: Reddit's per-response `x-ratelimit-remaining`/`x-ratelimit-reset`
 * headers are the authoritative signal and are preferred when present; a 429
 * without usable headers falls back to `Retry-After` (seconds), then a fixed
 * exponential backoff. 403 (subreddit ban / suspended account) is NEVER
 * retried — it is surfaced as `RedditForbiddenError` so the caller (the
 * publisher/polling service) can record it on channel state distinctly from a
 * transient rate-limit failure.
 */
import { InboundItem, OutboundPost, OutboundResult, OutreachConnector } from './types';

export class RedditConnectorConfigError extends Error {
  readonly code = 'config_error';
}

export class RedditForbiddenError extends Error {
  readonly code = 'forbidden';
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export class RedditRateLimitError extends Error {
  readonly code = 'rate_limited';
}

export class RedditApiError extends Error {
  readonly code = 'api_error';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';

// Refresh this many ms before the token's real expiry so an in-flight request
// never races a just-expired token.
const TOKEN_EXPIRY_BUFFER_MS = 30_000;

const MAX_RATE_LIMIT_RETRIES = 3;
const BASE_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export interface RedditCredentialLike {
  username?: string;
  token: string;
  extra: Record<string, string>;
}

export interface RedditConnectorOptions {
  targets: string[];
  userAgent: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

interface AccessToken {
  value: string;
  expiresAtMs: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RedditConnector implements OutreachConnector {
  private readonly targets: Set<string>;
  private readonly userAgent: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly grantMode: 'refresh_token' | 'password';
  private readonly grantSecret: string; // refresh_token value OR script-app password
  private readonly username: string;

  private accessToken: AccessToken | null = null;
  // Guards a single forced-refresh-and-retry per external call — prevents an
  // infinite loop if the server keeps handing back 401 for a bad credential.
  private refreshInFlight: Promise<void> | null = null;

  constructor(cred: RedditCredentialLike, opts: RedditConnectorOptions) {
    const clientId = (cred.extra?.client_id || '').trim();
    const clientSecret = (cred.extra?.client_secret || '').trim();
    if (!clientId || !clientSecret) {
      throw new RedditConnectorConfigError('Reddit credential is missing client_id/client_secret');
    }
    this.clientId = clientId;
    this.clientSecret = clientSecret;

    const authMode = (cred.extra?.auth_mode || 'installed_app').trim();
    if (authMode === 'script') {
      if (!cred.username) throw new RedditConnectorConfigError('script auth_mode requires a username');
      this.grantMode = 'password';
    } else {
      this.grantMode = 'refresh_token';
    }
    if (!cred.token) throw new RedditConnectorConfigError('Reddit credential is missing token (refresh_token or bot password)');
    this.grantSecret = cred.token;
    this.username = cred.username || '';

    if (!opts.userAgent || !opts.userAgent.trim()) {
      throw new RedditConnectorConfigError('userAgent is required (Reddit API rejects generic/default User-Agents)');
    }
    this.userAgent = opts.userAgent.trim();
    this.targets = new Set((opts.targets || []).map((t) => t.trim().toLowerCase()).filter(Boolean));
    this.fetchImpl = opts.fetchImpl || globalThis.fetch;
    this.sleepImpl = opts.sleepImpl || defaultSleep;
  }

  /**
   * Inbound = new posts in whitelisted subreddits + the comment tree of the
   * bot account's own submissions that live in a whitelisted subreddit. Empty
   * `targets` short-circuits to `[]` without any network call — fail-closed,
   * never falls back to "everything"/"discover subreddits".
   */
  async fetchInbound(since: string): Promise<InboundItem[]> {
    if (this.targets.size === 0) return [];
    const sinceMs = since ? new Date(since).getTime() : 0;
    const threshold = Number.isFinite(sinceMs) ? sinceMs : 0;

    const items: InboundItem[] = [];
    for (const sub of this.targets) {
      const listing = await this._request<any>('GET', `/r/${encodeURIComponent(sub)}/new?limit=25&raw_json=1`);
      for (const child of listing?.data?.children || []) {
        const post = child?.data;
        if (!post) continue;
        items.push(this._postToItem(post));
      }
    }

    if (this.username) {
      const submitted = await this._request<any>('GET', `/user/${encodeURIComponent(this.username)}/submitted?limit=25&raw_json=1`);
      for (const child of submitted?.data?.children || []) {
        const post = child?.data;
        if (!post || !this.targets.has(String(post.subreddit || '').toLowerCase())) continue;
        const commentTree = await this._request<any>('GET', `/comments/${post.id}?limit=200&depth=10&raw_json=1`);
        const commentsListing = Array.isArray(commentTree) ? commentTree[1] : null;
        for (const child2 of commentsListing?.data?.children || []) {
          this._flattenComment(child2, items);
        }
      }
    }

    const seen = new Set<string>();
    const deduped = items.filter((i) => {
      if (seen.has(i.external_item_id)) return false;
      seen.add(i.external_item_id);
      return true;
    });
    return deduped
      .filter((i) => i.created_at.getTime() > threshold)
      .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  }

  /** Self-post a new top-level submission. `post.target` must be a whitelisted subreddit. */
  async publish(post: OutboundPost): Promise<OutboundResult> {
    this._assertTargetAllowed(post.target);
    const body = new URLSearchParams({
      sr: post.target,
      kind: 'self',
      title: post.title,
      text: post.body,
      api_type: 'json',
      sendreplies: 'true',
    });
    const result = await this._request<any>('POST', '/api/submit', body);
    const errors = result?.json?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new RedditApiError(`Reddit rejected submit: ${JSON.stringify(errors)}`);
    }
    const data = result?.json?.data;
    if (!data?.name) throw new RedditApiError('Reddit submit response missing post name/id');
    return { external_item_id: data.name, permalink: this._absolutePermalink(data.url) };
  }

  /** Reply to an existing thing (post or comment). `threadRef` is a Reddit fullname (t3_/t1_). */
  async reply(threadRef: string, body: string): Promise<OutboundResult> {
    if (!threadRef || !/^t[13]_/.test(threadRef)) {
      throw new RedditApiError(`threadRef must be a Reddit fullname (t1_.../t3_...), got: ${threadRef}`);
    }
    const form = new URLSearchParams({
      thing_id: threadRef,
      text: body,
      api_type: 'json',
    });
    const result = await this._request<any>('POST', '/api/comment', form);
    const errors = result?.json?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      throw new RedditApiError(`Reddit rejected comment: ${JSON.stringify(errors)}`);
    }
    const thing = result?.json?.data?.things?.[0]?.data;
    if (!thing?.name) throw new RedditApiError('Reddit comment response missing comment name/id');
    return { external_item_id: thing.name, permalink: this._absolutePermalink(thing.permalink || '') };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private _assertTargetAllowed(target: string): void {
    if (!this.targets.has((target || '').trim().toLowerCase())) {
      throw new RedditApiError(`target "${target}" is not in this channel's subreddit whitelist`);
    }
  }

  private _postToItem(post: any): InboundItem {
    return {
      external_item_id: post.name, // t3_xxx fullname
      title: post.title || '',
      body: post.selftext || '',
      author: post.author || '',
      permalink: this._absolutePermalink(post.permalink || ''),
      created_at: new Date((post.created_utc || 0) * 1000),
    };
  }

  private _flattenComment(node: any, out: InboundItem[]): void {
    const data = node?.data;
    if (!data || node.kind !== 't1') return;
    out.push({
      external_item_id: data.name,
      title: '',
      body: data.body || '',
      author: data.author || '',
      permalink: this._absolutePermalink(data.permalink || ''),
      created_at: new Date((data.created_utc || 0) * 1000),
    });
    const replies = data.replies;
    const children = replies && typeof replies === 'object' ? replies?.data?.children : null;
    for (const child of children || []) this._flattenComment(child, out);
  }

  private _absolutePermalink(permalink: string): string {
    if (!permalink) return '';
    return permalink.startsWith('http') ? permalink : `https://www.reddit.com${permalink}`;
  }

  private async _ensureToken(forceRefresh = false): Promise<string> {
    const now = Date.now();
    if (!forceRefresh && this.accessToken && this.accessToken.expiresAtMs - TOKEN_EXPIRY_BUFFER_MS > now) {
      return this.accessToken.value;
    }
    if (!this.refreshInFlight) {
      this.refreshInFlight = this._refreshToken().finally(() => {
        this.refreshInFlight = null;
      });
    }
    await this.refreshInFlight;
    if (!this.accessToken) throw new RedditApiError('Reddit OAuth token refresh did not populate an access token');
    return this.accessToken.value;
  }

  private async _refreshToken(): Promise<void> {
    const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
    const form = this.grantMode === 'password'
      ? new URLSearchParams({ grant_type: 'password', username: this.username, password: this.grantSecret })
      : new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.grantSecret });

    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': this.userAgent,
      },
      body: form.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RedditApiError(`Reddit OAuth token request failed (${res.status}): ${text.slice(0, 200)}`, res.status);
    }
    const json: any = await res.json();
    if (!json?.access_token) throw new RedditApiError('Reddit OAuth response missing access_token');
    const expiresInMs = (Number(json.expires_in) || 3600) * 1000;
    this.accessToken = { value: json.access_token, expiresAtMs: Date.now() + expiresInMs };
  }

  /**
   * Shared request path for every non-OAuth Reddit API call: attaches the
   * bearer token + User-Agent, retries once on 401 (forced token refresh),
   * retries a bounded number of times on 429 (Retry-After / rate-limit
   * headers / exponential fallback), and NEVER retries on 403 (surfaced as
   * RedditForbiddenError so the caller can distinguish "banned/blocked" from
   * "transient").
   */
  private async _request<T>(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<T> {
    let attempt = 0;
    let forceTokenRefresh = false;
    let didForce401Retry = false;

    for (;;) {
      const token = await this._ensureToken(forceTokenRefresh);
      forceTokenRefresh = false;

      const headers: Record<string, string> = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': this.userAgent,
      };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';

      const res = await this.fetchImpl(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? body.toString() : undefined,
      });

      if (res.status === 401 && !didForce401Retry) {
        didForce401Retry = true;
        forceTokenRefresh = true;
        continue;
      }

      if (res.status === 403) {
        const text = await res.text().catch(() => '');
        throw new RedditForbiddenError(`Reddit forbidden (403) on ${method} ${path}: ${text.slice(0, 200)}`, 403);
      }

      if (res.status === 429) {
        if (attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw new RedditRateLimitError(`Reddit rate limit exceeded after ${attempt} retries on ${method} ${path}`);
        }
        const waitMs = this._resolveRateLimitWaitMs(res.headers, attempt);
        attempt++;
        await this.sleepImpl(waitMs);
        continue;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new RedditApiError(`Reddit API ${method} ${path} failed (${res.status}): ${text.slice(0, 200)}`, res.status);
      }

      return (await res.json()) as T;
    }
  }

  /** Retry-After (seconds) takes priority when present; else the x-ratelimit-reset
   *  header (seconds until the window resets); else a bounded exponential backoff. */
  private _resolveRateLimitWaitMs(headers: Headers | undefined, attempt: number): number {
    const retryAfter = headers?.get?.('retry-after');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    const resetSeconds = headers?.get?.('x-ratelimit-reset');
    if (resetSeconds) {
      const seconds = Number(resetSeconds);
      if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
    }
    return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  }
}
