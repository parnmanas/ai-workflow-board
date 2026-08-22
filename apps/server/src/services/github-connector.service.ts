import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { decrypt } from './encryption.service';

const GITHUB_API = 'https://api.github.com';

export interface RepoInfo {
  full_name: string;
  description: string;
  html_url: string;
  default_branch: string;
  language: string;
  topics: string[];
  stargazers_count: number;
  updated_at: string;
  readme_content: string;
  file_tree: string[];
}

export interface GitHubSearchResult {
  total_count: number;
  items: any[];
}

export interface GitHubWorkflow {
  id: string;
  name: string;
  path: string;
  state: string;
}

// conclusion is null while a run is still in progress — only 'completed'
// status runs (queried by CiHealthMonitorService) ever carry a non-null one.
export interface GitHubWorkflowRun {
  id: string;
  status: string;
  conclusion: string | null;
  /** 트리거 이벤트('push'/'schedule'/'workflow_dispatch' 등). */
  event: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  // Commit SHA the run was triggered against. Empty string if the caller's
  // mapped source didn't carry one (defensive default, not expected from a
  // real GitHub response) — `await_ci_run`/CiWaitResumeService match on this
  // to catch a run id that no longer corresponds to the SHA it was
  // registered against.
  head_sha: string;
}

// Pure helpers — no DB, no config. Kept as standalone exports.

/**
 * owner/repo are caller-supplied (the `fetch_github_info` MCP tool takes them as
 * free-form strings) and get interpolated straight into the REST path. Without a
 * charset check a value like `../../user/repos?visibility=private&` normalizes the
 * URL away from /repos/... entirely and re-points the request at another GitHub
 * endpoint — still carrying the server's stored token. Anchored to GitHub's own
 * naming rules so the segment cannot contain `/`, `.`, `?`, `#` or whitespace and
 * path traversal / query injection is structurally impossible.
 */
const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]{1,100}$/;

export class GitHubInvalidRepoRefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubInvalidRepoRefError';
  }
}

/**
 * Validates an owner/repo pair before it reaches the REST path. Returns the pair
 * unchanged so call sites can inline it. Throws GitHubInvalidRepoRefError — callers
 * surface it as a normal "invalid input" error, never as a GitHub API failure.
 */
export function assertRepoRef(owner: unknown, repo: unknown): { owner: string; repo: string } {
  if (typeof owner !== 'string' || !GITHUB_OWNER_RE.test(owner)) {
    throw new GitHubInvalidRepoRefError(`Invalid GitHub owner: ${JSON.stringify(owner)}`);
  }
  // `.` and `..` are valid per the charset but are path-traversal segments.
  if (typeof repo !== 'string' || !GITHUB_REPO_RE.test(repo) || repo === '.' || repo === '..') {
    throw new GitHubInvalidRepoRefError(`Invalid GitHub repo: ${JSON.stringify(repo)}`);
  }
  return { owner, repo };
}

/** Non-throwing form of {@link assertRepoRef}, for call sites that degrade
 *  (return ''/[]) on an unusable repo ref rather than surfacing an error. */
export function isValidRepoRef(owner: unknown, repo: unknown): boolean {
  try {
    assertRepoRef(owner, repo);
    return true;
  } catch {
    return false;
  }
}

/**
 * GitHub Actions run ids are positive decimal integers. Bounded to 20 digits
 * (the decimal-digit ceiling of a 64-bit unsigned int, `18446744073709551615`)
 * — enormously more than GitHub will ever issue, but a real technical bound
 * rather than an arbitrary guess, so a caller-supplied string that is
 * non-numeric, empty, or absurdly long (injection attempt, copy-paste
 * mistake, truncation-hiding-a-mismatch) is rejected outright rather than
 * silently accepted or truncated (ticket 778b6dc7 review — external
 * identifiers must satisfy the real format in full, never be silently cut
 * down to fit).
 */
const GITHUB_RUN_ID_RE = /^[1-9][0-9]{0,19}$/;

/** Full 40-hex-char SHA-1 commit hash — what `git rev-parse <ref>` (no
 *  `--short`) and GitHub's REST API both produce. Case-insensitive on input;
 *  callers should normalize to lowercase before storing/comparing (GitHub's
 *  own `head_sha` is always lowercase). */
const GIT_SHA_RE = /^[0-9a-f]{40}$/i;

