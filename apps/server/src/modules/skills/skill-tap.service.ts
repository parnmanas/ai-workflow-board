import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { SkillTap } from '../../entities/SkillTap';
import { LogService } from '../../services/log.service';
import { validateOutboundUrl } from '../../common/ssrf-guard';
import { sanitizeGitError } from '../mcp/shared/git-branches';
import { loadSkillTree } from './skill-source';
import { SkillSyncService, type SyncSummary } from './skill-sync.service';
import { validateSkillPath } from './skill-validation';

function httpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

const CLONE_TIMEOUT_MS = 60_000;

/**
 * External skill registries ("taps") — git repositories AWB pulls global
 * skills from, modelled on the Hermes skill hub's tap model.
 *
 * Nothing here runs on boot. A tap is registered by an admin, starts
 * `enabled = 0`, and only syncs when explicitly triggered or after the admin
 * enables it — because a skill body becomes agent-facing prompt text, so
 * pulling one from a third-party repository is an operator decision rather
 * than a startup side effect. The pack that ships inside the AWB repo covers
 * the "works out of the box" case (see BuiltinSkillPackService).
 */
@Injectable()
export class SkillTapService {
  constructor(
    @InjectRepository(SkillTap) private readonly taps: Repository<SkillTap>,
    private readonly sync: SkillSyncService,
    private readonly logService: LogService,
  ) {}

  list() {
    return this.taps.find({ order: { created_at: 'ASC' } });
  }

  async create(body: any, actorId: string): Promise<SkillTap> {
    const repoUrl = await this.assertSafeRepoUrl(body?.repo_url);
    const path = this.normalizePath(body?.path);
    const ref = this.normalizeRef(body?.ref);
    const existing = await this.taps.findOne({ where: { repo_url: repoUrl, ref, path } });
    if (existing) throw httpError(409, 'skill_tap_duplicate', 'This repository/ref/path is already tapped');
    return this.taps.save(this.taps.create({
      name: String(body?.name || repoUrl).trim().slice(0, 200),
      repo_url: repoUrl,
      ref,
      path,
      // Opt-in by construction — see the class doc.
      enabled: body?.enabled === true || body?.enabled === 1 ? 1 : 0,
      allowed_licenses: this.normalizeLicenses(body?.allowed_licenses),
      created_by: actorId,
    }));
  }

  async update(id: string, body: any): Promise<SkillTap> {
    const tap = await this.require(id);
    if (body?.name !== undefined) tap.name = String(body.name).trim().slice(0, 200);
    if (body?.ref !== undefined) tap.ref = this.normalizeRef(body.ref);
    if (body?.path !== undefined) tap.path = this.normalizePath(body.path);
    if (body?.enabled !== undefined) tap.enabled = body.enabled === true || body.enabled === 1 ? 1 : 0;
    if (body?.allowed_licenses !== undefined) tap.allowed_licenses = this.normalizeLicenses(body.allowed_licenses);
    return this.taps.save(tap);
  }

  async remove(id: string): Promise<{ removed: true }> {
    const tap = await this.require(id);
    // Skills already synced from this tap are intentionally LEFT in place:
    // deleting them would yank definitions out from under agents that have
    // versions of them assigned. Removing a tap stops future updates, nothing
    // more. Operators who want the content gone quarantine the skills.
    await this.taps.delete({ id: tap.id });
    return { removed: true };
  }

