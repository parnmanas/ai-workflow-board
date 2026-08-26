import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { AdminGuard } from '../../common/guards/admin.guard';
import { validateCliRuntimeProfiles } from '../../common/cli-runtime-profiles';
import {
  profileEntityToRuntime, publicProfile, runtimeToProfileEntity,
} from '../../common/claude-backend-registry';
import { Agent } from '../../entities/Agent';
import { Board } from '../../entities/Board';
import { ClaudeBackendProfile } from '../../entities/ClaudeBackendProfile';
import { Credential } from '../../entities/Credential';
import { SystemSetting } from '../../entities/SystemSetting';
import { Workspace } from '../../entities/Workspace';
import { WorkspaceClaudeBackendProfile } from '../../entities/WorkspaceClaudeBackendProfile';
import { Ticket } from '../../entities/Ticket';

const DEFAULT_KEY = 'claude_backend_profiles.default';

@Controller('api/admin/claude-backend-profiles')
@UseGuards(AdminGuard)
export class ClaudeBackendProfilesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async defaultId() {
    return (await this.dataSource.getRepository(SystemSetting).findOne({ where: { key: DEFAULT_KEY } }))?.value || null;
  }

  private async impact(id: string) {
    const [links, workspaces, legacyWorkspaces, boards, agents, runs, defaultId] = await Promise.all([
      this.dataSource.getRepository(WorkspaceClaudeBackendProfile).find({ where: { profile_id: id } }),
      this.dataSource.getRepository(Workspace).find({ where: { default_claude_backend_profile_id: id } }),
      this.dataSource.getRepository(Workspace).find({ where: { default_cli_runtime_profile: id } }),
      this.dataSource.getRepository(Board).find({ where: { cli_runtime_profile: id } }),
      this.dataSource.getRepository(Agent).find({ where: { cli_runtime_profile: id } }),
      this.dataSource.getRepository(Ticket).find({ where: { cli_runtime_profile: id } }),
      this.defaultId(),
    ]);
    return {
      global_default: defaultId === id,
      workspaces: Array.from(new Set([
        ...links.map(x => x.workspace_id),
        ...workspaces.map(x => x.id),
        ...legacyWorkspaces.map(x => x.id),
        ...boards.map(x => x.workspace_id).filter(Boolean),
        ...agents.map(x => x.workspace_id).filter((value): value is string => Boolean(value)),
        ...runs.map(x => x.workspace_id).filter(Boolean),
      ])),
      boards: boards.map(x => ({ id: x.id, name: x.name, workspace_id: x.workspace_id })),
      agents: agents.map(x => ({ id: x.id, name: x.name, workspace_id: x.workspace_id })),
      runs: runs.map(x => ({ id: x.id, title: x.title, workspace_id: x.workspace_id })),
    };
  }

  @Get()
  async list() {
    const [rows, default_profile_id] = await Promise.all([
      this.dataSource.getRepository(ClaudeBackendProfile).find({ order: { name: 'ASC' } }),
      this.defaultId(),
    ]);
    return {
      profiles: rows.map(publicProfile),
      default_profile_id,
    };
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    const name = String(body?.name || '').trim();
    const { name: _name, ...profileInput } = body || {};
    const checked = validateCliRuntimeProfiles([profileInput]);
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const runtime = checked.value[0];
    if (runtime.credential_ref && !(await this.dataSource.getRepository(Credential).findOne({ where: { id: runtime.credential_ref } }))) {
      return res.status(400).json({ error: 'credential_ref does not exist' });
    }
    try {
      const saved = await this.dataSource.getRepository(ClaudeBackendProfile).save(
        this.dataSource.getRepository(ClaudeBackendProfile).create(runtimeToProfileEntity(runtime, name)),
      );
      return res.status(201).json(publicProfile(saved));
    } catch (error) {
      return res.status(409).json({ error: `profile id/name already exists: ${(error as Error).message}` });
    }
  }

  @Patch('default')
  async setDefault(@Body() body: any, @Res() res: Response) {
    const id = body?.profile_id == null ? '' : String(body.profile_id);
    if (id && id !== 'none' && !(await this.dataSource.getRepository(ClaudeBackendProfile).findOne({ where: { id } }))) {
      return res.status(400).json({ error: 'profile_id does not exist' });
    }
    const repo = this.dataSource.getRepository(SystemSetting);
    await repo.save(repo.create({ key: DEFAULT_KEY, value: id, description: 'Instance default Claude backend profile', is_secret: 0 }));
    return res.json({ default_profile_id: id || null });
  }

  @Get(':id/impact')
  async getImpact(@Param('id') id: string) {
    return this.impact(id);
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const repo = this.dataSource.getRepository(ClaudeBackendProfile);
    const current = await repo.findOne({ where: { id } });
    if (!current) return res.status(404).json({ error: 'Profile not found' });
    // 목록 응답을 그대로 수정 요청에 사용하는 클라이언트도 안전하게 허용하되,
    // 영속화 가능한 런타임 필드만 strict 스키마에 전달한다.
    const { name: _name, credential_status: _credentialStatus, impact: _impact, ...profilePatch } = body || {};
    const merged = { ...profileEntityToRuntime(current), ...profilePatch, id };
    // null은 PATCH에서 선택 해제를 뜻하며 런타임 계약에는 값 자체를 생략한다.
    if (profilePatch.credential_ref === null) delete merged.credential_ref;
    const checked = validateCliRuntimeProfiles([merged]);
    const name = String(body?.name ?? current.name).trim();
    if (!name) return res.status(400).json({ error: 'name is required' });
    if (!checked.ok) return res.status(400).json({ error: checked.error });
    const runtime = checked.value[0];
    if (runtime.credential_ref && !(await this.dataSource.getRepository(Credential).findOne({ where: { id: runtime.credential_ref } }))) {
      return res.status(400).json({ error: 'credential_ref does not exist' });
    }
    Object.assign(current, runtimeToProfileEntity(runtime, name));
    try {
      const saved = await repo.save(current);
      return res.json({ ...publicProfile(saved), impact: await this.impact(id) });
    } catch (error) {
      return res.status(409).json({ error: `profile name already exists: ${(error as Error).message}` });
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const repo = this.dataSource.getRepository(ClaudeBackendProfile);
    if (!(await repo.findOne({ where: { id } }))) return res.status(404).json({ error: 'Profile not found' });
    const impact = await this.impact(id);
    const referenced = impact.global_default || impact.workspaces.length || impact.boards.length || impact.agents.length || impact.runs.length;
    const replacement = body?.replacement_profile_id ? String(body.replacement_profile_id) : null;
    const detach = body?.detach === true;
    if (referenced && !replacement && !detach) return res.status(409).json({ error: 'Profile is referenced', impact });
    if (replacement && replacement === id) return res.status(400).json({ error: 'replacement must differ from deleted profile' });
    if (replacement && !(await repo.findOne({ where: { id: replacement } }))) {
      return res.status(400).json({ error: 'replacement_profile_id does not exist' });
    }
    await this.dataSource.transaction(async manager => {
      const next = replacement || null; // detach means inherit
      const affectedDefaultWorkspaces = await manager.getRepository(Workspace).find({
        where: [
          { default_claude_backend_profile_id: id },
          { default_cli_runtime_profile: id },
        ],
      });
      for (const workspace of affectedDefaultWorkspaces) {
        // The new selector is authoritative when it already points elsewhere.
        // Otherwise replace/detach the deleted selector and converge the
        // one-release legacy mirror to the same final value.
        const finalDefault = workspace.default_claude_backend_profile_id
          && workspace.default_claude_backend_profile_id !== id
          ? workspace.default_claude_backend_profile_id
          : next;
        await manager.update(Workspace, { id: workspace.id }, {
          default_claude_backend_profile_id: finalDefault,
          default_cli_runtime_profile: finalDefault,
        });
      }
      await manager.update(Board, { cli_runtime_profile: id }, { cli_runtime_profile: next });
      await manager.update(Agent, { cli_runtime_profile: id }, { cli_runtime_profile: next });
      await manager.update(Ticket, { cli_runtime_profile: id }, { cli_runtime_profile: next });
      await manager.delete(WorkspaceClaudeBackendProfile, { profile_id: id });
      if (replacement) {
        for (const workspaceId of impact.workspaces) {
          await manager.upsert(WorkspaceClaudeBackendProfile, { workspace_id: workspaceId, profile_id: replacement }, ['workspace_id', 'profile_id']);
        }
      }
      if (impact.global_default) {
        await manager.update(SystemSetting, { key: DEFAULT_KEY }, { value: next || '' });
      }
      await manager.delete(ClaudeBackendProfile, { id });
    });
    return res.json({ deleted: true, replacement_profile_id: replacement });
  }
}
