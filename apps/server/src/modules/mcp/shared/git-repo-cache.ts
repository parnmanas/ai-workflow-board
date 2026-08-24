/**
 * Server-side git *reading* over a per-Resource cache clone.
 *
 * The branch picker (`git-branches.ts`) only needs `git ls-remote`, which works
 * without a working copy. Commit history / diff / file tree do need real git
 * objects, but the server has no local clone of a Resource's repo. This module
 * fills that gap: it maintains a **bare, blobless** (`--filter=blob:none`) cache
 * clone per Resource under a cache dir, then runs `git log` / `git show` /
 * `git ls-tree` / `git cat-file` against it.
 *
 * Design notes / guards (mirrors the traps called out on ticket 226507a3):
 *  - **Host-agnostic** — reuses `git-branches.ts`' HTTPS credential injection,
 *    so GitHub / GitLab / self-hosted all work through the same path. SSH-only
 *    URLs are *not* supported (the server has no key) and degrade with a clear
 *    `SshUnsupportedError`.
 *  - **Light** — bare + `--filter=blob:none`: every commit/tree is fetched once,
 *    blobs are lazily fetched only when a diff or file preview actually needs
 *    them. No working tree on disk.
 *  - **Bounded** — every git invocation has a timeout (clone is given more
 *    head-room than incremental ops); patch/file output is byte-capped.
 *  - **Concurrency** — a per-repo in-process lock serialises clone/fetch so two
 *    requests can't race on the same cache dir. Reads (log/show/ls-tree) run
 *    lock-free once the clone exists.
 *  - **Disk** — a throttled TTL + total-size eviction sweep prunes stale repos.
 *  - **Credential safety** — the injected token lives in the cache clone's
 *    remote URL (server-local, same as any clone), but every error string that
 *    can reach a log or the client is run through `maskGitUrl()` first.
 */

import { spawn } from 'child_process';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

export type GitCredential = { username?: string; token?: string } | null | undefined;

/** A Resource URL that isn't HTTP(S) — the server can't inject a token and has
 *  no SSH key, so commit reading is unavailable. Callers map this to a friendly
 *  "원격 인증 미지원" degrade message. */
export class SshUnsupportedError extends Error {
  readonly code = 'ssh_unsupported';
  constructor(message = 'SSH 전용 URL 은 서버측 git 읽기를 지원하지 않습니다 (HTTPS + credential 필요).') {
    super(message);
    this.name = 'SshUnsupportedError';
  }
}

/** A git operation failed or timed out. `message` is already credential-masked. */
export class GitReadError extends Error {
  readonly code = 'git_read_failed';
  constructor(message: string) {
    super(message);
    this.name = 'GitReadError';
  }
}

// ── tunables (env-overridable) ─────────────────────────────────────────────
const CACHE_DIR = process.env.AWB_GIT_CACHE_DIR || path.join(os.tmpdir(), 'awb-git-cache');
const CLONE_TIMEOUT_MS = numEnv('AWB_GIT_CLONE_TIMEOUT_MS', 60_000); // first clone can be big
const FETCH_TIMEOUT_MS = numEnv('AWB_GIT_FETCH_TIMEOUT_MS', 30_000);
const READ_TIMEOUT_MS = numEnv('AWB_GIT_READ_TIMEOUT_MS', 15_000); // log/show/ls-tree — 15s like ls-remote
// Re-fetch the cache clone at most this often; a manual refresh (forceFetch)
// bypasses it. Keeps "scroll older / click commit" from re-fetching every call.
const FETCH_TTL_MS = numEnv('AWB_GIT_FETCH_TTL_MS', 60_000);
// Evict a cache clone whose last access is older than this.
const CACHE_TTL_MS = numEnv('AWB_GIT_CACHE_TTL_MS', 24 * 60 * 60_000);
// …and keep total cache size under this (best-effort LRU eviction).
const CACHE_MAX_BYTES = numEnv('AWB_GIT_CACHE_MAX_BYTES', 2 * 1024 * 1024 * 1024);
const EVICT_THROTTLE_MS = 5 * 60_000; // don't scan the cache dir more than this often