  /**
   * Clone the tap shallowly into a temp dir, load its skill tree, and upsert
   * every accepted skill into the global scope. `dryRun` reports what WOULD
   * change without writing — the preview an admin gets before enabling a tap.
   */
  async syncOne(id: string, opts: { dryRun?: boolean; force?: boolean } = {}): Promise<{
    tap: SkillTap;
    commit: string;
    summary: SyncSummary;
    skipped: Array<{ path: string; reason: string }>;
    loaded: number;
    dry_run: boolean;
  }> {
    const tap = await this.require(id);
    if (!tap.enabled && !opts.force && !opts.dryRun) {
      throw httpError(409, 'skill_tap_disabled', 'Tap is disabled — enable it or sync with force');
    }
    // Re-validate on every sync, not only at create: DNS behind the host can
    // change to a private address after registration.
    await this.assertSafeRepoUrl(tap.repo_url);

    const workdir = await mkdtemp(join(tmpdir(), 'awb-skill-tap-'));
    try {
      const commit = await this.clone(tap, workdir);
      const root = tap.path ? join(workdir, tap.path) : workdir;
      const report = await loadSkillTree(root, { licenseFilter: this.parseLicenses(tap.allowed_licenses) });

      if (opts.dryRun) {
        return {
          tap,
          commit,
          summary: {
            created: 0, updated: 0, alreadyCurrent: 0, quarantined: 0, conflicted: 0,
            skipped: report.skipped.length,
            details: report.skills.map((s) => `would sync ${s.slug}`),
          },
          skipped: report.skipped,
          loaded: report.skills.length,
          dry_run: true,
        };
      }

      const summary = await this.sync.syncGlobalSkills(report.skills, {
        kind: 'tap',
        id: tap.id,
        label: `Skill tap "${tap.name}"`,
      });
      tap.last_synced_at = new Date();
      tap.last_sync_status = 'ok';
      tap.last_sync_error = '';
      tap.last_synced_commit = commit;
      tap.last_sync_summary = { ...summary, loaded: report.skills.length, skipped_files: report.skipped.length };
      await this.taps.save(tap);
      return { tap, commit, summary, skipped: report.skipped, loaded: report.skills.length, dry_run: false };
    } catch (error: any) {
      const message = sanitizeGitError(error?.message ?? String(error));
      if (!opts.dryRun) {
        tap.last_synced_at = new Date();
        tap.last_sync_status = 'error';
        tap.last_sync_error = message.slice(0, 2000);
        await this.taps.save(tap);
      }
      this.logService.error('Skills', `Skill tap sync failed (${tap.name}): ${message}`);
      throw httpError(502, 'skill_tap_sync_failed', message);
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => {});
    }
  }

  /** Sync every enabled tap. Invoked manually or by a schedule — never at boot. */
  async syncAllEnabled(): Promise<Array<{ tap_id: string; name: string; ok: boolean; error?: string }>> {
    const enabled = await this.taps.find({ where: { enabled: 1 } });
    const results: Array<{ tap_id: string; name: string; ok: boolean; error?: string }> = [];
    for (const tap of enabled) {
      try {
        await this.syncOne(tap.id);
        results.push({ tap_id: tap.id, name: tap.name, ok: true });
      } catch (error: any) {
        // One unreachable remote must not abort the rest of the sweep.
        results.push({ tap_id: tap.id, name: tap.name, ok: false, error: error?.message ?? String(error) });
      }
    }
    return results;
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async require(id: string): Promise<SkillTap> {
    const tap = await this.taps.findOne({ where: { id } });
    if (!tap) throw httpError(404, 'skill_tap_not_found', 'Skill tap not found');
    return tap;
  }

  /**
   * https only, and run through the shared SSRF guard so a tap cannot be
   * pointed at localhost / link-local / RFC1918 to make the server fetch from
   * its own network. `git@`/`ssh://` are refused: they would need a key on the
   * server, which is a credential surface this feature does not open.
   */
  private async assertSafeRepoUrl(input: unknown): Promise<string> {
    const raw = String(input ?? '').trim();
    if (!raw) throw httpError(400, 'skill_tap_url_required', 'repo_url is required');
    if (!/^https:\/\//i.test(raw)) {
      throw httpError(400, 'skill_tap_url_invalid', 'Only https:// repository URLs are supported');
    }
    if (raw.includes('@')) {
      // Userinfo in the URL would put a token in the DB in plain text.
      throw httpError(400, 'skill_tap_url_invalid', 'Credentials must not be embedded in the tap URL');
    }
    try {
      await validateOutboundUrl(raw);
    } catch (error: any) {
      throw httpError(400, 'skill_tap_url_invalid', error?.message ?? 'Repository URL is not allowed');
    }
    return raw;
  }

  /** Ref names are passed to git as argv, but still constrained so a value like
   *  `--upload-pack=...` can never be read as an option. */
  private normalizeRef(input: unknown): string {
    const ref = String(input ?? '').trim();
    if (!ref) return '';
    if (!/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,200}$/.test(ref)) {
      throw httpError(400, 'skill_tap_ref_invalid', 'Invalid git ref');
    }
    return ref;
  }

  /** Subdirectory inside the repo, reusing the skill path validator so `..`,
   *  absolute paths and `.git` traversal are rejected identically. */
  private normalizePath(input: unknown): string {
    const raw = String(input ?? '').trim().replace(/^\/+|\/+$/g, '');
    if (!raw) return '';
    try {
      return validateSkillPath(raw);
    } catch {
      throw httpError(400, 'skill_tap_path_invalid', 'Invalid path inside the repository');
    }
  }

  private normalizeLicenses(input: unknown): string {
    if (input === undefined || input === null) return '["MIT","Apache-2.0"]';
    const values = Array.isArray(input)
      ? input
      : String(input).split(',');
    const cleaned = values
      .map((v) => String(v).trim())
      .filter(Boolean)
      .slice(0, 32);
    return JSON.stringify(cleaned);
  }

  private parseLicenses(stored: string): string[] {
    try {
      const parsed = JSON.parse(stored || '[]');
      return Array.isArray(parsed) ? parsed.map((v) => String(v)) : [];
    } catch {
      return [];
    }
  }

  /**
   * `git clone --depth 1 --single-branch` into `dir`, then resolve HEAD.
   *
   * argv form (never a shell string) so a repo URL or ref cannot inject a
   * command, `--` terminates option parsing, and the environment disables
   * every interactive prompt so an auth-required repo fails fast instead of
   * hanging the request until the timeout.
   */
  private async clone(tap: SkillTap, dir: string): Promise<string> {
    const args = ['clone', '--depth', '1', '--single-branch'];
    if (tap.ref) args.push('--branch', tap.ref);
    args.push('--', tap.repo_url, dir);
    await this.runGit(args, undefined);
    const head = await this.runGit(['rev-parse', 'HEAD'], dir);
    return head.trim();
  }

  private runGit(args: string[], cwd: string | undefined): Promise<string> {
    return new Promise((resolvePromise, rejectPromise) => {
      const child = spawn('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          GIT_ASKPASS: 'echo',
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_LFS_SKIP_SMUDGE: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        rejectPromise(new Error(`git ${args[0]} timed out after ${CLONE_TIMEOUT_MS}ms`));
      }, CLONE_TIMEOUT_MS);
      child.stdout.on('data', (chunk) => { stdout += String(chunk).slice(0, 8192); });
      child.stderr.on('data', (chunk) => { stderr += String(chunk).slice(0, 8192); });
      child.on('error', (error) => {
        clearTimeout(timer);
        rejectPromise(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(stdout);
        else rejectPromise(new Error(stderr.trim() || `git ${args[0]} exited with ${code}`));
      });
    });
  }
}
