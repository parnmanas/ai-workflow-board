import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { LogService } from '../../services/log.service';
import { loadSkillTree } from './skill-source';
import { SkillSyncService, emptySummary, type SyncSummary } from './skill-sync.service';

/**
 * The skill pack that ships INSIDE the AWB repository.
 *
 * Why in-repo rather than "just tap a registry": a fresh install must come up
 * with a usable global skill set with no network, no operator action, and no
 * third-party availability in the boot path. The pack is plain
 * `skills/<category>/<slug>/SKILL.md` at the repo root — a normal directory of
 * markdown, so it is reviewed in PRs, diffed, and released with the server it
 * belongs to. "Always latest" is therefore a property of upgrading AWB, not of
 * a runtime fetch.
 *
 * Operators who prefer to manage the pack in their OWN git repository point
 * `AWB_BUILTIN_SKILLS_DIR` at a checkout they control and pull it on their own
 * schedule; the seeder reads whatever is there at boot. External registries
 * that should be tracked continuously are SkillTaps instead (opt-in).
 *
 * Seeding is idempotent (digest-compared) and append-only — see
 * SkillSyncService for the reconciliation rules.
 */
@Injectable()
export class BuiltinSkillPackService implements OnModuleInit {
  /** Stable id so a re-seed recognises the rows it already owns. */
  static readonly SOURCE_ID = 'awb-builtin-pack';

  constructor(
    private readonly sync: SkillSyncService,
    private readonly logService: LogService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.AWB_SKIP_BUILTIN_SKILLS === '1') {
      this.logService.info('Skills', 'Built-in skill pack seeding skipped (AWB_SKIP_BUILTIN_SKILLS=1)');
      return;
    }
    try {
      await this.seed();
    } catch (error: any) {
      // Never block boot on the pack. A server with no skills still serves
      // every other surface; a server that will not start serves none.
      this.logService.error(
        'Skills',
        `Built-in skill pack seeding failed: ${error?.message ?? String(error)}`,
        { stack: error?.stack },
      );
    }
  }

  async seed(): Promise<SyncSummary & { dir: string | null }> {
    const dir = this.resolvePackDir();
    if (!dir) {
      this.logService.warn(
        'Skills',
        'Built-in skill pack directory not found — no global skills seeded. '
        + 'Set AWB_BUILTIN_SKILLS_DIR to point at a skills/ tree.',
      );
      return { ...emptySummary(), dir: null };
    }
    // No license filter: everything in this directory ships in the AWB repo (or
    // was placed there by the operator), so redistribution is already settled.
    const report = await loadSkillTree(dir);
    for (const skip of report.skipped) {
      this.logService.warn('Skills', `Built-in skill skipped: ${skip.path} — ${skip.reason}`);
    }
    const summary = await this.sync.syncGlobalSkills(report.skills, {
      kind: 'builtin',
      id: BuiltinSkillPackService.SOURCE_ID,
      label: `Built-in skill pack (${dir})`,
    });
    return { ...summary, dir };
  }

  /**
   * Candidate roots, in priority order. The build output lives at
   * `apps/server/dist/`, so the repo root is three levels up in a source
   * checkout; the Docker image copies the pack to `/app/skills` next to
   * `apps/server/dist`, which the same relative walk finds.
   */
  private resolvePackDir(): string | null {
    const override = (process.env.AWB_BUILTIN_SKILLS_DIR || '').trim();
    if (override) {
      const abs = resolve(override);
      return existsSync(abs) ? abs : null;
    }
    const candidates = [
      join(__dirname, '..', '..', '..', '..', '..', 'skills'), // dist/modules/skills → repo root
      join(__dirname, '..', '..', '..', '..', 'skills'),
      join(process.cwd(), 'skills'),
      join(process.cwd(), '..', '..', 'skills'),
    ];
    for (const candidate of candidates) {
      const abs = resolve(candidate);
      if (existsSync(abs)) return abs;
    }
    return null;
  }
}