function numEnv(key: string, def: number): number {
  const v = parseInt(process.env[key] || '', 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

// ── credential masking ──────────────────────────────────────────────────────
/** Strip `user:pass@` userinfo out of any git/https URL inside a string so a
 *  token never reaches a log line or an HTTP error body. */
export function maskGitUrl(input: string): string {
  if (!input) return input;
  // Mask the userinfo of any http(s) URL: scheme://USER:PASS@host → scheme://***@host
  return input.replace(/(https?:\/\/)([^/@\s]+)@/gi, '$1***@');
}

/** Inject username/token into an https URL (ssh/git@ untouched). Same contract
 *  as git-branches' private `applyCredential`, duplicated here to keep the two
 *  helpers independent. */
function applyCredential(url: string, credential: GitCredential): string {
  if (!credential) return url;
  const token = credential.token || '';
  if (!token) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  const username = credential.username || 'x-access-token';
  try {
    const u = new URL(url);
    u.username = username;
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test((url || '').trim());
}

// ── low-level git runner ────────────────────────────────────────────────────
interface RunGitOpts {
  cwd?: string;
  timeoutMs?: number;
  /** Hard cap on captured stdout bytes; output beyond this is dropped and
   *  `truncated` is set. Default unlimited (well, Node string growth). */
  maxBytes?: number;
  /** Text to write to the child's stdin before closing it (e.g. an OID list
   *  for `fetch --stdin` / `cat-file --batch`). Omit for commands that don't
   *  read stdin. */
  stdin?: string;
  /** Set GIT_NO_LAZY_FETCH=1 so a missing object in a blobless clone is a
   *  hard failure instead of a silent per-object promisor round trip (ticket
   *  719ef137). Only safe for call sites that never legitimately need a
   *  blob's content/size — set it and a real lazy fetch becomes a loud
   *  regression instead of a silent slowdown. */
  noLazyFetch?: boolean;
}

interface RunGitResult {
  stdout: string;
  truncated: boolean;
}

function runGit(args: string[], opts: RunGitOpts = {}): Promise<RunGitResult> {
  const timeoutMs = opts.timeoutMs ?? READ_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? Infinity;
  return new Promise<RunGitResult>((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 — never block on an interactive credential prompt.
    // All ref/path/sha args are passed after a `--` by callers, and validated,
    // so a hostile Resource URL/ref can't smuggle a `--upload-pack`-style flag.
    const child = spawn('git', args, {
      cwd: opts.cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        ...(opts.noLazyFetch ? { GIT_NO_LAZY_FETCH: '1' } : {}),
      },
    });
    let out = '';
    let outBytes = 0;
    let truncated = false;
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new GitReadError(`git ${args[0]} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (truncated) return;
      outBytes += d.length;
      if (outBytes > maxBytes) {
        truncated = true;
        const keep = d.length - (outBytes - maxBytes);
        if (keep > 0) out += d.toString('utf8', 0, keep);
        return;
      }
      out += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 8192) err += d.toString('utf8'); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new GitReadError(maskGitUrl(String((e as Error)?.message || e))));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve({ stdout: out, truncated });
      else reject(new GitReadError(maskGitUrl(err.trim() || `git ${args[0]} exited with code ${code}`)));
    });
    if (opts.stdin !== undefined) child.stdin.end(opts.stdin, 'utf8');
  });
}

// ── per-repo lock + cache lifecycle ─────────────────────────────────────────
const repoLocks = new Map<string, Promise<unknown>>();

/** Serialise an operation per cache key so concurrent clone/fetch on the same
 *  Resource don't collide. Different repos still run in parallel. */
function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve();
  // Chain after the previous holder regardless of how it settled. `gate` is the
  // queue marker stored in the map; `result` is what the caller awaits.
  const gate = prev.then(() => {}, () => {}).then(fn);
  const marker = gate.then(() => {}, () => {});
  repoLocks.set(key, marker);
  // Drop the map entry once this op is the tail of the chain (nothing queued
  // behind it), so the map doesn't grow unbounded across many resources.
  marker.then(() => { if (repoLocks.get(key) === marker) repoLocks.delete(key); });
  return gate;
}

function repoPathFor(resourceId: string): string {
  // resourceId is a server-generated uuid; still sanitise to be safe against a
  // path-traversal surprise if the caller ever passes something else.
  const safe = String(resourceId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(CACHE_DIR, `${safe}.git`);
}

async function pathExists(p: string): Promise<boolean> {
  try { await fsp.access(p); return true; } catch { return false; }
}

async function touchAccess(repoPath: string): Promise<void> {
  try { await fsp.writeFile(path.join(repoPath, '.awb-last-access'), String(nowMs())); } catch { /* best-effort */ }
}

// `Date.now` is fine in server runtime (the no-Date.now rule is for Workflow
// scripts only). Wrapped so the lint intent is explicit.
function nowMs(): number { return Date.now(); }

export interface EnsureRepoOptions {
  resourceId: string;
  url: string;
  credential: GitCredential;
  /** Force a `git fetch` even if the cache was refreshed within FETCH_TTL_MS. */
  forceFetch?: boolean;
}

/**
 * Ensure a bare blobless cache clone exists and is reasonably fresh, returning
 * its path. Throws `SshUnsupportedError` for non-HTTPS URLs and `GitReadError`
 * for clone/fetch failures (message already masked).
 */
export async function ensureRepoCache(opts: EnsureRepoOptions): Promise<string> {
  const { resourceId, url, credential, forceFetch } = opts;
  if (!url || !url.trim()) throw new GitReadError('Repository URL is required');
  if (!isHttpUrl(url)) throw new SshUnsupportedError();

  const repoPath = repoPathFor(resourceId);
  const credUrl = applyCredential(url.trim(), credential);

  return withRepoLock(repoPath, async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    void evictStale(); // throttled, fire-and-forget

    const exists = await pathExists(path.join(repoPath, 'HEAD'));
    if (!exists) {
      // Clean any partial leftover, then clone fresh.
      await fsp.rm(repoPath, { recursive: true, force: true });
      await runGit(
        ['clone', '--bare', '--filter=blob:none', '--', credUrl, repoPath],
        { timeoutMs: CLONE_TIMEOUT_MS },
      );
      // Drop the symbolic ref so the picker reflects the remote's HEAD; keep
      // origin so lazy blob fetches (diffs/file preview) and later fetches work.
      await touchAccess(repoPath);
      return repoPath;
    }

    // Refresh the embedded credential (it may have rotated) and fetch when stale
    // or when the caller forces it.
    const stale = forceFetch || (await fetchIsStale(repoPath));
    if (stale) {
      try {
        await runGit(['remote', 'set-url', 'origin', '--', credUrl], { cwd: repoPath, timeoutMs: READ_TIMEOUT_MS });
        await runGit(
          ['fetch', '--prune', '--no-tags', 'origin', '+refs/heads/*:refs/heads/*', '+refs/tags/*:refs/tags/*'],
          { cwd: repoPath, timeoutMs: FETCH_TIMEOUT_MS },
        );
        await fsp.writeFile(path.join(repoPath, '.awb-last-fetch'), String(nowMs())).catch(() => {});
      } catch (e) {
        // A fetch failure on an existing cache is non-fatal — serve the cached
        // objects we already have rather than 502'ing the whole panel.
        if (e instanceof SshUnsupportedError) throw e;
        // swallow; reads below will still work against cached refs
      }
    }
    await touchAccess(repoPath);
    return repoPath;
  });
}

async function fetchIsStale(repoPath: string): Promise<boolean> {
  try {
    const raw = await fsp.readFile(path.join(repoPath, '.awb-last-fetch'), 'utf8');
    const last = parseInt(raw, 10);
    if (!Number.isFinite(last)) return true;
    return nowMs() - last > FETCH_TTL_MS;
  } catch {
    return true;
  }
}

// ── eviction (throttled, best-effort) ───────────────────────────────────────
let lastEvictAt = 0;

async function evictStale(): Promise<void> {
  const now = nowMs();
  if (now - lastEvictAt < EVICT_THROTTLE_MS) return;
  lastEvictAt = now;
  try {
    const entries = await fsp.readdir(CACHE_DIR, { withFileTypes: true });
    const repos: { p: string; access: number; size: number }[] = [];
    for (const ent of entries) {
      if (!ent.isDirectory() || !ent.name.endsWith('.git')) continue;
      const p = path.join(CACHE_DIR, ent.name);
      const access = await readAccess(p);
      const size = await dirSize(p);
      // TTL eviction first.
      if (now - access > CACHE_TTL_MS) {
        await fsp.rm(p, { recursive: true, force: true }).catch(() => {});
        continue;
      }
      repos.push({ p, access, size });
    }
    // Size-cap eviction: drop least-recently-accessed until under the cap.
    let total = repos.reduce((s, r) => s + r.size, 0);
    if (total > CACHE_MAX_BYTES) {
      repos.sort((a, b) => a.access - b.access); // oldest first
      for (const r of repos) {
        if (total <= CACHE_MAX_BYTES) break;
        await fsp.rm(r.p, { recursive: true, force: true }).catch(() => {});
        total -= r.size;
      }
    }
  } catch { /* best-effort */ }
}

async function readAccess(repoPath: string): Promise<number> {
  try {
    const raw = await fsp.readFile(path.join(repoPath, '.awb-last-access'), 'utf8');
    const v = parseInt(raw, 10);
    if (Number.isFinite(v)) return v;
  } catch { /* fall through */ }
  try {
    const st = await fsp.stat(repoPath);
    return st.mtimeMs;
  } catch {
    return 0;
  }
}

async function dirSize(p: string): Promise<number> {
  let total = 0;
  try {
    const entries = await fsp.readdir(p, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(p, ent.name);
      if (ent.isDirectory()) total += await dirSize(full);
      else {
        try { total += (await fsp.stat(full)).size; } catch { /* skip */ }
      }
    }
  } catch { /* skip */ }
  return total;
}

// ── ref / path / sha validation ─────────────────────────────────────────────
/** Branch/tag names and treeish refs. Rejects anything that could be parsed as
 *  a git flag or smuggle shell-ish characters. Empty → caller falls back to
 *  HEAD. */
export function isValidRef(ref: string): boolean {
  if (!ref) return true; // empty = default (HEAD)
  if (ref.length > 256) return false;
  if (ref.startsWith('-')) return false;
  // Allow a commit-ish suffix like `~1`/`^` plus normal ref chars.
  return /^[A-Za-z0-9._\/~^@-]+$/.test(ref) && !ref.includes('..');
}

export function isValidSha(sha: string): boolean {
  return /^[0-9a-fA-F]{4,64}$/.test(sha || '');
}

/** Sanitise a tree path: no leading slash, no `..` traversal, bounded length. */
export function normalizeRepoPath(p: string): string {
  let s = (p || '').trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!s) return '';
  if (s.length > 1024) s = s.slice(0, 1024);
  const segs = s.split('/').filter((seg) => seg && seg !== '.');
  if (segs.some((seg) => seg === '..')) throw new GitReadError('잘못된 경로입니다.');
  return segs.join('/');
}

function refOrHead(ref: string): string {
  return ref && ref.trim() ? ref.trim() : 'HEAD';
}

// ── public read API ─────────────────────────────────────────────────────────
export interface CommitSummary {
  sha: string;
  short_sha: string;
  subject: string;
  author_name: string;
  author_email: string;
  authored_at: string; // ISO
  committed_at: string; // ISO
}

const LOG_SEP = '\x1f'; // unit separator between fields
const LOG_REC = '\x1e'; // record separator between commits
const LOG_FORMAT = ['%H', '%an', '%ae', '%aI', '%cI', '%s'].join(LOG_SEP) + LOG_REC;

export interface ListCommitsOptions {
  repoPath: string;
  ref?: string;
  limit?: number;
  /** Cursor: a commit sha. Returns commits strictly older than it along the
   *  same history. */
  before?: string;
}

export async function listCommits(opts: ListCommitsOptions): Promise<CommitSummary[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 30)), 100);
  let start = refOrHead(opts.ref || '');
  const args = ['log', `--max-count=${limit}`, `--pretty=format:${LOG_FORMAT}`];
  if (opts.before) {
    if (!isValidSha(opts.before)) throw new GitReadError('잘못된 커서입니다.');
    // Start at the cursor commit and skip it so we return only older commits.
    start = opts.before;
    args.push('--skip=1');
  } else if (!isValidRef(start)) {
    throw new GitReadError('잘못된 ref 입니다.');
  }
  args.push(start, '--');
  const { stdout } = await runGit(args, { cwd: opts.repoPath, maxBytes: 2 * 1024 * 1024 });
  return parseCommitLog(stdout);
}

function parseCommitLog(stdout: string): CommitSummary[] {
  const out: CommitSummary[] = [];
  for (const rec of stdout.split(LOG_REC)) {
    const line = rec.replace(/^\n/, '');
    if (!line.trim()) continue;
    const [sha, an, ae, aI, cI, subject] = line.split(LOG_SEP);
    if (!sha) continue;
    out.push({
      sha,
      short_sha: sha.slice(0, 8),
      subject: subject ?? '',
      author_name: an ?? '',
      author_email: ae ?? '',
      authored_at: aI ?? '',
      committed_at: cI ?? '',
    });
  }
  return out;
}

export interface CommitFileChange {
  path: string;
  old_path?: string;
  additions: number | null; // null = binary
  deletions: number | null;
  binary: boolean;
}

export interface CommitDetail {
  sha: string;
  short_sha: string;
  subject: string;
  body: string;
  author_name: string;
  author_email: string;
  authored_at: string;
  committed_at: string;
  parents: string[];
  files: CommitFileChange[];
  diff: string;
  diff_truncated: boolean;
}

const SHOW_META_SEP = '\x1f';
const SHOW_META_FORMAT = ['%H', '%an', '%ae', '%aI', '%cI', '%P', '%s', '%b'].join(SHOW_META_SEP);
const MAX_DIFF_BYTES = numEnv('AWB_GIT_MAX_DIFF_BYTES', 1024 * 1024); // 1MB patch cap

export async function getCommitDetail(repoPath: string, sha: string): Promise<CommitDetail> {
  if (!isValidSha(sha)) throw new GitReadError('잘못된 커밋 해시입니다.');

  // 1) metadata
  const meta = await runGit(
    ['show', '-s', `--format=${SHOW_META_FORMAT}`, sha, '--'],
    { cwd: repoPath, maxBytes: 256 * 1024 },
  );
  const [fullSha, an, ae, aI, cI, parents, subject, body] = meta.stdout.split(SHOW_META_SEP);
  if (!fullSha) throw new GitReadError('커밋을 찾을 수 없습니다.');

  // 2) per-file numstat (lazy-fetches blobs the diff touches).
  //    `--first-parent` makes a merge commit show its diff against the mainline
  //    parent; for a normal commit it's a no-op. Without it `git show` prints an
  //    empty patch for merges (its default combined diff is suppressed when
  //    nothing conflicts), so the panel would list files with no diff.
  const numstat = await runGit(
    ['show', '--no-color', '--first-parent', '--format=', '--numstat', sha, '--'],
    { cwd: repoPath, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 1024 * 1024 },
  );
  const files = parseNumstat(numstat.stdout);

  // 3) bounded patch text (same --first-parent rationale as numstat).
  const patch = await runGit(
    ['show', '--no-color', '--first-parent', '--format=', '-p', sha, '--'],
    { cwd: repoPath, timeoutMs: FETCH_TIMEOUT_MS, maxBytes: MAX_DIFF_BYTES },
  );

  return {
    sha: fullSha.trim(),
    short_sha: fullSha.trim().slice(0, 8),
    subject: subject ?? '',
    body: body ?? '',
    author_name: an ?? '',
    author_email: ae ?? '',
    authored_at: aI ?? '',
    committed_at: cI ?? '',
    parents: (parents || '').trim() ? parents.trim().split(/\s+/) : [],
    files,
    diff: patch.stdout,
    diff_truncated: patch.truncated,
  };
}

function parseNumstat(stdout: string): CommitFileChange[] {
  const out: CommitFileChange[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [addRaw, delRaw, ...rest] = parts;
    const binary = addRaw === '-' && delRaw === '-';
    // Rename form: "old => new" inside the path field, or a 3-col rename where
    // numstat emits `\t{old => new}`. Keep it simple: the path is the last col.
    let pathField = rest.join('\t');
    let oldPath: string | undefined;
    const renameMatch = pathField.match(/^(.*)\{(.*) => (.*)\}(.*)$/);
    if (renameMatch) {
      const [, pre, from, to, post] = renameMatch;
      oldPath = `${pre}${from}${post}`.replace(/\/\//g, '/');
      pathField = `${pre}${to}${post}`.replace(/\/\//g, '/');
    } else if (pathField.includes(' => ')) {
      const [from, to] = pathField.split(' => ');
      oldPath = from;
      pathField = to;
    }
    out.push({
      path: pathField,
      old_path: oldPath,
      additions: binary ? null : parseInt(addRaw, 10) || 0,
      deletions: binary ? null : parseInt(delRaw, 10) || 0,
      binary,
    });
  }
  return out;
}

export interface TreeEntry {
  name: string;
  path: string;
  type: 'tree' | 'blob' | 'commit';
  sha: string;
  size: number | null; // null for trees/submodules
}

/** List the immediate children of `path` at `ref`. Returns directories first,
 *  then files, each alphabetical. */
export async function listTree(repoPath: string, ref: string, treePath: string): Promise<TreeEntry[]> {
  const r = refOrHead(ref);
  if (!isValidRef(r)) throw new GitReadError('잘못된 ref 입니다.');
  const norm = normalizeRepoPath(treePath);
  // `<ref>:<path>` resolves to the tree object at that path; ls-tree then lists
  // its immediate children with names relative to it.
  const treeish = norm ? `${r}:${norm}` : r;
  // `--long` 없는 plain `ls-tree` 는 tree 객체만 읽는다 — blobless
  // (`--filter=blob:none`) 캐시 클론도 tree 는 항상 로컬에 전부 갖고
  // 있으므로 이 spawn 은 절대 lazy-fetch 하지 않는다. `--long` 은 추가로
  // blob 마다 object size 를 요구하는데, 이게 바로 이 티켓이 고치는
  // blob당 promisor fetch 폭주의 원인이었다(ticket 719ef137/4796899d).
  // 크기는 별도로, 로컬에 있는 것만 best-effort 로 채운다 —
  // fillBlobSizesLocalOnly 참고.
  const { stdout } = await runGit(
    ['ls-tree', '--', treeish],
    { cwd: repoPath, maxBytes: 4 * 1024 * 1024 },
  );
  const entries = parseLsTree(stdout, norm);
  await fillBlobSizesLocalOnly(repoPath, entries);
  entries.sort((a, b) => {
    const ad = a.type === 'tree' ? 0 : 1;
    const bd = b.type === 'tree' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return a.name.localeCompare(b.name);
  });
  return entries;
}

function parseLsTree(stdout: string, basePath: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    // 포맷(`--long` 없음): "<mode> <type> <sha>\t<name>" — size 컬럼 없음;
    // blob 크기는 fillBlobSizesLocalOnly 가 별도로 채운다.
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = line.slice(0, tabIdx).trim().split(/\s+/);
    const name = line.slice(tabIdx + 1);
    if (meta.length < 3) continue;
    const [, type, sha] = meta;
    const t: TreeEntry['type'] = type === 'tree' ? 'tree' : type === 'commit' ? 'commit' : 'blob';
    out.push({ name, path: basePath ? `${basePath}/${name}` : name, type: t, sha, size: null });
  }
  return out;
}

export interface TreeFileEntry {
  path: string;
  sha: string;
}

/**
 * Recursively list every blob under `treePath` at `ref` in **one** git
 * process (ticket 719ef137 fix A). Unlike `listTree`, this never asks for
 * blob sizes (no `--long`), so a blobless cache clone never needs to touch a
 * blob's content — `ls-tree -r` only reads tree objects, which a
 * `--filter=blob:none` clone always has in full. `noLazyFetch` turns any
 * future regression back toward requiring blob data into a hard, immediate
 * failure instead of a silent per-blob promisor round trip.
 *
 * Contrast with the previous per-directory BFS (`walkTree` in
 * ontology-extraction.service.ts calling `listTree` once per directory): that
 * was O(directories) git spawns *and*, via `--long`, O(blobs) lazy fetches.
 * This is exactly one spawn and zero blob fetches, regardless of tree shape.
 */
export async function listTreeRecursive(repoPath: string, ref: string, treePath: string): Promise<TreeFileEntry[]> {
  const r = refOrHead(ref);
  if (!isValidRef(r)) throw new GitReadError('잘못된 ref 입니다.');
  const norm = normalizeRepoPath(treePath);
  const treeish = norm ? `${r}:${norm}` : r;
  const { stdout } = await runGit(
    ['ls-tree', '-r', '-z', '--', treeish],
    { cwd: repoPath, maxBytes: 32 * 1024 * 1024, noLazyFetch: true },
  );
  const out: TreeFileEntry[] = [];
  for (const rec of stdout.split('\0')) {
    if (!rec) continue;
    const tabIdx = rec.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = rec.slice(0, tabIdx).trim().split(/\s+/);
    const name = rec.slice(tabIdx + 1);
    if (meta.length < 3) continue;
    const [, type, sha] = meta;
    if (type !== 'blob') continue; // `-r` already recurses trees; submodules(commit) skipped, same as listTree/walkTree today
    out.push({ path: norm ? `${norm}/${name}` : name, sha });
  }
  return out;
}

/**
 * `listTree` 의 blob entry 에 대한 best-effort 크기 백필 — 캐시 클론에
 * 이미 로컬로 있는 객체에 대해서만 `size` 를 채우고, 절대 promisor fetch
 * 를 유발하지 않는다. 아직 로컬에 없는 blob 은 `size: null` 로 남기고,
 * 호출부는 디렉터리 목록 하나 보여주자고 네트워크 왕복을 태우는 대신
 * "크기 미상"으로 degrade 한다(ticket 4796899d — 719ef137 의
 * `git ls-tree --long` 버그와 근본 원인은 같지만 호출부가 다르다).
 *
 * 이 디렉터리의 blob SHA 목록을 그냥 `git cat-file --batch-check` 에
 * `noLazyFetch` 로 감싸 먹이는 방식은 안 통한다: 실측으로 확인한 바,
 * promisor 클론에서 입력 중 단 하나라도 로컬에 없으면 그 한 줄만
 * "missing" 으로 보고하고 계속하는 게 아니라 batch-check 프로세스
 * 전체가 `fatal: could not fetch <oid> from promisor remote` 로 즉시
 * 죽는다(exit 128) — 이미 캐시된 blob 과 아직 안 가져온 blob 이 섞인
 * 디렉터리에는 쓸 수 없다. 또한 `noLazyFetch` 없이 여러 개를 한 번에
 * 먹여도 git 이 missing 객체 하나당 별도의 promisor 왕복을 여는 것도
 * 확인했다(`ls-tree --long` 과 동일한 O(blob) 병리) — 이 방법도 제외.
 *
 * 대신 클론이 이미 갖고 있는 전체 객체를 열거해서(`--batch-all-objects`,
 * promisor 원격과 무관하게 네트워크를 절대 건드리지 않는 로컬
 * pack/loose 객체 DB 스캔) 그 맵에서 크기를 조회한다 — 디스크에 이미
 * 있는 것만 답할 수 있는 호출이라 애초에 missing-object 실패 모드
 * 자체가 없다.
 */
async function fillBlobSizesLocalOnly(repoPath: string, entries: TreeEntry[]): Promise<void> {
  const blobs = entries.filter((e) => e.type === 'blob');
  if (blobs.length === 0) return;
  let stdout: string;
  try {
    ({ stdout } = await runGit(['cat-file', '--batch-check', '--batch-all-objects'], {
      cwd: repoPath,
      maxBytes: 32 * 1024 * 1024,
      noLazyFetch: true,
    }));
  } catch {
    return; // best-effort — size는 null로 남고 목록 자체는 그대로 성공한다
  }
  const sizeBySha = new Map<string, number>();
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3) continue; // 손상/절단된 줄 — 건너뜀
    const size = parseInt(parts[2], 10);
    if (Number.isFinite(size)) sizeBySha.set(parts[0], size);
  }
  for (const e of blobs) {
    const size = sizeBySha.get(e.sha);
    if (size !== undefined) e.size = size;
  }
}

export interface FileContent {
  path: string;
  size: number;
  binary: boolean;
  too_large: boolean;
  truncated: boolean;
  content: string; // empty when binary/too_large
}

const MAX_FILE_BYTES = numEnv('AWB_GIT_MAX_FILE_BYTES', 512 * 1024); // 512KB preview cap
const BULK_FETCH_TIMEOUT_MS = numEnv('AWB_GIT_BULK_FETCH_TIMEOUT_MS', 60_000); // whole-batch backfill/read, scales with file count

export async function getFileContent(repoPath: string, ref: string, filePath: string): Promise<FileContent> {
  const r = refOrHead(ref);
  if (!isValidRef(r)) throw new GitReadError('잘못된 ref 입니다.');
  const norm = normalizeRepoPath(filePath);
  if (!norm) throw new GitReadError('파일 경로가 필요합니다.');
  const spec = `${r}:${norm}`;

  // Object must be a blob.
  let objType = '';
  try {
    const t = await runGit(['cat-file', '-t', '--', spec], { cwd: repoPath });
    objType = t.stdout.trim();
  } catch {
    throw new GitReadError('파일을 찾을 수 없습니다.');
  }
  if (objType !== 'blob') throw new GitReadError('디렉토리는 미리볼 수 없습니다.');

  // Size first (triggers a lazy fetch of the blob in a blobless clone).
  const sizeRes = await runGit(['cat-file', '-s', '--', spec], { cwd: repoPath, timeoutMs: FETCH_TIMEOUT_MS });
  const size = parseInt(sizeRes.stdout.trim(), 10) || 0;
  if (size > MAX_FILE_BYTES) {
    return { path: norm, size, binary: false, too_large: true, truncated: false, content: '' };
  }

  const blob = await runGit(['cat-file', 'blob', '--', spec], {
    cwd: repoPath,
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: MAX_FILE_BYTES,
  });
  // Binary heuristic: a NUL byte in the captured text means non-text.
  const binary = blob.stdout.includes('\x00');
  return {
    path: norm,
    size,
    binary,
    too_large: false,
    truncated: blob.truncated,
    content: binary ? '' : blob.stdout,
  };
}

interface BatchBlobResult {
  type: string; // 'blob' | 'missing' (trees/commits are never requested here)
  size: number;
  content: Buffer;
}

/**
 * Run `git cat-file --batch`, feeding `oids` (one per line) on stdin and
 * parsing the binary-safe `<oid> <type> <size>\n<content>\n` framing (or
 * `<oid> missing\n`) from stdout. Kept separate from `runGit()` because
 * blob content can be arbitrary bytes — decoding each stdout chunk to utf8
 * as it arrives (like `runGit` does) can split a multi-byte character across
 * a chunk boundary and corrupt it, so this accumulates raw `Buffer`s and only
 * decodes the exact byte range of each blob once its length is known from
 * the header.
 */
function runGitCatFileBatch(oids: string[], opts: { cwd: string; timeoutMs?: number; maxBytes?: number }): Promise<Map<string, BatchBlobResult>> {
  const timeoutMs = opts.timeoutMs ?? BULK_FETCH_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? 128 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['cat-file', '--batch'], {
      cwd: opts.cwd,
      // GIT_NO_LAZY_FETCH=1 — every oid here was just bulk-backfilled by the
      // caller; if one is still missing, fail loudly instead of falling back
      // to the serial per-object promisor fetch this whole batch exists to
      // avoid (ticket 719ef137 fix B).
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' },
    });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let overflow = false;
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      child.kill('SIGKILL');
      reject(new GitReadError(`git cat-file --batch timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    const fail = (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(e);
    };
    child.stdout.on('data', (d: Buffer) => {
      if (overflow) return;
      totalBytes += d.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        fail(new GitReadError(`git cat-file --batch output exceeded ${maxBytes} bytes`));
        return;
      }
      chunks.push(d);
    });
    child.stderr.on('data', (d: Buffer) => { if (err.length < 8192) err += d.toString('utf8'); });
    child.on('error', (e) => fail(new GitReadError(maskGitUrl(String((e as Error)?.message || e)))));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new GitReadError(maskGitUrl(err.trim() || `git cat-file --batch exited with code ${code}`)));
        return;
      }
      try {
        resolve(parseCatFileBatch(Buffer.concat(chunks, totalBytes)));
      } catch (e) {
        reject(e instanceof Error ? e : new GitReadError(String(e)));
      }
    });
    child.stdin.end(oids.map((o) => `${o}\n`).join(''), 'utf8');
  });
}

