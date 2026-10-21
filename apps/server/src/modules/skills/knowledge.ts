/**
 * Knowledge — 공용 메모리 + 범위별 skill(docs/skills.md "Knowledge").
 *
 * 한 실행이 알아야 할 것은 세 겹이다: 계정 공용 메모리(`Account.knowledge_memory`), 프로젝트 메모리
 * (`Project.instructions`), 그리고 공용·프로젝트·실행 범위로 배정된 skill. 티켓 디스패치(런 스냅샷으로
 * 고정), 미션 step 지시문, MCP `get_knowledge`/`get_skill` 이 모두 여기 함수로 같은 답을 낸다 — 경로마다
 * 따로 계산하지 말 것.
 *
 * DataSource 만 있으면 된다(DI 없이) — 오케스트레이션 러너처럼 생성자를 늘리기 어려운 소비자도 쓸 수 있게.
 */

import { DataSource, In, Repository } from 'typeorm';
import { Account } from '../../entities/Account';
import { Project } from '../../entities/Project';
import { RuntimeSkillAssignment } from '../../entities/RuntimeSkillAssignment';
import { Skill } from '../../entities/Skill';
import { SkillVersion } from '../../entities/SkillVersion';
import type { KnowledgeBlock, KnowledgeSkillLine } from '../../common/ticket-work-order';
import { pickNarrowest, targetKeysFor, type SkillAssignmentScope } from './skill-assignment-target';

export interface ManifestEntry {
  skill_id: string;
  skill_version_id: string;
  slug: string;
  version: number;
  digest: string;
  body: string;
  support_files: Array<{ path: string; content: string }>;
  scope?: SkillAssignmentScope;
  name?: string;
  description?: string;
}

export interface KnowledgeRepos {
  assignments: Repository<RuntimeSkillAssignment>;
  versions: Repository<SkillVersion>;
  skills: Repository<Skill>;
}

export function knowledgeRepos(dataSource: DataSource): KnowledgeRepos {
  return {
    assignments: dataSource.getRepository(RuntimeSkillAssignment),
    versions: dataSource.getRepository(SkillVersion),
    skills: dataSource.getRepository(Skill),
  };
}

/**
 * 이 실행에 해당하는 배정(공용 + 프로젝트 + 실행)을 skill 마다 가장 좁은 범위 하나로 풀어 핀된 버전의
 * manifest 를 만든다. 격리된(quarantined) skill 은 뺀다. 정렬은 slug → digest(런 스냅샷 digest 가 이 순서에 걸려 있다).
 */
export async function skillManifestFor(
  repos: KnowledgeRepos,
  args: { accountId: string; runtimeKey?: string | null; projectId?: string | null },
): Promise<ManifestEntry[]> {
  const assignments = pickNarrowest(await repos.assignments.find({
    where: { account_id: args.accountId, runtime_key: In(targetKeysFor({ runtimeKey: args.runtimeKey, projectId: args.projectId })) },
  }));
  const scopeByVersion = new Map(assignments.map((a) => [a.skill_version_id, a.scope]));
  const versionIds = assignments.map((assignment) => assignment.skill_version_id);
  // Scope-free lookup by id. The assignment row is already account-scoped
  // and its skill_version_id was validated at assign time, so re-filtering by
  // account here adds no authorization — it only DROPS global skills
  // (account_id NULL) out of the manifest, which silently ships a run
  // without the built-in skills the operator assigned to that agent.
  const versions = versionIds.length ? await repos.versions.find({ where: { id: In(versionIds) } }) : [];
  const skills = versions.length
    ? await repos.skills.find({ where: { id: In(versions.map((version) => version.skill_id)) } })
    : [];
  const skillById = new Map(skills.filter((skill) => skill.status === 'active').map((skill) => [skill.id, skill]));
  return versions
    .filter((version) => skillById.has(version.skill_id))
    .map((version) => {
      const skill = skillById.get(version.skill_id)!;
      return {
        skill_id: version.skill_id,
        skill_version_id: version.id,
        slug: skill.slug,
        version: version.version,
        digest: version.digest,
        body: version.body,
        support_files: version.support_files,
        scope: scopeByVersion.get(version.id) ?? 'runtime',
        name: skill.name || skill.slug,
        description: skill.description || '',
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.digest.localeCompare(b.digest));
}

/** 목차 — 이름·설명·버전·범위만(본문 없이). */
export function skillIndex(manifest: readonly ManifestEntry[]): KnowledgeSkillLine[] {
  return manifest.map((entry) => ({
    slug: entry.slug,
    name: entry.name || entry.slug,
    description: entry.description || '',
    version: entry.version,
    scope: entry.scope ?? 'runtime',
  }));
}

/** 공용 메모리 + 이 실행의 skill 목차. 미션 step 지시문과 MCP 가 쓴다. */
export async function knowledgeBlockFor(
  dataSource: DataSource,
  args: { accountId: string; runtimeKey?: string | null; projectId?: string | null },
): Promise<KnowledgeBlock> {
  const account = await dataSource.getRepository(Account).findOne({ where: { id: args.accountId }, select: ['id', 'knowledge_memory'] });
  const manifest = await skillManifestFor(knowledgeRepos(dataSource), args);
  return { shared_memory: account?.knowledge_memory || '', skills: skillIndex(manifest) };
}

/** 프로젝트 메모리(Project.instructions) — 그 계정의 프로젝트일 때만. */
export async function projectMemoryFor(dataSource: DataSource, accountId: string, projectId: string | null | undefined): Promise<{ id: string; name: string; instructions: string } | null> {
  if (!projectId) return null;
  const project = await dataSource.getRepository(Project).findOne({ where: { id: projectId, account_id: accountId }, select: ['id', 'name', 'instructions'] });
  return project ? { id: project.id, name: project.name, instructions: project.instructions || '' } : null;
}