export function isValidGitHubRunId(runId: unknown): boolean {
  return typeof runId === 'string' && GITHUB_RUN_ID_RE.test(runId);
}

export function isValidGitSha(sha: unknown): boolean {
  return typeof sha === 'string' && GIT_SHA_RE.test(sha);
}

/**
 * Last line of defense before any request leaves for GitHub. Every REST path in
 * this file is assembled by template-string interpolation, so a single unvalidated
 * segment anywhere re-points the request. Normalizing here and re-checking the
 * origin *and* prefix means a traversal that slips past an entry-point check still
 * cannot reach an unintended endpoint with the server's token. Returns the
 * normalized absolute URL for the caller to fetch.
 */
export function assertGitHubApiUrl(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) {
    throw new GitHubInvalidRepoRefError(`Invalid GitHub API path: ${JSON.stringify(path)}`);
  }
  const url = new URL(`${GITHUB_API}${path}`);
  if (url.origin !== GITHUB_API) {
    throw new GitHubInvalidRepoRefError(`GitHub API path escaped the API origin: ${JSON.stringify(path)}`);
  }
  // `..` segments normalize away silently — and the origin survives that, so the
  // check above cannot see it. Reject traversal segments explicitly instead of
  // comparing normalized-vs-raw, which would false-positive on percent-encoding.
  const segments = path.split(/[?#]/)[0].split('/');
  if (segments.some((s) => s === '.' || s === '..' || s === '%2e' || s.toLowerCase() === '%2e%2e')) {
    throw new GitHubInvalidRepoRefError(`GitHub API path contains traversal: ${JSON.stringify(path)}`);
  }
  return url.href;
}

export function parseGitHubUrl(url: string): { owner: string; repo: string } | null {
  const match = url.match(/github\.com\/([^/\s#?]+)\/([^/\s#?]+)/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/, '');
  // A URL that parses but carries an out-of-charset segment is rejected here
  // rather than being handed to the REST path — same guarantee as assertRepoRef.
  if (!GITHUB_OWNER_RE.test(owner) || !GITHUB_REPO_RE.test(repo) || repo === '.' || repo === '..') {
    return null;
  }
  return { owner, repo };
}

export function buildSyncContent(info: RepoInfo): string {
  const parts: string[] = [];
  parts.push(`# ${info.full_name}`);
  if (info.description) parts.push(`\n${info.description}`);
  parts.push(`\nURL: ${info.html_url}`);
  parts.push(`Branch: ${info.default_branch}`);
  if (info.language) parts.push(`Language: ${info.language}`);
  if (info.topics.length > 0) parts.push(`Topics: ${info.topics.join(', ')}`);
  parts.push(`Stars: ${info.stargazers_count}`);
  parts.push(`Updated: ${info.updated_at}`);

  if (info.readme_content) {
    parts.push(`\n---\n## README\n\n${info.readme_content}`);
  }

  if (info.file_tree.length > 0) {
    parts.push(`\n---\n## File Tree (${info.file_tree.length} files)\n`);
    parts.push(info.file_tree.join('\n'));
  }

  return parts.join('\n');
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  user: string;
  state: string;
  created_at: string;
  updated_at: string;
}

export interface GitHubIssueComment {
  id: number;
  body: string;
  html_url: string;
  user: string;
  created_at: string;
  updated_at: string;
}

export class GitHubApiError extends Error {
  readonly code = 'api_error';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class GitHubForbiddenError extends Error {
  readonly code = 'forbidden';
  /** Present when the response carried a `Retry-After` header — GitHub's
   *  signal that this 403 is a retryable secondary rate limit / abuse-detection
   *  block, not a permission failure. Absent → the caller should treat this as
   *  a hard failure (bad token scope, private repo, etc.), never retried. */
  constructor(message: string, readonly status: number, readonly retryAfterMs?: number) {
    super(message);
  }
}

export class GitHubRateLimitError extends Error {
  readonly code = 'rate_limited';
  constructor(message: string, readonly retryAfterMs: number = 60_000) {
    super(message);
  }
}

/** No token resolved for the request (neither the given credential_id nor
 *  the env fallback) — the one failure mode every caller of `githubFetch`
 *  has always treated as a quiet "nothing configured" degrade, never a real
 *  error worth surfacing (ticket cc1c494e review — kept that contract). */
export class GitHubNoTokenError extends Error {
  readonly code = 'no_token';
  constructor() {
    super('GitHub token not configured');
  }
}

/**
 * True for the two failure modes `listWorkflows`/`listWorkflowRuns`/
 * `listRunFailedJobs` are allowed to swallow into `[]`: no token resolved,
 * or a 404 (repo/workflow/run doesn't exist — not a monitoring failure).
 * Everything else (401/403/429/5xx, network errors) is NOT degradable and
 * must propagate so the caller can observe and log the failure instead of
 * silently treating a broken credential or a GitHub outage as "nothing to
 * report" (ticket cc1c494e review — this exact silence was the bug: a
 * watchdog whose own reads fail open reproduces the silent-red failure mode
 * it exists to catch).
 */
export function isGitHubDegradableError(error: unknown): boolean {
  if (error instanceof GitHubNoTokenError) return true;
  if (error instanceof GitHubApiError && error.status === 404) return true;
  return false;
}

export interface GitHubApiCallOptions {
  method?: 'GET' | 'POST' | 'PATCH';
  body?: unknown;
  fetchImpl?: typeof fetch;
}

/**
 * Single-shot GitHub REST call taking an already-resolved token directly (no
 * credential_id, no DB) — extends this file's existing "pure helpers, no
 * DB/config" section rather than introducing a second GitHub HTTP client
 * (ticket 31e7cd24's explicit constraint). `GitHubConnectorService.githubFetch`
 * below stays as-is for the credential_id-resolving MCP tools
 * (fetch_github_info/search_github/sync_github_resource); this is the same
 * REST surface, parameterized by a raw token for a caller (the outreach
 * GitHubConnector) that resolves auth through a different, workspace-scope-
 * checked path (outreach-credential.ts) and must never touch the Credential
 * table itself (connectors/types.ts's documented connector boundary).
 *
 * No retry here — single call only, so the caller can inspect response
 * headers (x-ratelimit-remaining/x-ratelimit-reset) between its own retries.
 */
export async function githubApiCall(path: string, token: string, opts: GitHubApiCallOptions = {}): Promise<Response> {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `Bearer ${token}`,
    'User-Agent': 'AWB-GitHub-Connector',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(opts.body);
  }
  return fetchImpl(assertGitHubApiUrl(path), { method: opts.method || 'GET', headers, body });
}

/**
 * Throws the appropriately-typed error for a non-ok response — 403 (secondary
 * rate limit / abuse detection) as GitHubForbiddenError, 429 (primary rate
 * limit exceeded) as GitHubRateLimitError (retryAfterMs from the `Retry-After`
 * header when present), everything else as GitHubApiError. No-op for ok responses.
 */
export async function assertGitHubOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const text = await res.text().catch(() => '');
  // headers.get() returns null when the header is absent — Number(null) is 0
  // (a valid, truthy-adjacent number), NOT NaN, so the absent case must be
  // checked explicitly before converting; otherwise "no Retry-After header"
  // silently becomes "retry after 0ms" instead of "not retryable" (403) /
  // "fall back to the 60s default" (429).
  const retryAfterHeader = res.headers.get('retry-after');
  const retryAfterSeconds = retryAfterHeader !== null ? Number(retryAfterHeader) : NaN;
  const retryAfterMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0 ? retryAfterSeconds * 1000 : undefined;
  if (res.status === 403) {
    throw new GitHubForbiddenError(`GitHub forbidden (403) on ${context}: ${text.slice(0, 200)}`, 403, retryAfterMs);
  }
  if (res.status === 429) {
    throw new GitHubRateLimitError(`GitHub rate limit exceeded on ${context}`, retryAfterMs ?? 60_000);
  }
  throw new GitHubApiError(`GitHub API ${context} failed (${res.status}): ${text.slice(0, 200)}`, res.status);
}

/**
 * Open issues updated at/after `since` (ISO timestamp, '' = all), oldest
 * first, PRs filtered out (GitHub's issues endpoint includes pull requests —
 * each carries a `pull_request` key issues never do). `since` matches on
 * UPDATED time, not created time, so one call naturally covers both brand-new
 * issues and issues whose body/comments changed — the connector layer decides
 * "new" vs. "already ticketed" from OutreachInboundItem, not from this endpoint.
 */
export async function listOpenIssuesSince(
  owner: string, repo: string, since: string, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<GitHubIssue[]> {
  assertRepoRef(owner, repo);
  const qs = new URLSearchParams({ state: 'open', sort: 'updated', direction: 'asc', per_page: '100' });
  if (since) qs.set('since', since);
  const res = await githubApiCall(`/repos/${owner}/${repo}/issues?${qs}`, token, { fetchImpl: opts.fetchImpl });
  await assertGitHubOk(res, `GET issues ${owner}/${repo}`);
  const data: any[] = await res.json();
  return data
    .filter((i) => !('pull_request' in i))
    .map((i) => ({
      number: i.number,
      title: i.title || '',
      body: i.body || '',
      html_url: i.html_url,
      user: i.user?.login || '',
      state: i.state,
      created_at: i.created_at,
      updated_at: i.updated_at,
    }));
}

/** Comments on one issue created at/after `since` ('' = all), oldest first. */
export async function listIssueCommentsSince(
  owner: string, repo: string, issueNumber: number, since: string, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<GitHubIssueComment[]> {
  assertRepoRef(owner, repo);
  const qs = new URLSearchParams({ per_page: '100' });
  if (since) qs.set('since', since);
  const res = await githubApiCall(`/repos/${owner}/${repo}/issues/${issueNumber}/comments?${qs}`, token, { fetchImpl: opts.fetchImpl });
  await assertGitHubOk(res, `GET issue comments ${owner}/${repo}#${issueNumber}`);
  const data: any[] = await res.json();
  return data.map((c) => ({
    id: c.id,
    body: c.body || '',
    html_url: c.html_url,
    user: c.user?.login || '',
    created_at: c.created_at,
    updated_at: c.updated_at,
  }));
}

/**
 * Files changed between two commits (paths only, oldest→newest semantics N/A
 * — order matches GitHub's response). Used by the release-consistency check
 * (ticket 31e7cd24 범위 3) to detect doc-vs-code drift; `base`/`head` accept
 * any git ref GitHub's compare endpoint does (full sha, short sha, branch).
 */
export async function compareCommits(
  owner: string, repo: string, base: string, head: string, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<string[]> {
  assertRepoRef(owner, repo);
  const res = await githubApiCall(`/repos/${owner}/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`, token, { fetchImpl: opts.fetchImpl });
  await assertGitHubOk(res, `GET compare ${owner}/${repo} ${base}...${head}`);
  const data = await res.json();
  const files: any[] = Array.isArray(data.files) ? data.files : [];
  return files.map((f) => f.filename).filter((f) => typeof f === 'string');
}

/** Posts a new comment on an issue; returns its id + permalink. */
export async function createIssueComment(
  owner: string, repo: string, issueNumber: number, body: string, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ id: number; html_url: string }> {
  assertRepoRef(owner, repo);
  const res = await githubApiCall(`/repos/${owner}/${repo}/issues/${issueNumber}/comments`, token, {
    method: 'POST', body: { body }, fetchImpl: opts.fetchImpl,
  });
  await assertGitHubOk(res, `POST issue comment ${owner}/${repo}#${issueNumber}`);
  const data = await res.json();
  return { id: data.id, html_url: data.html_url };
}

/** Opens a new issue; returns its number + permalink (the closest GitHub
 *  analog to OutreachConnector.publish's "new top-level post"). */
export async function createIssue(
  owner: string, repo: string, title: string, body: string, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<{ number: number; html_url: string }> {
  assertRepoRef(owner, repo);
  const res = await githubApiCall(`/repos/${owner}/${repo}/issues`, token, {
    method: 'POST', body: { title, body }, fetchImpl: opts.fetchImpl,
  });
  await assertGitHubOk(res, `POST issue ${owner}/${repo}`);
  const data = await res.json();
  return { number: data.number, html_url: data.html_url };
}

/** Closes an issue. Never called unless the owning OutreachChannel opted in
 *  (close_on_resolve=true, default false) — see connectors/github.connector.ts. */
export async function closeIssue(
  owner: string, repo: string, issueNumber: number, token: string, opts: { fetchImpl?: typeof fetch } = {},
): Promise<void> {
  assertRepoRef(owner, repo);
  const res = await githubApiCall(`/repos/${owner}/${repo}/issues/${issueNumber}`, token, {
    method: 'PATCH', body: { state: 'closed' }, fetchImpl: opts.fetchImpl,
  });
  await assertGitHubOk(res, `PATCH close issue ${owner}/${repo}#${issueNumber}`);
}

/** The authenticated user's own login — used to filter the bot's own
 *  comments out of fetchInbound (self-referential loop prevention). */
export async function getAuthenticatedLogin(token: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<string> {
  const res = await githubApiCall('/user', token, { fetchImpl: opts.fetchImpl });
  await assertGitHubOk(res, 'GET authenticated user');
  const data = await res.json();
  return data.login || '';
}

/**
 * GitHub REST v3 client with DB-backed credential resolution.
 *
 * Previously held `let _dataSource = null` with a `setGitHubDataSource()`
 * setter that three code paths had to remember to call. Now the DataSource
 * is a constructor dependency — impossible to forget, and tests can inject
 * an in-memory source.
 *
 * Two construction paths:
 *   - NestJS: injected via constructor (provider in SharedServicesModule)
 *   - Standalone (mcp-server.ts): `new GitHubConnectorService(dataSource)`
 */
@Injectable()
export class GitHubConnectorService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  private getEnvToken(): string {
    return process.env.GITHUB_TOKEN || '';
  }

  async getTokenForCredential(credentialId: string): Promise<string> {
    if (!this.dataSource?.isInitialized) return '';
    try {
      const repo = this.dataSource.getRepository('Credential');
      const cred = await repo.findOne({ where: { id: credentialId } });
      if (!cred) return '';
      const data = JSON.parse(decrypt((cred as any).encrypted_data));
      return data.token || data.api_key || '';
    } catch {
      return '';
    }
  }

  async resolveToken(credentialId?: string | null): Promise<string> {
    if (credentialId) {
      const token = await this.getTokenForCredential(credentialId);
      if (token) return token;
    }
    return this.getEnvToken();
  }

  async isEnabled(credentialId?: string | null): Promise<boolean> {
    const token = await this.resolveToken(credentialId);
    return !!token;
  }

  private async githubFetch(
    path: string,
    credentialId?: string | null,
    fetchImpl: typeof fetch = fetch,
  ): Promise<any> {
    const token = await this.resolveToken(credentialId);
    if (!token) throw new GitHubNoTokenError();

    const res = await fetchImpl(assertGitHubApiUrl(path), {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'AWB-GitHub-Connector',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    // Typed errors (GitHubForbiddenError/GitHubRateLimitError/GitHubApiError)
    // so callers can tell "not found" apart from an auth/rate-limit/server
    // failure — see isGitHubDegradableError.
    await assertGitHubOk(res, path);
    return res.json();
  }

  /**
   * Read the tip commit SHA for a branch via the public REST endpoint.
   * Used by `ClaimVerificationService` (ticket dcb9d661) to detect
   * whether an assignee actually committed between trigger time and
   * their "done" comment. Returns the empty string on any failure
   * (missing token, missing branch, network) so the caller can degrade
   * gracefully — the sweep is informational, not gating, on the SHA.
   */
  async fetchBranchTipSha(owner: string, repo: string, branch: string, credentialId?: string | null): Promise<string> {
    // Same degrade contract as the missing-arg guard above it: an out-of-charset
    // ref is not a usable repo, and must never reach the REST path.
    if (!owner || !repo || !branch || !isValidRepoRef(owner, repo)) return '';
    try {
      const data = await this.githubFetch(
        `/repos/${owner}/${repo}/branches/${encodeURIComponent(branch)}`,
        credentialId,
      );
      const sha = data?.commit?.sha;
      return typeof sha === 'string' ? sha : '';
    } catch {
      return '';
    }
  }

  /**
   * Active workflows for a repo (ticket cc1c494e — `CiHealthMonitorService`
   * needs to enumerate what to sweep without a hardcoded workflow id, since
   * one is repo-specific and this connector serves every board's repo).
   * Degrades to `[]` on missing token / 404 — "nothing configured" / "repo
   * doesn't have this" are not failures. Any other error (401/403/429/5xx,
   * network) PROPAGATES — the caller must observe and log it, not treat a
   * broken credential or a GitHub outage as "nothing to check this pass"
   * (ticket cc1c494e review — see `isGitHubDegradableError`).
   */
  async listWorkflows(
    owner: string, repo: string, credentialId?: string | null, fetchImpl?: typeof fetch,
  ): Promise<GitHubWorkflow[]> {
    if (!owner || !repo || !isValidRepoRef(owner, repo)) return [];
    try {
      const data = await this.githubFetch(`/repos/${owner}/${repo}/actions/workflows`, credentialId, fetchImpl);
      const workflows: any[] = Array.isArray(data?.workflows) ? data.workflows : [];
      return workflows
        .filter((w) => w?.state === 'active')
        .map((w) => ({ id: String(w.id), name: w.name || '', path: w.path || '', state: w.state || '' }));
    } catch (e) {
      if (isGitHubDegradableError(e)) return [];
      throw e;
    }
  }

  /**
   * Most recent COMPLETED runs of one workflow on one branch, newest first
   * (GitHub's default order) — `evaluateRedStreak` only ever needs a short
   * recent window, not full history. Same degrade/propagate contract as
   * `listWorkflows`.
   */
  async listWorkflowRuns(
    owner: string, repo: string, workflowId: string, branch: string,
    credentialId?: string | null, fetchImpl?: typeof fetch,
  ): Promise<GitHubWorkflowRun[]> {
    if (!owner || !repo || !workflowId || !branch || !isValidRepoRef(owner, repo)) return [];
    try {
      const qs = new URLSearchParams({ branch, status: 'completed', per_page: '5' });
      const data = await this.githubFetch(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/runs?${qs}`,
        credentialId,
        fetchImpl,
      );
      const runs: any[] = Array.isArray(data?.workflow_runs) ? data.workflow_runs : [];
      return runs.map((r) => ({
        id: String(r.id),
        status: r.status || '',
        conclusion: r.conclusion ?? null,
        event: r.event || '',
        html_url: r.html_url || '',
        created_at: r.created_at || '',
        updated_at: r.updated_at || '',
        head_sha: r.head_sha || '',
      }));
    } catch (e) {
      if (isGitHubDegradableError(e)) return [];
      throw e;
    }
  }

  /**
   * One specific run by id (ticket 778b6dc7 — CiWaitResumeService polls a
   * SINGLE registered run rather than scanning recent runs the way
   * `listWorkflowRuns`/CiHealthMonitorService do). Same degrade/propagate
   * contract as `listWorkflowRuns`: null on missing token / 404 (run
   * deleted, repo gone, bad id), everything else propagates so the poller
   * observes and logs rather than silently treating a broken credential or
   * an outage as "not resolved yet".
   */
  async getWorkflowRun(
    owner: string, repo: string, runId: string, credentialId?: string | null, fetchImpl?: typeof fetch,
  ): Promise<GitHubWorkflowRun | null> {
    if (!owner || !repo || !runId || !isValidRepoRef(owner, repo)) return null;
    try {
      const data = await this.githubFetch(
        `/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}`,
        credentialId,
        fetchImpl,
      );
      return {
        id: String(data.id),
        status: data.status || '',
        conclusion: data.conclusion ?? null,
        html_url: data.html_url || '',
        created_at: data.created_at || '',
        updated_at: data.updated_at || '',
        head_sha: data.head_sha || '',
      };
    } catch (e) {
      if (isGitHubDegradableError(e)) return null;
      throw e;
    }
  }

  /** Names of the non-successful jobs within one run (for the alert message
   *  body — "which job(s) actually failed"). Same degrade/propagate contract
   *  as `listWorkflows` — this one is decorative (the caller still posts the
   *  alert without job names on failure), but the failure itself must still
   *  reach the caller to log, not vanish into an empty array. */
  async listRunFailedJobs(
    owner: string, repo: string, runId: string, credentialId?: string | null, fetchImpl?: typeof fetch,
  ): Promise<string[]> {
    if (!owner || !repo || !runId || !isValidRepoRef(owner, repo)) return [];
    try {
      const data = await this.githubFetch(`/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(runId)}/jobs`, credentialId, fetchImpl);
      const jobs: any[] = Array.isArray(data?.jobs) ? data.jobs : [];
      return jobs
        .filter((j) => j?.conclusion && j.conclusion !== 'success')
        .map((j) => j.name || '(unnamed job)');
    } catch (e) {
      if (isGitHubDegradableError(e)) return [];
      throw e;
    }
  }

  async fetchRepoInfo(owner: string, repo: string, credentialId?: string | null): Promise<RepoInfo> {
    // Reached straight from the `fetch_github_info` MCP tool, whose owner/repo are
    // free-form caller input — validate before it becomes a REST path. Throws
    // (rather than degrading) so the tool reports bad input instead of "not found".
    assertRepoRef(owner, repo);
    const repoData = await this.githubFetch(`/repos/${owner}/${repo}`, credentialId);

    let readmeContent = '';
    try {
      const token = await this.resolveToken(credentialId);
      const readmeRes = await fetch(
        assertGitHubApiUrl(`/repos/${owner}/${repo}/readme`),
        {
          headers: {
            'Accept': 'application/vnd.github.v3.raw',
            'Authorization': `Bearer ${token}`,
            'User-Agent': 'AWB-GitHub-Connector',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (readmeRes.ok) {
        readmeContent = await readmeRes.text();
        if (readmeContent.length > 10000) {
          readmeContent = readmeContent.slice(0, 10000) + '\n\n[truncated]';
        }
      }
    } catch {}

    let fileTree: string[] = [];
    try {
      const treeData = await this.githubFetch(
        `/repos/${owner}/${repo}/git/trees/${repoData.default_branch}?recursive=1`,
        credentialId,
      );
      if (treeData.tree) {
        fileTree = treeData.tree
          .filter((item: any) => item.type === 'blob')
          .map((item: any) => item.path)
          .slice(0, 500);
      }
    } catch {}

    let topics: string[] = [];
    try {
      const topicsData = await this.githubFetch(`/repos/${owner}/${repo}/topics`, credentialId);
      topics = topicsData.names || [];
    } catch {}

    return {
      full_name: repoData.full_name,
      description: repoData.description || '',
      html_url: repoData.html_url,
      default_branch: repoData.default_branch,
      language: repoData.language || '',
      topics,
      stargazers_count: repoData.stargazers_count || 0,
      updated_at: repoData.updated_at,
      readme_content: readmeContent,
      file_tree: fileTree,
    };
  }

  async searchRepos(query: string, opts?: { per_page?: number; sort?: string; credential_id?: string | null }): Promise<GitHubSearchResult> {
    const perPage = opts?.per_page ?? 10;
    const sort = opts?.sort ?? 'best-match';
    const qs = new URLSearchParams({ q: query, per_page: String(perPage), sort });
    const data = await this.githubFetch(`/search/repositories?${qs.toString()}`, opts?.credential_id);
    return {
      total_count: data.total_count,
      items: (data.items || []).map((r: any) => ({
        full_name: r.full_name,
        description: r.description || '',
        html_url: r.html_url,
        language: r.language || '',
        stargazers_count: r.stargazers_count,
        topics: r.topics || [],
        updated_at: r.updated_at,
      })),
    };
  }

  async searchCode(query: string, opts?: { per_page?: number; credential_id?: string | null }): Promise<GitHubSearchResult> {
    const perPage = opts?.per_page ?? 10;
    const qs = new URLSearchParams({ q: query, per_page: String(perPage) });
    const data = await this.githubFetch(`/search/code?${qs.toString()}`, opts?.credential_id);
    return {
      total_count: data.total_count,
      items: (data.items || []).map((r: any) => ({
        name: r.name,
        path: r.path,
        html_url: r.html_url,
        repository: r.repository?.full_name || '',
        score: r.score,
      })),
    };
  }

  async searchIssues(query: string, opts?: { per_page?: number; sort?: string; credential_id?: string | null }): Promise<GitHubSearchResult> {
    const perPage = opts?.per_page ?? 10;
    const sort = opts?.sort ?? 'best-match';
    const qs = new URLSearchParams({ q: query, per_page: String(perPage), sort });
    const data = await this.githubFetch(`/search/issues?${qs.toString()}`, opts?.credential_id);
    return {
      total_count: data.total_count,
      items: (data.items || []).map((r: any) => ({
        title: r.title,
        html_url: r.html_url,
        state: r.state,
        labels: (r.labels || []).map((l: any) => l.name),
        user: r.user?.login || '',
        created_at: r.created_at,
        updated_at: r.updated_at,
        body: r.body ? r.body.slice(0, 500) : '',
      })),
    };
  }
}
