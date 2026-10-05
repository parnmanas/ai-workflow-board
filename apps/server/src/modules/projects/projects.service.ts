import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In } from 'typeorm';
import { Project } from '../../entities/Project';
import { ProjectHostFolder } from '../../entities/ProjectHostFolder';
import { Credential } from '../../entities/Credential';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { Ticket } from '../../entities/Ticket';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { parseClonePolicy, serializeClonePolicy, validateClonePolicyInput } from '../../common/clone-policy';
import { normalizeRuntimeSpec, parseRuntimeSpec, RuntimeSpecError, type RuntimeSpec } from '../../common/runtime-spec';
import { isAbsoluteHostPath } from '../../common/orchestration-member-spec';

/** Thrown for caller mistakes; `status` is the HTTP status the REST layer returns. */
export class ProjectInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'invalid_project') {
    super(message);
    this.name = 'ProjectInputError';
  }
}

export interface ProjectHostFolderView {
  host_id: string;
  host_name: string;
  path: string;
}

export interface ProjectView {
  id: string;
  account_id: string;
  name: string;
  description: string;
  repo_url: string;
  default_branch: string;
  credential_id: string | null;
  clone_policy: ReturnType<typeof parseClonePolicy>;
  use_pr: boolean;
  instructions: string;
  default_assignee: RuntimeSpec | null;
  host_folders: ProjectHostFolderView[];
  created_at: Date;
  updated_at: Date;
}

/** Compact form other payloads embed (ticket card, agent_trigger, mission brief). */
export interface ProjectSummary {
  id: string;
  name: string;
  repo_url: string;
  default_branch: string;
}

type Scope = DataSource | EntityManager;

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

/**
 * Projects (docs/tickets.md) — repositories plus their main clone folder per
 * Runtime Host. Every feature that needs "which repo, and where is it on this
 * machine" asks this service instead of reading the tables itself.
 */
@Injectable()
export class ProjectsService {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async list(accountId: string): Promise<ProjectView[]> {
    const projects = await this.dataSource.getRepository(Project).find({
      where: { account_id: accountId },
      order: { name: 'ASC' },
    });
    return this.views(projects);
  }

  async get(id: string): Promise<Project | null> {
    if (!id) return null;
    return this.dataSource.getRepository(Project).findOne({ where: { id } });
  }

  /** The project when it exists AND belongs to the workspace — the only lookup write paths may use. */
  async getInWorkspace(id: string, accountId: string, scope: Scope = this.dataSource): Promise<Project | null> {
    if (!id || !accountId) return null;
    const project = await scope.getRepository(Project).findOne({ where: { id } });
    return project && project.account_id === accountId ? project : null;
  }

  async view(project: Project): Promise<ProjectView> {
    return (await this.views([project]))[0];
  }

  async views(projects: Project[]): Promise<ProjectView[]> {
    if (projects.length === 0) return [];
    const folders = await this.dataSource.getRepository(ProjectHostFolder).find({
      where: { project_id: In(projects.map((p) => p.id)) },
    });
    const hostIds = [...new Set(folders.map((f) => f.host_id))];
    const hosts = hostIds.length
      ? await this.dataSource.getRepository(RuntimeHost).find({ where: { id: In(hostIds) } })
      : [];
    const hostName = new Map(hosts.map((h) => [h.id, h.name]));
    return projects.map((p) => ({
      id: p.id,
      account_id: p.account_id,
      name: p.name,
      description: p.description,
      repo_url: p.repo_url,
      default_branch: p.default_branch,
      credential_id: p.credential_id,
      clone_policy: parseClonePolicy(p.clone_policy),
      use_pr: !!p.use_pr,
      instructions: p.instructions || '',
      default_assignee: parseRuntimeSpec(p.default_assignee),
      host_folders: folders
        .filter((f) => f.project_id === p.id)
        .map((f) => ({ host_id: f.host_id, host_name: hostName.get(f.host_id) || '', path: f.path }))
        .sort((a, b) => a.host_name.localeCompare(b.host_name)),
      created_at: p.created_at,
      updated_at: p.updated_at,
    }));
  }

  summary(project: Project | null | undefined): ProjectSummary | null {
    if (!project) return null;
    return { id: project.id, name: project.name, repo_url: project.repo_url, default_branch: project.default_branch };
  }

  async create(accountId: string, body: any): Promise<ProjectView> {
    if (!accountId) throw new ProjectInputError('account_id is required');
    const repo = this.dataSource.getRepository(Project);
    const entity = repo.create({
      account_id: accountId,
      name: '',
      description: '',
      repo_url: '',
      default_branch: '',
      credential_id: null,
      clone_policy: null,
      use_pr: false,
      instructions: '',
      default_assignee: null,
    });
    await this.applyFields(entity, body, true);
    const saved = await repo.save(entity);
    return this.view(saved);
  }

  async update(id: string, accountId: string, body: any): Promise<ProjectView> {
    const project = await this.getInWorkspace(id, accountId);
    if (!project) throw new ProjectInputError('Project not found', 404, 'project_not_found');
    await this.applyFields(project, body, false);
    const saved = await this.dataSource.getRepository(Project).save(project);
    return this.view(saved);
  }