function parseCatFileBatch(buf: Buffer): Map<string, BatchBlobResult> {
  const out = new Map<string, BatchBlobResult>();
  let offset = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf(0x0a, offset);
    if (nl < 0) break;
    const header = buf.toString('utf8', offset, nl).split(' ');
    offset = nl + 1;
    if (header.length >= 3) {
      const [oid, type, sizeRaw] = header;
      const size = parseInt(sizeRaw, 10) || 0;
      const content = Buffer.from(buf.subarray(offset, offset + size));
      offset += size;
      if (buf[offset] === 0x0a) offset += 1; // trailing separator after content
      out.set(oid, { type, size, content });
    } else {
      out.set(header[0], { type: 'missing', size: 0, content: Buffer.alloc(0) });
    }
  }
  return out;
}

/**
 * Fetch the content of many blobs in **two** git processes total, regardless
 * of file count (ticket 719ef137 fix B — the bottleneck that follows fix A
 * once the tree walk itself stops lazy-fetching: one `cat-file -s` +
 * `cat-file blob` round trip per file, done by `getFileContent`, still means
 * 2×N promisor round trips for N files).
 *
 *  1. One `git fetch --filter=blob:none --stdin` backfills every blob this
 *     batch needs, deduped by OID, in a single promisor negotiation.
 *  2. One `git cat-file --batch` reads them all back locally.
 *
 * Every full file's bytes are transferred (there's no per-file `--long`-style
 * short-circuit before the content round trip like `getFileContent` has for
 * `too_large`) — an acceptable trade-off for source-tree extraction, where
 * `langForPath` has already excluded non-source files before this is called.
 */
