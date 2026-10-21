import { normalizeRuntimeSpec, runtimeIdentityKey } from '../../common/runtime-spec';
import { Project } from '../../entities/Project';
import { ACCOUNT_TARGET_KEY, parseAssignmentTarget, projectTargetKey } from './skill-assignment-target';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { In, IsNull, Repository, DataSource } from 'typeorm';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import { agentIsVisibleInAccount } from '../../common/agent-account-scope';
import { RuntimeSkillAssignment } from '../../entities/RuntimeSkillAssignment';
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
    @InjectRepository(RuntimeSkillAssignment) private readonly assignments: Repository<RuntimeSkillAssignment>,
    @InjectRepository(SkillProposal) private readonly proposals: Repository<SkillProposal>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  /**
   * Skills usable from `accountId`: this account's rows PLUS every global
   * row (docs/catalog-scopes.md — "조회는 Account context 하나뿐이다: Global +
   * 현재 Account 행을 반환한다").
   *
   * By default a account skill SHADOWS a global one carrying the same slug,
   * matching how WorkflowFunction resolves by key. The management UI passes
   * `includeShadowed` to render both rows so an operator can see what their
   * fork is overriding — without it a shadowed global is invisible and
   * "why is the built-in not updating" becomes unanswerable.
   */
  async list(accountId: string, opts: { includeShadowed?: boolean } = {}) {
    const rows = await this.skills.find({
      where: visibleScopeWhere<Skill>(accountId),
      // Account rows first so shadowBySlug's "first of a scope wins" tie-break
      // never depends on insertion order.
      order: { name: 'ASC' },
    });
    const decorated = rows
      .map((skill) => ({ ...skill, scope: skillScopeOf(skill) }))
      .sort((a, b) =>
        (a.account_id ? 0 : 1) - (b.account_id ? 0 : 1)
        || a.name.localeCompare(b.name));
    if (opts.includeShadowed) {
      const shadowedSlugs = new Set(
        decorated.filter((s) => s.account_id).map((s) => s.slug),
      );
      return decorated.map((s) => ({
        ...s,
        shadowed: !s.account_id && shadowedSlugs.has(s.slug),
      }));
    }
    return shadowBySlug(decorated).map((s) => ({ ...s, shadowed: false }));
  }

  /** Global skills only — the admin registry view, account-independent. */
  async listGlobal() {
    const rows = await this.skills.find({ where: { account_id: IsNull() }, order: { name: 'ASC' } });
    return rows.map((skill) => ({ ...skill, scope: 'global' as const }));
  }

  listProposals(accountId: string, status?: 'pending' | 'approved' | 'rejected') {
    return this.proposals.find({
      where: {
        account_id: accountId,
        ...(status ? { status } : {}),
      },
      order: { created_at: 'DESC' },
      take: 250,
    });
  }

  async get(accountId: string, skillId: string) {
    const skill = await this.requireSkill(accountId, skillId);
    // Filter by skill_id alone: a version's scope always mirrors its parent's,
    // and re-asserting `account_id: accountId` here would return an EMPTY
    // version list for a global skill viewed from a account.
    const versions = await this.versions.find({
      where: { skill_id: skillId },
      order: { version: 'DESC' },
    });
    return { ...skill, scope: skillScopeOf(skill), versions };
  }

  /**
   * `scope` selects where the new skill lands: 'account' (default when a
   * accountId is present) or 'global'. Global writes are admin-gated at the
   * controller — docs/catalog-scopes.md §"새 관리 객체 체크리스트" step 3.
   */
  async create(accountId: string, body: any, actorId: string, scope?: SkillScope) {
    const slug = String(body.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) {
      throw httpError(400, 'skill_slug_invalid', 'Skill slug is invalid');
    }
    const target = resolveSkillScope({ scope, account_id: accountId });
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    return this.skills.manager.transaction(async (manager) => {
      const skillRepo = manager.getRepository(Skill);
      const versionRepo = manager.getRepository(SkillVersion);
      // Scope-exact duplicate check. A account MAY reuse a global slug —
      // that is the documented fork/shadow path, not a conflict — so this
      // deliberately does not look across scopes.
      const dup = await skillRepo.findOne({
        where: { account_id: target.account_id ?? IsNull(), slug } as any,
      });
      if (dup) throw httpError(409, 'skill_slug_duplicate', 'Skill slug already exists in this scope');
      const skill = await skillRepo.save(skillRepo.create({
        account_id: target.account_id,
        slug,
        name: String(body.name || slug).trim(),
        description: String(body.description || ''),
        status: 'active',
        source_kind: 'local',
      }));
      const version = await versionRepo.save(versionRepo.create({
        account_id: target.account_id,
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
   * Fork a global skill into `accountId`, seeded from one of its versions.
   * The fork shadows the global by slug from then on, and the global keeps
   * receiving upstream updates untouched — which is the whole point of
   * shadowing over in-place edits.
   */
  async fork(accountId: string, skillId: string, actorId: string, sourceVersionId = '') {
    if (!accountId) throw httpError(400, 'account_required', 'Forking requires a account');
    const global = await this.skills.findOne({ where: { id: skillId, account_id: IsNull() } });
    if (!global) throw httpError(404, 'skill_not_found', 'Global skill not found');
    const source = sourceVersionId
      ? await this.versions.findOne({ where: { id: sourceVersionId, skill_id: skillId } })
      : await this.versions.findOne({ where: { skill_id: skillId }, order: { version: 'DESC' } });
    if (!source) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    return this.create(
      accountId,
      {
        slug: global.slug,
        name: global.name,
        description: global.description,
        body: source.body,
        support_files: source.support_files,
      },
      actorId,
      'account',
    );
  }

  async publish(accountId: string, skillId: string, body: any, actorId: string, sourceProposalId = '') {
    // Writable, not merely visible: a account may READ a global skill but may
    // not publish into it (that would let one tenant edit every tenant's
    // definition). Global publishes come through the admin route, which passes
    // accountId=''.
    const skill = await this.requireWritableSkill(accountId, skillId);
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    if (await this.versions.findOne({ where: { skill_id: skillId, digest: canonical.digest } })) {
      throw httpError(409, 'skill_version_duplicate', 'Identical immutable version already exists');
    }
    // Scope-free max-version lookup: versions of a global skill carry
    // account_id NULL, so filtering by the caller's account would restart
    // numbering at 1 and collide on the (skill_id, version) unique index.
    const latest = await this.versions.findOne({
      where: { skill_id: skillId },
      order: { version: 'DESC' },
    });
    return this.versions.save(this.versions.create({
      account_id: skill.account_id,
      skill_id: skillId,
      version: (latest?.version ?? 0) + 1,
      body: canonical.body,
      support_files: canonical.supportFiles,
      digest: canonical.digest,
      created_by: actorId,
      source_proposal_id: sourceProposalId,
    }));
  }

  /**
   * 버전 하나를 대상에 핀한다(docs/skills.md "배정 범위"). 대상은 `body.target`:
   *   `{ scope: 'account' }` · `{ scope: 'project', project_id }` · `{ scope: 'runtime', runtime }`.
   * `target` 없이 `runtime` 만 오면 예전 호출(실행 범위)로 읽는다. 같은 대상에 다시 배정하면 버전만 바뀐다.
   */
  async assign(accountId: string, skillId: string, body: any, actorId: string) {
    // Visible is enough here — assigning a GLOBAL skill to a account agent is
    // the primary way a built-in gets used. The assignment row itself stays
    // account-scoped (it owns execution, not a definition).
    await this.requireSkill(accountId, skillId);
    const version = await this.versions.findOne({
      where: { id: String(body.skill_version_id), skill_id: skillId },
    });
    if (!version) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    const target = body.target && typeof body.target === 'object' ? body.target : { scope: 'runtime', runtime: body.runtime };
    let runtimeKey: string;
    let targetLabel = '';
    if (target.scope === 'account') {
      runtimeKey = ACCOUNT_TARGET_KEY;
    } else if (target.scope === 'project') {
      const projectId = typeof target.project_id === 'string' ? target.project_id : '';
      const project = projectId
        ? await this.dataSource.getRepository(Project).findOne({ where: { id: projectId, account_id: accountId } })
        : null;
      if (!project) throw httpError(404, 'project_not_found', 'Project not found in this account');
      runtimeKey = projectTargetKey(project.id);
    } else if (target.scope === 'runtime') {
      let spec;
      try { spec = normalizeRuntimeSpec(target.runtime, 'runtime'); }
      catch (error) { throw httpError(400, 'invalid_runtime', (error as Error).message); }
      const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: spec.manager_agent_id } });
      if (!host) throw httpError(404, 'host_not_found', 'Runtime Host not found');
      runtimeKey = runtimeIdentityKey(spec);
      targetLabel = `${host.name || host.id.slice(0, 8)}/${spec.label || spec.cli}`.slice(0, 200);
    } else {
      throw httpError(400, 'invalid_target', 'target.scope must be account, project or runtime');
    }
    // One assignment per (account, target, skill) — re-assigning re-pins the version in place.
    const existing = await this.assignments.findOne({
      where: {
        account_id: accountId,
        runtime_key: runtimeKey,
        skill_id: skillId,
      },
    });
    return this.assignments.save(this.assignments.create({
      ...existing,
      account_id: accountId,
      runtime_key: runtimeKey,
      skill_id: skillId,
      skill_version_id: version.id,
      assigned_by: actorId,
      target_label: targetLabel || existing?.target_label || '',
    }));
  }

  /** 이 계정의 배정 전부 — 범위·대상·skill·핀된 버전을 사람이 읽을 수 있게. */
  async listAssignments(accountId: string) {
    const rows = await this.assignments.find({ where: { account_id: accountId }, order: { created_at: 'ASC' } });
    const skillIds = Array.from(new Set(rows.map((r) => r.skill_id)));
    const versionIds = Array.from(new Set(rows.map((r) => r.skill_version_id)));
    const skills = skillIds.length ? await this.skills.find({ where: { id: In(skillIds) } }) : [];
    const versions = versionIds.length ? await this.versions.find({ where: { id: In(versionIds) }, select: ['id', 'version', 'skill_id'] }) : [];
    const latest = skillIds.length
      ? await this.versions.find({ where: { skill_id: In(skillIds) }, select: ['id', 'version', 'skill_id'], order: { version: 'DESC' } })
      : [];
    const latestBySkill = new Map<string, number>();
    for (const v of latest) if (!latestBySkill.has(v.skill_id)) latestBySkill.set(v.skill_id, v.version);
    const projectIds = rows.map((r) => parseAssignmentTarget(r.runtime_key).project_id).filter((id): id is string => !!id);
    const projects = projectIds.length
      ? await this.dataSource.getRepository(Project).find({ where: { id: In(projectIds) }, select: ['id', 'name'] })
      : [];
    const skillById = new Map(skills.map((s) => [s.id, s]));
    const versionById = new Map(versions.map((v) => [v.id, v]));
    const projectName = new Map(projects.map((p) => [p.id, p.name]));
    return rows.map((row) => {
      const target = parseAssignmentTarget(row.runtime_key);
      const skill = skillById.get(row.skill_id);
      return {
        id: row.id,
        scope: target.scope,
        project_id: target.project_id,
        project_name: target.project_id ? projectName.get(target.project_id) ?? null : null,
        runtime_key: target.runtime_key,
        target_label: row.target_label || '',
        skill_id: row.skill_id,
        skill_slug: skill?.slug ?? '',
        skill_name: skill?.name ?? '',
        skill_status: skill?.status ?? 'missing',
        skill_version_id: row.skill_version_id,
        version: versionById.get(row.skill_version_id)?.version ?? null,
        latest_version: latestBySkill.get(row.skill_id) ?? null,
        assigned_by: row.assigned_by,
        created_at: row.created_at,
      };
    });
  }

  /** 같은 대상에 다른 버전을 핀한다(대상은 그대로). 실행 범위 배정은 spec 없이도 버전만 바꿀 수 있다. */
  async repin(accountId: string, assignmentId: string, versionId: unknown, actorId: string) {
    const row = await this.assignments.findOne({ where: { id: assignmentId, account_id: accountId } });
    if (!row) throw httpError(404, 'assignment_not_found', 'Assignment not found');
    const version = await this.versions.findOne({ where: { id: String(versionId || ''), skill_id: row.skill_id } });
    if (!version) throw httpError(404, 'skill_version_not_found', 'Skill version not found');
    row.skill_version_id = version.id;
    row.assigned_by = actorId;
    return this.assignments.save(row);
  }

  /** 배정 해제. 이미 고정된 런 스냅샷에는 영향이 없다(그 런은 그대로 끝난다). */
  async unassign(accountId: string, assignmentId: string) {
    const row = await this.assignments.findOne({ where: { id: assignmentId, account_id: accountId } });
    if (!row) throw httpError(404, 'assignment_not_found', 'Assignment not found');
    await this.assignments.delete({ id: row.id });
    return { deleted: true };
  }

  async propose(accountId: string, body: any, source: { agentId?: string; runId?: string }) {
    if (body.skill_id) await this.requireSkill(accountId, String(body.skill_id));
    const canonical = canonicalizeSkillContent(body.body, body.support_files);
    return this.proposals.save(this.proposals.create({
      account_id: accountId,
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
    accountId: string,
    proposalId: string,
    decision: 'approve' | 'reject',
    actorId: string,
    note = '',
    targetSkillId = '',
  ) {
    const proposal = await this.proposals.findOne({ where: { id: proposalId, account_id: accountId } });
    if (!proposal) throw httpError(404, 'skill_proposal_not_found', 'Skill proposal not found');
    if (proposal.status !== 'pending') {
      throw httpError(409, 'skill_proposal_closed', 'Skill proposal has already been reviewed');
    }
    let version: SkillVersion | null = null;
    if (decision === 'approve') {
      if (!proposal.skill_id && targetSkillId) {
        await this.requireSkill(accountId, targetSkillId);
        proposal.skill_id = targetSkillId;
      }
      if (!proposal.skill_id) throw httpError(400, 'skill_target_required', 'Approval requires a target skill');
      // A proposal is authored inside a account, so approving it can only
      // publish into that account. Targeting a global skill is refused here
      // with an actionable message rather than surfacing publish()'s generic
      // scope error: the operator's real option is to fork the global skill
      // into this account and re-target the proposal at the fork.
      await this.requireWritableSkill(accountId, proposal.skill_id);
      version = await this.publish(accountId, proposal.skill_id, proposal, actorId, proposal.id);
    }
    proposal.status = decision === 'approve' ? 'approved' : 'rejected';
    proposal.reviewed_by = actorId;
    proposal.review_note = String(note).slice(0, 2000);
    proposal.reviewed_at = new Date();
    await this.proposals.save(proposal);
    return { proposal, version };
  }

  async quarantine(accountId: string, skillId: string) {
    const skill = await this.requireWritableSkill(accountId, skillId);
    skill.status = 'quarantined';
    return this.skills.save(skill);
  }

  /** Readable from `accountId`: the account's own rows plus every global row. */
  private async requireSkill(accountId: string, skillId: string) {
    const skill = await this.skills.findOne({
      where: visibleScopeWhere<Skill>(accountId, { id: skillId }),
    });
    if (!skill) throw httpError(404, 'skill_not_found', 'Skill not found');
    return skill;
  }

  /**
   * Writable from `accountId`. A caller scoped to a account can only mutate
   * that account's skills; global skills are mutable only by an admin caller,
   * which reaches this with an empty accountId. Without this split a member
   * of any single account could republish or quarantine a definition every
   * other account depends on.
   */
  private async requireWritableSkill(accountId: string, skillId: string) {
    const skill = await this.skills.findOne({ where: { id: skillId } });
    if (!skill) throw httpError(404, 'skill_not_found', 'Skill not found');
    if (accountId) {
      if (skill.account_id !== accountId) {
        throw httpError(
          403,
          'skill_scope_readonly',
          skill.account_id
            ? 'Skill belongs to another account'
            : 'Global skills are read-only from a account — fork it into this account instead',
        );
      }
    } else if (skill.account_id) {
      throw httpError(403, 'skill_scope_readonly', 'Not a global skill');
    }
    return skill;
  }
}
