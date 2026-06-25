// Board environment provisioning (ticket 354d336b).
//
// Runs JUST BEFORE a subagent is spawned for a ticket. Driven by the resolved
// `environment_config` shipped on the agent_trigger SSE payload, it prepares the
// agent's working environment under the agent home:
//   - clone each repository into its target_dir (fetch + ff-only pull when the
//     clone already exists — never destructive),
//   - run setup_commands once (with env_vars injected),
//   - record a per-(agent, config-fingerprint) marker so a prepared environment
//     is not re-provisioned on the next dispatch.
//
// Idempotency key is the fingerprint (sha256) of the resolved config, so:
//   - same board/config → same fingerprint → marker hit → skip,
//   - config changes (or version bump) → new fingerprint → re-provision,
//   - an agent serving two boards with different configs keeps two markers.
//
// On failure the provisioner returns ok=false WITHOUT a marker; the caller
// aborts the dispatch (don't start work in a broken environment) and surfaces
// the error as a ticket comment. A short failure cooldown marker prevents the
// supervisor's re-push cadence from re-cloning / re-commenting in a tight loop.

import { promises as fsp } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFile, exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { MANAGED_AGENTS_DIR } from './constants.js';
import { log } from './logging.js';

/** Mirror of the server's ResolvedEnvironmentConfig (common/environment-config.ts).
 *  agent-manager keeps its own copy — it's a separate package and only consumes
 *  the wire shape (same pattern as HarnessSpec / ResolvedEffortPreset). */
export interface ResolvedEnvironmentRepository {
  url: string;
  target_dir: string;
  branch: string;
  post_clone_commands: string[];
}
export interface ResolvedEnvironmentConfig {
  repositories: ResolvedEnvironmentRepository[];
  env_vars: Record<string, string>;
  setup_commands: string[];
  setup_timeout_seconds: number;
  version: number;
}

export interface ProvisionArgs {
  agentId: string;
  config: ResolvedEnvironmentConfig;
  ticketId?: string;
}

export interface ProvisionResult {
  ok: boolean;
  /** True when a matching fingerprint marker already existed (no work done). */
  skipped: boolean;
  fingerprint: string;
  /** Human-readable log of each provisioning step (for the failure comment). */
  steps: string[];
  error?: string;
  /** True when the failure was already reported in a prior dispatch within the
   *  cooldown window — the caller should abort but NOT re-comment. */
  reported?: boolean;
}

const FAILED_COOLDOWN_MS = 5 * 60 * 1000;