export async function getFileContentsBatch(repoPath: string, entries: TreeFileEntry[]): Promise<Map<string, FileContent>> {
  const out = new Map<string, FileContent>();
  if (entries.length === 0) return out;

  const uniqueShas = [...new Set(entries.map((e) => e.sha))];
  await runGit(
    ['-c', 'fetch.negotiationAlgorithm=noop', 'fetch', 'origin', '--no-tags', '--no-write-fetch-head', '--filter=blob:none', '--stdin'],
    { cwd: repoPath, timeoutMs: BULK_FETCH_TIMEOUT_MS, stdin: uniqueShas.map((s) => `${s}\n`).join('') },
  );

  const bySha = await runGitCatFileBatch(uniqueShas, { cwd: repoPath, timeoutMs: BULK_FETCH_TIMEOUT_MS });

  for (const entry of entries) {
    const blob = bySha.get(entry.sha);
    if (!blob || blob.type === 'missing') {
      out.set(entry.path, { path: entry.path, size: 0, binary: false, too_large: false, truncated: false, content: '' });
      continue;
    }
    if (blob.size > MAX_FILE_BYTES) {
      out.set(entry.path, { path: entry.path, size: blob.size, binary: false, too_large: true, truncated: false, content: '' });
      continue;
    }
    const binary = blob.content.includes(0);
    out.set(entry.path, {
      path: entry.path,
      size: blob.size,
      binary,
      too_large: false,
      truncated: false,
      content: binary ? '' : blob.content.toString('utf8'),
    });
  }
  return out;
}