  private async applyFields(project: Project, body: any, creating: boolean): Promise<void> {
    body = body || {};
    if (creating || body.name !== undefined) {
      const name = str(body.name);
      if (!name) throw new ProjectInputError('name is required');
      project.name = name.slice(0, 200);
    }
    if (body.description !== undefined) project.description = str(body.description);
    if (body.repo_url !== undefined) project.repo_url = str(body.repo_url);
    if (body.default_branch !== undefined) project.default_branch = str(body.default_branch);
    if (body.use_pr !== undefined) project.use_pr = body.use_pr === true || body.use_pr === 'true';
    if (body.instructions !== undefined) project.instructions = body.instructions == null ? '' : String(body.instructions);
    if (body.credential_id !== undefined) {
      const credentialId = str(body.credential_id) || null;
      if (credentialId) await this.assertCredentialVisible(credentialId, project.account_id);
      project.credential_id = credentialId;
    }
    if (body.clone_policy !== undefined) {
      if (body.clone_policy === null) {
        project.clone_policy = null;
      } else {
        const checked = validateClonePolicyInput(body.clone_policy);
        if (!checked.ok) throw new ProjectInputError(checked.error);
        project.clone_policy = serializeClonePolicy(checked.value);
      }
    }
    if (body.default_assignee !== undefined) {
      if (body.default_assignee === null) {
        project.default_assignee = null;
      } else {
        try {
          project.default_assignee = normalizeRuntimeSpec(body.default_assignee, 'default_assignee') as any;
        } catch (e) {
          if (e instanceof RuntimeSpecError) throw new ProjectInputError(e.message);
          throw e;
        }
      }
    }
  }

  private async assertCredentialVisible(credentialId: string, accountId: string): Promise<void> {
    const credential = await this.dataSource.getRepository(Credential).findOne({ where: { id: credentialId } });
    if (!credential) throw new ProjectInputError('credential not found');
    if (credential.account_id !== null && credential.account_id !== accountId) {
      throw new ProjectInputError('credential is not available in this workspace');
    }
  }

  /** How many things still point at the project — DELETE refuses unless forced. */
  async usage(id: string): Promise<{ tickets: number; references: number }> {
    const tickets = await this.dataSource.getRepository(Ticket).count({ where: { project_id: id } });
    const needle = `%"project_id":"${id}"%`;
    let references = 0;
    for (const [table, column] of [
      ['qa_scenarios', 'repo_ref'], ['security_profiles', 'repo_ref'],
      ['actions', 'repo_ref'], ['orchestration_missions', 'repo_ref'],
    ] as const) {
      const row = await this.dataSource.createQueryBuilder()
        .select('COUNT(*)', 'n')
        .from(table, 't')
        .where(`t.${column} LIKE :needle`, { needle })
        .getRawOne();
      references += Number(row?.n ?? 0);
    }
    references += await this.dataSource.getRepository(OutreachChannel).count({ where: { target_project_id: id } });
    return { tickets, references };
  }

  async remove(id: string, accountId: string, force: boolean): Promise<void> {
    const project = await this.getInWorkspace(id, accountId);
    if (!project) throw new ProjectInputError('Project not found', 404, 'project_not_found');
    if (!force) {
      const usage = await this.usage(id);
      if (usage.tickets + usage.references > 0) {
        throw Object.assign(
          new ProjectInputError(
            `Project is still used by ${usage.tickets} ticket(s) and ${usage.references} QA/Security/Action/Mission/outreach setting(s)`,
            409,
            'project_in_use',
          ),
          { usage },
        );
      }
    }
    await this.dataSource.transaction(async (manager) => {
      await manager.getRepository(ProjectHostFolder).delete({ project_id: id });
      await manager.getRepository(Ticket).update({ project_id: id }, { project_id: null });
      await manager.getRepository(OutreachChannel).update({ target_project_id: id }, { target_project_id: null });
      await manager.getRepository(Project).delete({ id });
    });
  }

  async setHostFolder(id: string, accountId: string, hostId: string, rawPath: unknown): Promise<ProjectView> {
    const project = await this.getInWorkspace(id, accountId);
    if (!project) throw new ProjectInputError('Project not found', 404, 'project_not_found');
    const path = str(rawPath);
    if (!path) throw new ProjectInputError('path is required');
    if (!isAbsoluteHostPath(path)) throw new ProjectInputError(`path must be an absolute path on the host (got "${path}")`);
    const host = await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: hostId } });
    if (!host) throw new ProjectInputError('Runtime Host not found', 404, 'host_not_found');
    const repo = this.dataSource.getRepository(ProjectHostFolder);
    const existing = await repo.findOne({ where: { project_id: id, host_id: hostId } });
    if (existing) {
      existing.path = path;
      await repo.save(existing);
    } else {
      await repo.save(repo.create({ project_id: id, host_id: hostId, path }));
    }
    return this.view(project);
  }

  async clearHostFolder(id: string, accountId: string, hostId: string): Promise<ProjectView> {
    const project = await this.getInWorkspace(id, accountId);
    if (!project) throw new ProjectInputError('Project not found', 404, 'project_not_found');
    await this.dataSource.getRepository(ProjectHostFolder).delete({ project_id: id, host_id: hostId });
    return this.view(project);
  }

  /** The project's main clone folder on a host, or null when the host has none. */
  async hostFolder(projectId: string, hostId: string, scope: Scope = this.dataSource): Promise<string | null> {
    if (!projectId || !hostId) return null;
    const row = await scope.getRepository(ProjectHostFolder).findOne({ where: { project_id: projectId, host_id: hostId } });
    return row?.path || null;
  }

  /** All host folders of a project, keyed by host id. */
  async hostFolders(projectId: string, scope: Scope = this.dataSource): Promise<Map<string, string>> {
    if (!projectId) return new Map();
    const rows = await scope.getRepository(ProjectHostFolder).find({ where: { project_id: projectId } });
    return new Map(rows.map((r) => [r.host_id, r.path]));
  }
}
