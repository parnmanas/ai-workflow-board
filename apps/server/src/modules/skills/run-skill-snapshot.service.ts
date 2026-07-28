import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { AgentSkillAssignment } from '../../entities/AgentSkillAssignment';
import { RunSkillSnapshot } from '../../entities/RunSkillSnapshot';
import { Skill } from '../../entities/Skill';
import { SkillVersion } from '../../entities/SkillVersion';

export interface PinnedSkillManifestEntry {
  skill_id: string;
  skill_version_id: string;
  slug: string;
  version: number;
  digest: string;
  body: string;
  support_files: Array<{ path: string; content: string }>;
}

@Injectable()
export class RunSkillSnapshotService {
  constructor(
    @InjectRepository(RunSkillSnapshot) private readonly snapshots: Repository<RunSkillSnapshot>,
    @InjectRepository(AgentSkillAssignment) private readonly assignments: Repository<AgentSkillAssignment>,
    @InjectRepository(SkillVersion) private readonly versions: Repository<SkillVersion>,
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
  ) {}

  async resolve(args: {
    workspaceId: string;
    runId: string;
    agentId: string;
    boardId?: string;
    roleSlug?: string;
  }): Promise<RunSkillSnapshot> {
    const existing = await this.snapshots.findOne({
      where: { workspace_id: args.workspaceId, run_id: args.runId },
    });
    if (existing) return existing;

    const allAssignments = await this.assignments.find({
      where: { workspace_id: args.workspaceId, agent_id: args.agentId },
    });
    const selected = allAssignments.filter((assignment) =>
      (!assignment.board_id || assignment.board_id === (args.boardId || ''))
      && (!assignment.role_slug || assignment.role_slug === (args.roleSlug || '')),
    );
    const versionIds = selected.map((assignment) => assignment.skill_version_id);
    const versions = versionIds.length
      ? await this.versions.find({ where: { id: In(versionIds), workspace_id: args.workspaceId } })
      : [];
    const skills = versions.length
      ? await this.skills.find({
          where: { id: In(versions.map((version) => version.skill_id)), workspace_id: args.workspaceId },
        })
      : [];
    const skillById = new Map(skills.filter((skill) => skill.status === 'active').map((skill) => [skill.id, skill]));
    const manifest: PinnedSkillManifestEntry[] = versions
      .filter((version) => skillById.has(version.skill_id))
      .map((version) => ({
        skill_id: version.skill_id,
        skill_version_id: version.id,
        slug: skillById.get(version.skill_id)!.slug,
        version: version.version,
        digest: version.digest,
        body: version.body,
        support_files: version.support_files,
      }))
      .sort((a, b) => a.slug.localeCompare(b.slug) || a.digest.localeCompare(b.digest));
    const digest = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
    try {
      return await this.snapshots.save(this.snapshots.create({
        workspace_id: args.workspaceId,
        run_id: args.runId,
        agent_id: args.agentId,
        manifest,
        digest,
        status: 'pinned',
        locked_at: null,
      }));
    } catch (error) {
      // Two dispatch producers can race on the same logical run. The unique
      // (workspace, run) boundary chooses the winner; every loser must reuse
      // that exact immutable snapshot instead of calculating a replacement.
      const winner = await this.snapshots.findOne({
        where: { workspace_id: args.workspaceId, run_id: args.runId },
      });
      if (winner) return winner;
      throw error;
    }
  }

  async lock(workspaceId: string, runId: string): Promise<void> {
    await this.snapshots.update(
      { workspace_id: workspaceId, run_id: runId, status: 'pinned' },
      { status: 'locked', locked_at: new Date() },
    );
  }
}