/** Branches + tags for the ref picker, resolved from the cache clone (no extra
 *  network round-trip beyond the fetch ensureRepoCache already did). */
export interface RepoRefs {
  branches: string[];
  tags: string[];
  head: string; // symbolic default branch name, '' if detached/unknown
}

export async function listRefs(repoPath: string): Promise<RepoRefs> {
  const { stdout } = await runGit(
    ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags'],
    { cwd: repoPath, maxBytes: 1024 * 1024 },
  );
  const branches: string[] = [];
  const tags: string[] = [];
  for (const line of stdout.split('\n')) {
    const ref = line.trim();
    if (ref.startsWith('refs/heads/')) branches.push(ref.slice('refs/heads/'.length));
    else if (ref.startsWith('refs/tags/')) tags.push(ref.slice('refs/tags/'.length));
  }
  let head = '';
  try {
    const h = await runGit(['symbolic-ref', '--short', 'HEAD'], { cwd: repoPath });
    head = h.stdout.trim();
  } catch { /* detached or unborn — leave '' */ }
  branches.sort((a, b) => a.localeCompare(b));
  tags.sort((a, b) => a.localeCompare(b));
  return { branches, tags, head };
}

/** Ahead/behind counts of a head ref relative to a base ref, used by the merge
 *  gate to answer "is the feature branch stale (behind base)?" and "is it fully
 *  merged into base (0 ahead)?" against the cache clone — the host-agnostic
 *  primitive the merge gate needs on top of the existing read API. */