interface ExecResult {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** `git <args>` with no fixed cwd (for clone — the target dir doesn't exist yet). */
function gitRaw(args: string[], cwd: string | undefined, timeoutMs: number): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
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

/** Run an arbitrary shell command (setup / post_clone) with env_vars injected. */
function runShell(
  command: string,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    exec(
      command,
      { cwd, env, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
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

/** Deterministic JSON (sorted keys at every level) so the fingerprint is stable
 *  regardless of object key insertion order. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function fingerprintEnvironment(config: ResolvedEnvironmentConfig): string {
  return createHash('sha256').update(stableStringify(config)).digest('hex').slice(0, 32);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export class EnvironmentProvisioner {
  // Concurrency lock: same (agent, fingerprint) provisioned only once at a time.
  // A second trigger racing the first awaits the same promise instead of
  // launching a parallel clone into the same target dir.
  #inflight = new Map<string, Promise<ProvisionResult>>();

  async provision(args: ProvisionArgs): Promise<ProvisionResult> {
    const fingerprint = fingerprintEnvironment(args.config);
    const lockKey = `${args.agentId}::${fingerprint}`;
    const existing = this.#inflight.get(lockKey);
    if (existing) return existing;
    const run = this.#run(args, fingerprint).finally(() => this.#inflight.delete(lockKey));
    this.#inflight.set(lockKey, run);
    return run;
  }

  async #run(args: ProvisionArgs, fingerprint: string): Promise<ProvisionResult> {
    const agentDir = join(MANAGED_AGENTS_DIR, args.agentId);
    const envDir = join(agentDir, 'env');
    const markerPath = join(envDir, `${fingerprint}.json`);
    const failedPath = join(envDir, `${fingerprint}.failed.json`);
    const steps: string[] = [];

    // Idempotency: a success marker for this exact config → environment is ready.
    if (await pathExists(markerPath)) {
      return { ok: true, skipped: true, fingerprint, steps };
    }

    // Failure cooldown: a recent failure for this exact config → abort without
    // re-running (avoids re-clone churn) and without re-commenting (the prior
    // dispatch already reported it).
    const recentFailure = await this.#readRecentFailure(failedPath);
    if (recentFailure) {
      log(
        `[env-provision] cooldown active for agent=${args.agentId.slice(0, 8)} fp=${fingerprint.slice(0, 8)} (last failure ${recentFailure})`,
      );
      return {
        ok: false,
        skipped: false,
        fingerprint,
        steps,
        error: `environment provisioning previously failed (cooling down): ${recentFailure}`,
        reported: true,
      };
    }

    const timeoutMs = Math.max(1, args.config.setup_timeout_seconds) * 1000;
    const env = { ...process.env, ...(args.config.env_vars || {}) } as Record<string, string>;

    try {
      await fsp.mkdir(envDir, { recursive: true });
      for (const repo of args.config.repositories || []) {
        await this.#prepareRepo(repo, agentDir, env, timeoutMs, steps);
      }
      for (const cmd of args.config.setup_commands || []) {
        log(`[env-provision] setup: ${cmd} (agent=${args.agentId.slice(0, 8)})`);
        const r = await runShell(cmd, agentDir, env, timeoutMs);
        steps.push(`setup [${'.'}] ${cmd} → ${r.ok ? 'ok' : `FAIL(${r.code})`}`);
        if (!r.ok) {
          throw new Error(`setup command failed (exit ${r.code}): ${cmd}\n${tail(r.stderr)}`);
        }
      }
      await fsp.writeFile(
        markerPath,
        JSON.stringify(
          {
            fingerprint,
            applied_at: new Date().toISOString(),
            version: args.config.version,
            repositories: (args.config.repositories || []).map((r) => r.target_dir),
          },
          null,
          2,
        ),
      );
      await fsp.rm(failedPath, { force: true }).catch(() => {});
      log(
        `[env-provision] ready: agent=${args.agentId.slice(0, 8)} fp=${fingerprint.slice(0, 8)} repos=${(args.config.repositories || []).length} setup=${(args.config.setup_commands || []).length}`,
      );
      return { ok: true, skipped: false, fingerprint, steps };
    } catch (err: any) {
      const error = String(err?.message ?? err);
      log(`[env-provision] FAILED: agent=${args.agentId.slice(0, 8)} fp=${fingerprint.slice(0, 8)}: ${error}`);
      await fsp
        .writeFile(failedPath, JSON.stringify({ fingerprint, failed_at: new Date().toISOString(), error, steps }, null, 2))
        .catch(() => {});
      return { ok: false, skipped: false, fingerprint, steps, error };
    }
  }

  async #prepareRepo(
    repo: ResolvedEnvironmentRepository,
    agentDir: string,
    env: Record<string, string>,
    timeoutMs: number,
    steps: string[],
  ): Promise<void> {
    const dest = join(agentDir, repo.target_dir);
    const gitDir = join(dest, '.git');
    let fresh = false;

    if (await pathExists(gitDir)) {
      // Existing clone — update non-destructively: fetch, then ff-only pull.
      const fetched = await gitRaw(['-C', dest, 'fetch', '--all', '--prune'], undefined, timeoutMs);
      steps.push(`fetch ${repo.target_dir} → ${fetched.ok ? 'ok' : `FAIL: ${tail(fetched.stderr)}`}`);
      if (!fetched.ok) {
        throw new Error(`git fetch failed for ${repo.target_dir}: ${tail(fetched.stderr)}`);
      }
      if (repo.branch) {
        const co = await gitRaw(['-C', dest, 'checkout', repo.branch], undefined, timeoutMs);
        steps.push(`checkout ${repo.branch} in ${repo.target_dir} → ${co.ok ? 'ok' : `skip: ${tail(co.stderr)}`}`);
      }
      // ff-only so we never clobber local commits; a diverged tree stays usable.
      const pulled = await gitRaw(['-C', dest, 'pull', '--ff-only'], undefined, timeoutMs);
      steps.push(`pull --ff-only ${repo.target_dir} → ${pulled.ok ? 'ok' : `non-ff (left as-is): ${tail(pulled.stderr)}`}`);
    } else {
      await fsp.mkdir(dirname(dest), { recursive: true });
      const args = ['clone'];
      if (repo.branch) args.push('--branch', repo.branch);
      args.push(repo.url, dest);
      log(`[env-provision] clone ${repo.url} → ${repo.target_dir}`);
      const cloned = await gitRaw(args, undefined, timeoutMs);
      steps.push(`clone ${repo.url} → ${repo.target_dir} ${cloned.ok ? 'ok' : `FAIL: ${tail(cloned.stderr)}`}`);
      if (!cloned.ok) {
        throw new Error(`git clone failed for ${repo.url}: ${tail(cloned.stderr)}`);
      }
      fresh = true;
    }

    // post_clone_commands run ONCE, only on a fresh clone, inside the repo dir.
    if (fresh) {
      for (const cmd of repo.post_clone_commands || []) {
        log(`[env-provision] post_clone [${repo.target_dir}]: ${cmd}`);
        const r = await runShell(cmd, dest, env, timeoutMs);
        steps.push(`post_clone [${repo.target_dir}] ${cmd} → ${r.ok ? 'ok' : `FAIL(${r.code})`}`);
        if (!r.ok) {
          throw new Error(`post_clone command failed (exit ${r.code}) in ${repo.target_dir}: ${cmd}\n${tail(r.stderr)}`);
        }
      }
    }
  }

  async #readRecentFailure(failedPath: string): Promise<string | null> {
    try {
      const raw = await fsp.readFile(failedPath, 'utf8');
      const parsed = JSON.parse(raw);
      const failedAt = Date.parse(parsed?.failed_at || '');
      if (!Number.isFinite(failedAt)) return null;
      if (Date.now() - failedAt > FAILED_COOLDOWN_MS) return null;
      return String(parsed?.error || 'unknown error');
    } catch {
      return null;
    }
  }
}

function tail(s: string, n = 1500): string {
  const t = (s || '').trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}
