// QA/security run-workspace provisioner (ticket 25db3cc6 — 작업폴더 옵션화 4/5).
//
// Runs JUST BEFORE a QA/security run subagent is spawned, driven by the
// `run_provision` hint the server ships on the run-dispatch chat_room_message.
// It guarantees the working folder is checked out so the run never improvises a
// folder of its own (the GameClient re-clone problem):
//   - `reuse`: fetch + ff-only pull when the clone already exists, else clone.
//   - `fresh`: wipe the folder, then clone.
//   - no repo: just ensure the folder exists (the rendered prompt drives the rest).
//
// Folder is rooted at AGENT_MANAGER_HOME, NOT MANAGED_AGENTS_DIR/<agentId> — this
// matches exactly the path ticket (3) renders into the run prompt
// (`$AWB_AGENT_MANAGER_HOME/<workspace_folder>`), so the prepared checkout and the
// agent's instructions point at the same directory. The prepared absolute path is
// returned so the caller can pin it as the subagent cwd.
//
// Responsibility boundary (agreed with ticket 3): this provisioner does SOURCE
// SYNC only (checkout). Build/test stays the agent's job, kept in the prompt.
//
// Unlike environment-provisioner.ts (board environment_config, fingerprint-marker
// idempotent → skips work on a repeat dispatch), a run must pull on EVERY reuse
// dispatch so a warm run picks up new commits. Hence no marker here — the cost is
// one fetch+ff-pull per run, which is the whole point.

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { AGENT_MANAGER_HOME } from './constants.js';
import { log } from './logging.js';

export type RunCheckoutMode = 'reuse' | 'fresh';

/** A repo to clone for the run — the server resolves repo_ref → concrete url. */
export interface RunRepoSpec {
  url: string;
  branch?: string;
}

/** Wire shape of the `run_provision` hint (mirror of the server's RunProvision —
 *  agent-manager is a separate package and only consumes the wire shape, same
 *  pattern as ResolvedEnvironmentConfig / HarnessSpec). */
export interface RunProvision {
  kind: 'qa' | 'security';
  run_id: string;
  workspace_id: string;
  workspace_folder: string;
  checkout_mode: RunCheckoutMode;
  repo: RunRepoSpec | null;
}

export interface RunProvisionResult {
  ok: boolean;
  /** Absolute prepared folder (subagent cwd). Set even on failure for logging. */
  dir: string;
  /** Human-readable log of each step (surfaced in the failure room message). */
  steps: string[];
  error?: string;
}

// Generous timeout — a cold clone of a large repo (GameClient) is exactly the
// case this feature exists for. Source sync only; builds are not run here.
const RUN_GIT_TIMEOUT_MS = 20 * 60 * 1000;

interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

function git(args: string[], timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          code: (err as any)?.code ?? 0,
          stdout: (stdout ?? '').toString(),
          stderr: (stderr ?? (err as any)?.message ?? '').toString(),
        });
      },
    );
  });
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