export interface BehindAhead {
  /** Commits reachable from base but NOT from head — head is missing these
   *  (feature branch is BEHIND base → stale-base). */
  behind: number;
  /** Commits reachable from head but NOT from base — base is missing these
   *  (feature branch has unmerged work → not fully merged). */
  ahead: number;
}

/**
 * Compute {behind, ahead} of `headRef` relative to `baseRef` via
 * `git rev-list --left-right --count base...head`. In the symmetric-difference
 * `A...B`, the left count is commits in A(base) not in B(head) = behind, the
 * right count is commits in B(head) not in A(base) = ahead.
 *
 * Both refs are validated (rejecting flag-like / `..`-smuggling input, same as
 * every other read here) and resolved against the cache clone — a ref that
 * doesn't exist throws GitReadError, which the merge gate treats as
 * "unverifiable → degrade to pass" rather than a block.
 */
export async function countBehindAhead(
  repoPath: string,
  baseRef: string,
  headRef: string,
): Promise<BehindAhead> {
  if (!isValidRef(baseRef) || !baseRef.trim()) throw new GitReadError('잘못된 base ref 입니다.');
  if (!isValidRef(headRef) || !headRef.trim()) throw new GitReadError('잘못된 head ref 입니다.');
  const spec = `${baseRef.trim()}...${headRef.trim()}`;
  const { stdout } = await runGit(
    ['rev-list', '--left-right', '--count', spec, '--'],
    { cwd: repoPath, maxBytes: 4 * 1024 },
  );
  // Output is "<behind>\t<ahead>" (a single line; whitespace-separated).
  const parts = stdout.trim().split(/\s+/);
  const behind = parseInt(parts[0] ?? '', 10);
  const ahead = parseInt(parts[1] ?? '', 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    throw new GitReadError(`rev-list --count 출력 파싱 실패: "${stdout.trim()}"`);
  }
  return { behind, ahead };
}

