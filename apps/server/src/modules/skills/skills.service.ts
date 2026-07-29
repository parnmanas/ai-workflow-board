import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { AgentSkillAssignment } from '../../entities/AgentSkillAssignment';
import { Skill } from '../../entities/Skill';
import { SkillProposal } from '../../entities/SkillProposal';
import { SkillVersion } from '../../entities/SkillVersion';
import { canonicalizeSkillContent } from './skill-validation';

function httpError(status: number, code: string, message: string) {
  return Object.assign(new Error(message), { status, code });
}

@Injectable()
export class SkillsService {
  constructor(
    @InjectRepository(Skill) private readonly skills: Repository<Skill>,
    @InjectRepository(SkillVersion) private readonly versions: Repository<SkillVersion>,
    @InjectRepository(AgentSkillAssignment) private readonly assignments: Repository<AgentSkillAssignment>,
    @InjectRepository(SkillProposal) private readonly proposals: Repository<SkillProposal>,
    @InjectRepository(Agent) private readonly agents: Repository<Agent>,
  ) {}

  list(workspaceId: string) {
    return this.skills.find({ where: { workspace_id: workspaceId }, order: { name: 'ASC' } });
  }

  listProposals(workspaceId: string, status?: 'pending' | 'approved' | 'rejected') {
    return this.proposals.find({
      where: {
        workspace_id: workspaceId,
        ...(status ? { status } : {}),
      },
      order: { created_at: 'DESC' },
      take: 250,
    });
  }

  async get(workspaceId: string, skillId: string) {
    const skill = await this.requireSkill(workspaceId, skillId);
    const versions = await this.versions.find({
      where: { workspace_id: workspaceId, skill_id: skillId },
      order: { version: 'DESC' },
    });
    return { ...skill, versions };
  }

  async create(workspaceId: string, body: any, actorId: string) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'skill_slug_invalid', 'Skill slug is invalid');
    }
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    return this.skills.manager.transaction(async (manager) => {
      const skillRepo = manager.getRepository(Skill);
      const versionRepo = manager.getRepository(SkillVersion);
      if (await skillRepo.findOne({ where: { workspace_id: workspaceId, slug } })) {
        throw httpError(409, 'skill_slug_duplicate', 'Skill slug already exists');
      }
      const skill = await skillRepo.save(skillRepo.create({
        workspace_id: workspaceId,
        slug,
        name: String(body.name || slug).trim(),
        description: String(body.description || ''),
        status: 'active',
      }));
      const version = await versionRepo.save(versionRepo.create({
        workspace_id: workspaceId,
        skill_id: skill.id,
        version: 1,
        body: canonical.body,
        support_files: canonical.supportFiles,
        digest: canonical.digest,
        created_by: actorId,
      }));
      return { ...skill, version };
    });
  }

  async publish(workspaceId: string, skillId: string, body: any, actorId: string, sourceProposalId = '') {
    await this.requireSkill(workspaceId, skillId);
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    if (await this.versions.findOne({ where: { skill_id: skillId, digest: canonical.digest } })) {
      throw httpError(409, 'skill_version_duplicate', 'Identical immutable version already exists');
    }
    const latest = await this.versions.findOne({
      where: { workspace_id: workspaceId, skill_id: skillId },
      order: { version: 'DESC' },
    });
    return this.versions.save(this.versions.create({
      workspace_id: workspaceId,
      skill_id: skillId,
      version: (latest?.version ?? 0) + 1,
      body: canonical.body,
      support_files: canonical.supportFiles,
      digest: canonical.digest,
      created_by: actorId,
      source_proposal_id: sourceProposalId,
    }));
  }

  async assign(workspaceId: string, skillId: string, body: any, actorId: string) {
    await this.requireSkill(workspaceId, skillId);
    const version = await this.versions.findOne({
      where: { id: String(body.skill_version_id), workspace_id: workspaceId, skill_id: skillId },
    });
    if (!version) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    const agent = await this.agents.findOne({ where: { id: String(body.agent_id) } });
    if (!agent || agent.workspace_id !== workspaceId) {
      throw httpError(404, 'agent_not_in_workspace', 'Agent does not belong to this workspace');
    }
    const boardId = String(body.board_id || '');
    const roleSlug = String(body.role_slug || '');
    const existing = await this.assignments.findOne({
      where: {
        agent_id: agent.id,
        skill_id: skillId,
        board_id: boardId,
        role_slug: roleSlug,
      },
    });
    return this.assignments.save(this.assignments.create({
      ...existing,
      workspace_id: workspaceId,
      agent_id: agent.id,
      skill_id: skillId,
      skill_version_id: version.id,
      board_id: boardId,
      role_slug: roleSlug,
      assigned_by: actorId,
    }));
  }

  async propose(workspaceId: string, body: any, source: { agentId?: string; runId?: string }) {
    if (body.skill_id) await this.requireSkill(workspaceId, String(body.skill_id));
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    return this.proposals.save(this.proposals.create({
      workspace_id: workspaceId,
      skill_id: String(body.skill_id || ''),
      title: String(body.title || 'Skill proposal').slice(0, 200),
      body: canonical.body,
      support_files: canonical.supportFiles,
      digest: canonical.digest,
      status: 'pending',
      source_agent_id: source.agentId || '',
      source_run_id: source.runId || '',
    }));
  }

  async review(
    workspaceId: string,
    proposalId: string,
    decision: 'approve' | 'reject',
    actorId: string,
    note = '',
    targetSkillId = '',
  ) {
    const proposal = await this.proposals.findOne({ where: { id: proposalId, workspace_id: workspaceId } });
    if (!proposal) throw httpError(404, 'skill_proposal_not_found', 'Skill proposal not found');
    if (proposal.status !== 'pending') {
      throw httpError(409, 'skill_proposal_closed', 'Skill proposal has already been reviewed');
    }
    let version: SkillVersion | null = null;
    if (decision === 'approve') {
      if (!proposal.skill_id && targetSkillId) {
        await this.requireSkill(workspaceId, targetSkillId);
        proposal.skill_id = targetSkillId;
      }
      if (!proposal.skill_id) throw httpError(400, 'skill_target_required', 'Approval requires a target skill');
      version = await this.publish(workspaceId, proposal.skill_id, proposal, actorId, proposal.id);
    }
    proposal.status = decision === 'approve' ? 'approved' : 'rejected';
    proposal.reviewed_by = actorId;
    proposal.review_note = String(note).slice(0, 2000);
    proposal.reviewed_at = new Date();
    await this.proposals.save(proposal);
    return { proposal, version };
  }

  async quarantine(workspaceId: string, skillId: string) {
    const skill = await this.requireSkill(workspaceId, skillId);
    skill.status = 'quarantined';
    return this.skills.save(skill);
  }

  private async requireSkill(workspaceId: string, skillId: string) {
    const skill = await this.skills.findOne({ where: { id: skillId, workspace_id: workspaceId } });
    if (!skill) throw httpError(404, 'skill_not_found', 'Skill not found');
    return skill;
  }
}
