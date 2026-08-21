import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { Agent } from '../../entities/Agent';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';
import { AgentSkillAssignment } from '../../entities/AgentSkillAssignment';
import { Skill } from '../../entities/Skill';
import { SkillProposal } from '../../entities/SkillProposal';
import { SkillVersion } from '../../entities/SkillVersion';
import { canonicalizeSkillContent } from './skill-validation';
import { resolveSkillScope, shadowBySlug, skillScopeOf, visibleScopeWhere, type SkillScope } from './skill-scope';

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

  /**
   * Skills usable from `workspaceId`: this workspace's rows PLUS every global
   * row (docs/catalog-scopes.md — "조회는 Workspace context 하나뿐이다: Global +
   * 현재 Workspace 행을 반환한다").
   *
   * By default a workspace skill SHADOWS a global one carrying the same slug,
   * matching how WorkflowFunction resolves by key. The management UI passes
   * `includeShadowed` to render both rows so an operator can see what their
   * fork is overriding — without it a shadowed global is invisible and
   * "why is the built-in not updating" becomes unanswerable.
   */
  async list(workspaceId: string, opts: { includeShadowed?: boolean } = {}) {
    const rows = await this.skills.find({
      where: visibleScopeWhere<Skill>(workspaceId),
      // Workspace rows first so shadowBySlug's "first of a scope wins" tie-break
      // never depends on insertion order.
      order: { name: 'ASC' },
    });
    const decorated = rows
      .map((skill) => ({ ...skill, scope: skillScopeOf(skill) }))
      .sort((a, b) =>
        (a.workspace_id ? 0 : 1) - (b.workspace_id ? 0 : 1)
        || a.name.localeCompare(b.name));
    if (opts.includeShadowed) {
      const shadowedSlugs = new Set(
        decorated.filter((s) => s.workspace_id).map((s) => s.slug),
      );
      return decorated.map((s) => ({
        ...s,
        shadowed: !s.workspace_id && shadowedSlugs.has(s.slug),
      }));
    }
    return shadowBySlug(decorated).map((s) => ({ ...s, shadowed: false }));
  }

  /** Global skills only — the admin registry view, workspace-independent. */
  async listGlobal() {
    const rows = await this.skills.find({ where: { workspace_id: IsNull() }, order: { name: 'ASC' } });
    return rows.map((skill) => ({ ...skill, scope: 'global' as const }));
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
    // Filter by skill_id alone: a version's scope always mirrors its parent's,
    // and re-asserting `workspace_id: workspaceId` here would return an EMPTY
    // version list for a global skill viewed from a workspace.
    const versions = await this.versions.find({
      where: { skill_id: skillId },
      order: { version: 'DESC' },
    });
    return { ...skill, scope: skillScopeOf(skill), versions };
  }

  /**
   * `scope` selects where the new skill lands: 'workspace' (default when a
   * workspaceId is present) or 'global'. Global writes are admin-gated at the
   * controller — docs/catalog-scopes.md §"새 관리 객체 체크리스트" step 3.
   */
  async create(workspaceId: string, body: any, actorId: string, scope?: SkillScope) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'skill_slug_invalid', 'Skill slug is invalid');
    }
    const target = resolveSkillScope({ scope, workspace_id: workspaceId });
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    return this.skills.manager.transaction(async (manager) => {
      const skillRepo = manager.getRepository(Skill);
      const versionRepo = manager.getRepository(SkillVersion);
      // Scope-exact duplicate check. A workspace MAY reuse a global slug —
      // that is the documented fork/shadow path, not a conflict — so this
      // deliberately does not look across scopes.
      const dup = await skillRepo.findOne({
        where: { workspace_id: target.workspace_id ?? IsNull(), slug } as any,
      });
      if (dup) throw httpError(409, 'skill_slug_duplicate', 'Skill slug already exists in this scope');
      const skill = await skillRepo.save(skillRepo.create({
        workspace_id: target.workspace_id,
        slug,
        name: String(body.name || slug).trim(),
        description: String(body.description || ''),
        status: 'active',
        source_kind: 'local',
      }));
      const version = await versionRepo.save(versionRepo.create({
        workspace_id: target.workspace_id,
        skill_id: skill.id,
        version: 1,
        body: canonical.body,
        support_files: canonical.supportFiles,
        digest: canonical.digest,
        created_by: actorId,
      }));
      return { ...skill, scope: skillScopeOf(skill), version };
    });
  }

  /**
   * Fork a global skill into `workspaceId`, seeded from one of its versions.
   * The fork shadows the global by slug from then on, and the global keeps
   * receiving upstream updates untouched — which is the whole point of
   * shadowing over in-place edits.
   */
  async fork(workspaceId: string, skillId: string, actorId: string, sourceVersionId = '') {
    if (!workspaceId) throw httpError(400, 'workspace_required', 'Forking requires a workspace');
    const global = await this.skills.findOne({ where: { id: skillId, workspace_id: IsNull() } });
    if (!global) throw httpError(404, 'skill_not_found', 'Global skill not found');
    const source = sourceVersionId
      ? await this.versions.findOne({ where: { id: sourceVersionId, skill_id: skillId } })
      : await this.versions.findOne({ where: { skill_id: skillId }, order: { version: 'DESC' } });
    if (!source) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    return this.create(
      workspaceId,
      {
        slug: global.slug,
        name: global.name,
        description: global.description,
        body: source.body,
        support_files: source.support_files,
      },
      actorId,
      'workspace',
    );
  }

  async publish(workspaceId: string, skillId: string, body: any, actorId: string, sourceProposalId = '') {
    // Writable, not merely visible: a workspace may READ a global skill but may
    // not publish into it (that would let one tenant edit every tenant's
    // definition). Global publishes come through the admin route, which passes
    // workspaceId=''.
    const skill = await this.requireWritableSkill(workspaceId, skillId);
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    if (await this.versions.findOne({ where: { skill_id: skillId, digest: canonical.digest } })) {
      throw httpError(409, 'skill_version_duplicate', 'Identical immutable version already exists');
    }
    // Scope-free max-version lookup: versions of a global skill carry
    // workspace_id NULL, so filtering by the caller's workspace would restart
    // numbering at 1 and collide on the (skill_id, version) unique index.
    const latest = await this.versions.findOne({
      where: { skill_id: skillId },
      order: { version: 'DESC' },
    });
    return this.versions.save(this.versions.create({
      workspace_id: skill.workspace_id,
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
    // Visible is enough here — assigning a GLOBAL skill to a workspace agent is
    // the primary way a built-in gets used. The assignment row itself stays
    // workspace-scoped (it owns execution, not a definition).
    await this.requireSkill(workspaceId, skillId);
    const version = await this.versions.findOne({
      where: { id: String(body.skill_version_id), skill_id: skillId },
    });
    if (!version) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    const agent = await this.agents.findOne({ where: { id: String(body.agent_id) } });
    if (!agent || !agentIsVisibleInWorkspace(agent.workspace_id, workspaceId)) {
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
      // A proposal is authored inside a workspace, so approving it can only
      // publish into that workspace. Targeting a global skill is refused here
      // with an actionable message rather than surfacing publish()'s generic
      // scope error: the operator's real option is to fork the global skill
      // into this workspace and re-target the proposal at the fork.
      await this.requireWritableSkill(workspaceId, proposal.skill_id);
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
    const skill = await this.requireWritableSkill(workspaceId, skillId);
    skill.status = 'quarantined';
    return this.skills.save(skill);
  }

  /** Readable from `workspaceId`: the workspace's own rows plus every global row. */
  private async requireSkill(workspaceId: string, skillId: string) {
    const skill = await this.skills.findOne({
      where: visibleScopeWhere<Skill>(workspaceId, { id: skillId }),
    });
    if (!skill) throw httpError(404, 'skill_not_found', 'Skill not found');
    return skill;
  }

  /**
   * Writable from `workspaceId`. A caller scoped to a workspace can only mutate
   * that workspace's skills; global skills are mutable only by an admin caller,
   * which reaches this with an empty workspaceId. Without this split a member
   * of any single workspace could republish or quarantine a definition every
   * other workspace depends on.
   */
  private async requireWritableSkill(workspaceId: string, skillId: string) {
    const skill = await this.skills.findOne({ where: { id: skillId } });
    if (!skill) throw httpError(404, 'skill_not_found', 'Skill not found');
    if (workspaceId) {
      if (skill.workspace_id !== workspaceId) {
        throw httpError(
          403,
          'skill_scope_readonly',
          skill.workspace_id
            ? 'Skill belongs to another workspace'
            : 'Global skills are read-only from a workspace — fork it into this workspace instead',
        );
      }
    } else if (skill.workspace_id) {
      throw httpError(403, 'skill_scope_readonly', 'Not a global skill');
    }
    return skill;
  }
}