/**
 * Resolve the merge-base (fork point) of two refs via `git merge-base`. Used
 * by the review-drift prober to seed a Review episode's entry snapshot from
 * where the feature branch actually forked, not from whatever the base
 * branch's tip happens to be at the moment the episode starts — the latter
 * would hide any drift that landed on base BEFORE the episode began.
 *
 * Same validation discipline as `countBehindAhead` / `diffChangedPaths`.
 */
export async function mergeBase(
  repoPath: string,
  refA: string,
  refB: string,
): Promise<string> {
  if (!isValidRef(refA) || !refA.trim()) throw new GitReadError('잘못된 ref 입니다.');
  if (!isValidRef(refB) || !refB.trim()) throw new GitReadError('잘못된 ref 입니다.');
  const { stdout } = await runGit(
    ['merge-base', refA.trim(), refB.trim(), '--'],
    { cwd: repoPath, maxBytes: 4 * 1024 },
  );
  const sha = stdout.trim();
  if (!isValidSha(sha)) throw new GitReadError(`merge-base 출력 파싱 실패: "${sha}"`);
  return sha;
}

export interface DiffChangedPathsOptions {
  /** Use a 3-dot (`from...to`, merge-base-relative) diff instead of the
   *  default 2-dot (`from..to`, direct range) diff. 3-dot is what "what did
   *  this branch itself change since it forked" wants; 2-dot is what "what
   *  moved directly between these two points on the same line" wants (e.g.
   *  a base branch's own forward movement between two SHAs). */
  threeDot?: boolean;
  maxBytes?: number;
}

