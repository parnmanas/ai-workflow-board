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
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
  const { stdout } = await runGit(
    ['ls-tree', '--long', '--', treeish],
    { cwd: repoPath, maxBytes: 4 * 1024 * 1024 },
  );
  const entries = parseLsTree(stdout, norm);
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
    // Format (--long): "<mode> <type> <sha> <size>\t<name>"
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const meta = line.slice(0, tabIdx).trim().split(/\s+/);
    const name = line.slice(tabIdx + 1);
    if (meta.length < 3) continue;
    const [, type, sha, sizeRaw] = meta;
    const t: TreeEntry['type'] = type === 'tree' ? 'tree' : type === 'commit' ? 'commit' : 'blob';
    out.push({
      name,
      path: basePath ? `${basePath}/${name}` : name,
      type: t,
      sha,
      size: t === 'blob' && sizeRaw && sizeRaw !== '-' ? parseInt(sizeRaw, 10) : null,
    });
  }
  return out;
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