function tail(s: string, n = 1500): string {
  const t = (s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * Defensively parse a wire `run_provision` value into a RunProvision (or null
 * when absent/malformed — an ordinary chat turn carries no such field). Mirrors
 * the env-config parser pattern: never throws, drops anything it can't validate.
 */
export function parseRunProvision(raw: unknown): RunProvision | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const kind = o.kind === 'security' ? 'security' : o.kind === 'qa' ? 'qa' : null;
  const run_id = typeof o.run_id === 'string' ? o.run_id : '';
  const workspace_id = typeof o.workspace_id === 'string' ? o.workspace_id : '';
  const folderRaw = typeof o.workspace_folder === 'string' ? o.workspace_folder : '';
  if (!kind || !run_id || !workspace_id || !folderRaw) return null;
  const checkout_mode: RunCheckoutMode = o.checkout_mode === 'fresh' ? 'fresh' : 'reuse';

  let repo: RunRepoSpec | null = null;
  const r = o.repo as Record<string, unknown> | null | undefined;
  if (r && typeof r === 'object' && typeof r.url === 'string' && r.url.trim()) {
    repo = { url: r.url.trim() };
    if (typeof r.branch === 'string' && r.branch.trim()) repo.branch = r.branch.trim();
  }

  return { kind, run_id, workspace_id, workspace_folder: folderRaw, checkout_mode, repo };
}

/**
 * Prepare the run's working folder per its `run_provision`. Never throws — a
 * git failure is captured into `{ ok:false, error, steps }` so the caller can
 * abort the dispatch and surface the reason (the "dispatch 중단 + 코멘트" path).
 */
export async function provisionRunWorkspace(p: RunProvision): Promise<RunProvisionResult> {
  const steps: string[] = [];
  // workspace_folder is manager-home-relative; strip any leading slash so it can
  // never escape the home root (matches the server's normalizeWorkspaceFolder).
  const rel = p.workspace_folder.replace(/^[/\\]+/, '');
  const dir = join(AGENT_MANAGER_HOME, rel);
  const gitDir = join(dir, '.git');

  try {
    if (p.checkout_mode === 'fresh') {
      await fsp.rm(dir, { recursive: true, force: true });
      steps.push(`wipe ${rel} → ok`);
    }

    if (!p.repo) {
      // No clone source — just ensure the folder exists; the rendered prompt
      // still tells the agent what to do inside it.
      await fsp.mkdir(dir, { recursive: true });
      steps.push(`ensure folder ${rel} (no repo to clone) → ok`);
      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} folder ready (no repo): ${dir}`);
      return { ok: true, dir, steps };
    }

    const haveClone = p.checkout_mode === 'reuse' && (await pathExists(gitDir));
    if (haveClone) {
      // Existing clone — update non-destructively: fetch, then ff-only pull.
      const fetched = await git(['-C', dir, 'fetch', '--all', '--prune'], RUN_GIT_TIMEOUT_MS);
      steps.push(`fetch ${rel} → ${fetched.ok ? 'ok' : `FAIL: ${tail(fetched.stderr)}`}`);
      if (!fetched.ok) throw new Error(`git fetch failed for ${rel}: ${tail(fetched.stderr)}`);
      if (p.repo.branch) {
        const co = await git(['-C', dir, 'checkout', p.repo.branch], RUN_GIT_TIMEOUT_MS);
        steps.push(`checkout ${p.repo.branch} → ${co.ok ? 'ok' : `FAIL: ${tail(co.stderr)}`}`);
        if (!co.ok) throw new Error(`git checkout ${p.repo.branch} failed in ${rel}: ${tail(co.stderr)}`);
      }
      // ff-only so a diverged local tree stays usable rather than getting clobbered.
      const pulled = await git(['-C', dir, 'pull', '--ff-only'], RUN_GIT_TIMEOUT_MS);
      steps.push(`pull --ff-only ${rel} → ${pulled.ok ? 'ok' : `non-ff (left as-is): ${tail(pulled.stderr)}`}`);
    } else {
      // Clone — folder is absent (reuse first run), was just wiped (fresh), or
      // exists without a .git. In the last case the leftover would make clone
      // fail, so clear it first.
      if (p.checkout_mode === 'reuse' && (await pathExists(dir))) {
        await fsp.rm(dir, { recursive: true, force: true });
        steps.push(`clear non-git ${rel} before clone → ok`);
      }
      await fsp.mkdir(dirname(dir), { recursive: true });
      const args = ['clone'];
      if (p.repo.branch) args.push('--branch', p.repo.branch);
      args.push(p.repo.url, dir);
      log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} clone ${p.repo.url} → ${dir}`);
      const cloned = await git(args, RUN_GIT_TIMEOUT_MS);
      steps.push(`clone ${p.repo.url} → ${rel} ${cloned.ok ? 'ok' : `FAIL: ${tail(cloned.stderr)}`}`);
      if (!cloned.ok) throw new Error(`git clone failed for ${p.repo.url}: ${tail(cloned.stderr)}`);
    }

    log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} ready: ${dir}`);
    return { ok: true, dir, steps };
  } catch (err: any) {
    const error = String(err?.message ?? err);
    log(`[run-provision] ${p.kind} run=${p.run_id.slice(0, 8)} FAILED: ${error}`);
    return { ok: false, dir, steps, error };
  }
}