/**
 * List the file paths changed between two refs via `git diff --name-only`.
 * Same validation discipline as `countBehindAhead`: both refs run through
 * `isValidRef` (rejects flag-like / `..`-smuggling input — a raw commit SHA
 * passes this too, so callers may pass either a branch name or a SHA), and
 * the path list is separated from the ref spec with a `--` terminator.
 *
 * Reads only the name list from the cache clone (no patch body), so this is
 * cheap even for a wide range — unlike `getCommitDetail`'s 1MB per-commit
 * diff cap, there's no patch text here to bound beyond the name list itself.
 */
export async function diffChangedPaths(
  repoPath: string,
  fromRef: string,
  toRef: string,
  opts: DiffChangedPathsOptions = {},
): Promise<string[]> {
  if (!isValidRef(fromRef) || !fromRef.trim()) throw new GitReadError('잘못된 시작 ref 입니다.');
  if (!isValidRef(toRef) || !toRef.trim()) throw new GitReadError('잘못된 끝 ref 입니다.');
  const sep = opts.threeDot ? '...' : '..';
  const spec = `${fromRef.trim()}${sep}${toRef.trim()}`;
  const { stdout } = await runGit(
    ['diff', '--name-only', spec, '--'],
    { cwd: repoPath, maxBytes: opts.maxBytes ?? 4 * 1024 * 1024 },
  );
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/** 한 줄의 `git diff --name-status -M` 출력 — `status`는 `A`/`M`/`D`/`R`
 *  (그 외 `T`/`U` 등도 그대로 첫 글자를 담는다, `-M`만 켠 상태라 `C`는
 *  나오지 않음). `status==='R'`일 때만 `oldPath`/`similarity`(0-100, `R100`
 *  등 상태 코드 뒤 숫자)가 채워진다. */
export interface DiffPathChange {
  status: string;
  path: string;
  oldPath: string | null;
  similarity: number | null;
}

/**
 * ticket 964014f5(증분 갱신, DESIGN.md 축 4) — `diffChangedPaths`의 rename-
 * aware 버전. `--name-only` 대신 `--name-status -M`을 써서 rename/move를
 * `R<similarity>\t<old>\t<new>` 줄로 명시적으로 받는다. incremental/
 * git-diff-batch.ts의 `git diff <last_indexed_commit>..HEAD --name-status -M`
 * 스코프 배치 트리거(브랜치 전환/대량 외부 편집)가 이 함수로 rename을
 * 감지해 Phase A의 무조건 재해소 분기(REVIEW-NOTES.md I2)를 결정한다.
 * 검증 규율은 `diffChangedPaths`와 동일 — 두 ref 모두 `isValidRef`를
 * 통과해야 하고, 경로 목록은 `--`로 ref spec과 분리한다.
 */
export async function diffChangedPathsWithStatus(
  repoPath: string,
  fromRef: string,
  toRef: string,
  opts: DiffChangedPathsOptions = {},
): Promise<DiffPathChange[]> {
  if (!isValidRef(fromRef) || !fromRef.trim()) throw new GitReadError('잘못된 시작 ref 입니다.');
  if (!isValidRef(toRef) || !toRef.trim()) throw new GitReadError('잘못된 끝 ref 입니다.');
  const sep = opts.threeDot ? '...' : '..';
  const spec = `${fromRef.trim()}${sep}${toRef.trim()}`;
  const { stdout } = await runGit(
    ['diff', '--name-status', '-M', spec, '--'],
    { cwd: repoPath, maxBytes: opts.maxBytes ?? 4 * 1024 * 1024 },
  );
  const out: DiffPathChange[] = [];
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const cols = line.split('\t');
    const statusToken = cols[0] ?? '';
    if (statusToken.startsWith('R') && cols.length >= 3) {
      const similarity = parseInt(statusToken.slice(1), 10);
      out.push({
        status: 'R',
        oldPath: cols[1],
        path: cols[2],
        similarity: Number.isFinite(similarity) ? similarity : null,
      });
      continue;
    }
    if (cols.length < 2) continue;
    out.push({ status: statusToken.slice(0, 1) || 'M', oldPath: null, path: cols[1], similarity: null });
  }
  return out;
}
