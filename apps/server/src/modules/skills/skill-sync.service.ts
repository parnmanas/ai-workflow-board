import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Skill } from '../../entities/Skill';
import { SkillVersion } from '../../entities/SkillVersion';
import { LogService } from '../../services/log.service';
import type { LoadedSkill } from './skill-source';

export interface SyncSummary {
  created: number;
  updated: number;
  alreadyCurrent: number;
  quarantined: number;
  conflicted: number;
  skipped: number;
  details: string[];
}

export function emptySummary(): SyncSummary {
  return { created: 0, updated: 0, alreadyCurrent: 0, quarantined: 0, conflicted: 0, skipped: 0, details: [] };
}

/**
 * Upsert a loaded skill tree into the GLOBAL skill scope.
 *
 * Shared by the built-in pack seeder and the git tap sync, because the
 * reconciliation rules are identical and must not drift apart:
 *
 *   - **Append-only.** An update publishes a NEW immutable SkillVersion; no
 *     existing version is ever edited or deleted. Every AgentSkillAssignment
 *     pins a specific `skill_version_id`, so a sync can never change what an
 *     already-assigned agent runs — the operator re-points the assignment when
 *     they are ready. This is the same guarantee the run snapshot relies on.
 *   - **Digest-idempotent.** If the head version's digest equals the incoming
 *     one, nothing is written. Re-running the seeder on every boot is therefore
 *     free, which is what makes "always latest" safe to wire into startup.
 *   - **Quarantine is an operator veto.** A `quarantined` skill is skipped
 *     entirely. An upstream push must never silently revive a definition the
 *     operator deliberately pulled out of circulation.
 *   - **Ownership is checked.** A global skill whose `source_kind`/`source_id`
 *     does not match this source is reported as a conflict and left alone —
 *     a tap cannot hijack the slug of a built-in or of a hand-authored global
 *     skill, and two taps cannot fight over one slug.
 *
 * Workspace skills are never touched: a workspace fork shadows the global by
 * slug, so the fork keeps winning while the global underneath keeps updating.
 */
@Injectable()
export class SkillSyncService {
  constructor(
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(SkillVersion) private readonly versions: Repository<SkillVersion>,
    private readonly logService: LogService,
  ) {}

  async syncGlobalSkills(
    loaded: LoadedSkill[],
    source: { kind: 'builtin' | 'tap'; id: string; label: string },
  ): Promise<SyncSummary> {
    const summary = emptySummary();

    for (const item of loaded) {
      try {
        const existing = await this.skills.findOne({
          where: { workspace_id: IsNull(), slug: item.slug },
        });

        if (existing && existing.status === 'quarantined') {
          summary.quarantined += 1;
          summary.details.push(`skip ${item.slug}: quarantined by an operator`);
          continue;
        }

        if (existing && !this.isOwnedBy(existing, source)) {
          summary.conflicted += 1;
          summary.details.push(
            `skip ${item.slug}: global slug already owned by ${existing.source_kind}`
            + `${existing.source_id ? `:${existing.source_id.slice(0, 8)}` : ''}`,
          );
          continue;
        }

        if (!existing) {
          await this.createSkill(item, source);
          summary.created += 1;
          continue;
        }

        const head = await this.versions.findOne({
          where: { skill_id: existing.id },
          order: { version: 'DESC' },
        });
        if (head?.digest === item.digest) {
          // Metadata (name/description/upstream version) can still drift while
          // the body is byte-identical — keep it fresh without publishing.
          await this.refreshMetadata(existing, item, source);
          summary.alreadyCurrent += 1;
          continue;
        }

        await this.publishVersion(existing, item, (head?.version ?? 0) + 1, source);
        summary.updated += 1;
      } catch (error: any) {
        summary.skipped += 1;
        summary.details.push(`skip ${item.slug}: ${error?.message ?? String(error)}`);
      }
    }

    this.logService.info(
      'Skills',
      `${source.label} sync — created=${summary.created} updated=${summary.updated} `
      + `current=${summary.alreadyCurrent} quarantined=${summary.quarantined} `
      + `conflict=${summary.conflicted} skipped=${summary.skipped}`,
      { source_kind: source.kind, source_id: source.id, ...summary },
    );
    return summary;
  }

  /**
   * A row is this source's to update when both the kind and the id match.
   * `source_kind: 'local'` never matches, so a hand-authored global skill is
   * permanently immune to being overwritten by a pack or a tap that later
   * happens to publish the same slug.
   */
  private isOwnedBy(skill: Skill, source: { kind: string; id: string }): boolean {
    return skill.source_kind === source.kind && skill.source_id === source.id;
  }

  private async createSkill(item: LoadedSkill, source: { kind: 'builtin' | 'tap'; id: string }) {
    return this.skills.manager.transaction(async (manager) => {
      const skillRepo = manager.getRepository(Skill);
      const versionRepo = manager.getRepository(SkillVersion);
      const skill = await skillRepo.save(skillRepo.create({
        workspace_id: null,
        slug: item.slug,
        name: item.frontmatter.name || item.slug,
        description: item.frontmatter.description,
        status: 'active',
        source_kind: source.kind,
        source_id: source.id,
        source_path: item.sourcePath,
        source_version: item.frontmatter.version,
        source_license: item.frontmatter.license,
        source_author: item.frontmatter.author,
      }));
      await versionRepo.save(versionRepo.create({
        workspace_id: null,
        skill_id: skill.id,
        version: 1,
        body: item.body,
        support_files: item.supportFiles,
        digest: item.digest,
        created_by: `${source.kind}:${source.id}`,
      }));
      return skill;
    });
  }

  private async publishVersion(
    skill: Skill,
    item: LoadedSkill,
    nextVersion: number,
    source: { kind: 'builtin' | 'tap'; id: string },
  ) {
    // A digest can reappear when upstream reverts a change. The
    // (skill_id, digest) unique index would reject the insert, so reuse the
    // earlier version instead of failing the whole sync over a revert.
    const revert = await this.versions.findOne({ where: { skill_id: skill.id, digest: item.digest } });
    if (!revert) {
      await this.versions.save(this.versions.create({
        workspace_id: null,
        skill_id: skill.id,
        version: nextVersion,
        body: item.body,
        support_files: item.supportFiles,
        digest: item.digest,
        created_by: `${source.kind}:${source.id}`,
      }));
    }
    await this.refreshMetadata(skill, item, source);
  }

  private async refreshMetadata(
    skill: Skill,
    item: LoadedSkill,
    source: { kind: 'builtin' | 'tap'; id: string },
  ) {
    const next = {
      name: item.frontmatter.name || item.slug,
      description: item.frontmatter.description,
      source_kind: source.kind,
      source_id: source.id,
      source_path: item.sourcePath,
      source_version: item.frontmatter.version,
      source_license: item.frontmatter.license,
      source_author: item.frontmatter.author,
    };
    const changed = Object.entries(next).some(([key, value]) => (skill as any)[key] !== value);
    if (!changed) return;
    await this.skills.update({ id: skill.id }, next);
  }
}
