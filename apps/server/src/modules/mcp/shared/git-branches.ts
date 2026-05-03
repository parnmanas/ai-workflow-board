/**
 * Git branch listing helper.
 *
 * Used by the resources controller (`GET /api/resources/:id/branches`) and
 * by the MCP `list_repo_branches` tool to populate the branch picker in the
 * Ticket panel. Implementation is `git ls-remote --heads <url>` so the
 * server doesn't need a working clone — credentials are embedded into the
 * URL when a Credential row supplies them.
 *
 * Returns refs sorted with the repository's `default_branch` (when set)
 * pinned to the top so the UI's first option is the most useful one.
 */

import { spawn } from 'child_process';
import { Repository } from 'typeorm';
import { Credential } from '../../../entities/Credential';
import { decrypt } from '../../../services/encryption.service';

export interface RepoBranch {
  name: string;
  sha: string;
}

/** Decrypt a workspace Credential row into the `{username, token}` shape
 *  `applyCredential` expects. Returns null if the credential row is missing,
 *  out-of-workspace, or fails to decrypt — callers should treat that as
 *  "no auth available" and let `git ls-remote` decide whether the repo is
 *  reachable anonymously. */
export async function resolveGitCredential(
  credRepo: Repository<Credential>,
  credentialId: string | null | undefined,
  workspaceId: string,
): Promise<{ username?: string; token?: string } | null> {
  if (!credentialId) return null;
  const cred = await credRepo.findOne({ where: { id: credentialId, workspace_id: workspaceId } });
  if (!cred) return null;
  try {
    const data = JSON.parse(decrypt(cred.encrypted_data));
    const token = data.token || data.api_key || '';
    if (!token) return null;
    return { username: data.username || undefined, token };
  } catch {
    return null;
  }
}

export interface ListRepoBranchesOptions {
  url: string;
  credential?: { username?: string; token?: string } | null;
  defaultBranch?: string;
  /** Hard cap on git ls-remote runtime. Default 15s — enough for normal
   *  GitHub/GitLab responses, fast enough that an unreachable host doesn't
   *  block the request thread for minutes. */
  timeoutMs?: number;
}

/** Inject username/token into an https URL when credentials are supplied.
 *  Leaves ssh:// and git@ URLs untouched (those need a key, not a token). */
function applyCredential(url: string, credential?: { username?: string; token?: string } | null): string {
  if (!credential) return url;
  const token = credential.token || '';
  if (!token) return url;
  if (!/^https?:\/\//i.test(url)) return url;
  // Default to GitHub's `x-access-token` username when callers supply only a
  // token. (Earlier form mixed `||` and `?:` with surprising precedence; the
  // `if (!token) return url` guard above made it work, but it was brittle.)
  const username = credential.username || 'x-access-token';
  try {
    const u = new URL(url);
    // The URL setters run the userinfo percent-encoder themselves — passing
    // an already-encoded value would double-encode `%`/`@`/etc.
    u.username = username;
    u.password = token;
    return u.toString();
  } catch {
    return url;
  }
}

export async function listRepoBranches(opts: ListRepoBranchesOptions): Promise<RepoBranch[]> {
  if (!opts.url) throw new Error('Repository URL is required');
  const url = applyCredential(opts.url, opts.credential);
  const timeoutMs = opts.timeoutMs ?? 15000;

  const stdout = await new Promise<string>((resolve, reject) => {
    // GIT_TERMINAL_PROMPT=0 stops git from blocking on a credential prompt
    // when the URL needs auth we didn't provide — fail fast instead of hanging
    // the request. The `--` end-of-options separator stops a Resource URL
    // that begins with `-` (e.g. `--upload-pack=…`) from being parsed as a
    // git flag — `--upload-pack` is a known RCE primitive and a workspace
    // member can write any string they want into Resource.url.
    const child = spawn('git', ['ls-remote', '--heads', '--', url], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`git ls-remote timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(err.trim() || `git ls-remote exited with code ${code}`));
    });
  });

  const branches: RepoBranch[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [sha, ref] = trimmed.split('\t');
    if (!sha || !ref || !ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), sha });
  }

  // Sort: configured default first, then alphabetical.
  const def = (opts.defaultBranch || '').trim();
  branches.sort((a, b) => {
    if (def) {
      if (a.name === def) return -1;
      if (b.name === def) return 1;
    }
    return a.name.localeCompare(b.name);
  });
  return branches;
}
