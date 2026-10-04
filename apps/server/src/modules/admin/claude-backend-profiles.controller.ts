import { Body, Controller, Delete, Get, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { Response } from 'express';
import { DataSource } from 'typeorm';
import { AdminGuard } from '../../common/guards/admin.guard';
import { AuthGuard } from '../../common/guards/auth.guard';
import { validateCliRuntimeProfiles } from '../../common/cli-runtime-profiles';
import {
  profileEntityToRuntime, publicProfile, runtimeToProfileEntity,
} from '../../common/claude-backend-registry';
import { ClaudeBackendProfile } from '../../entities/ClaudeBackendProfile';
import { Credential } from '../../entities/Credential';
import { SystemSetting } from '../../entities/SystemSetting';

const DEFAULT_KEY = 'claude_backend_profiles.default';

@Controller('api/admin/claude-backend-profiles')
@UseGuards(AdminGuard)
export class ClaudeBackendProfilesController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  private async defaultId() {
    return (await this.dataSource.getRepository(SystemSetting).findOne({ where: { key: DEFAULT_KEY } }))?.value || null;
  }

  // 프로필은 인스턴스 전역이므로(티켓 e616dbfc) 워크스페이스 배정·기본값을
  // 조회하던 3개 쿼리는 사라졌다. Board / Ticket 의 프로필 핀은 보드 제거와
  // 함께 없어졌고(docs/tickets.md — 티켓 실행 설정은 assignee RuntimeSpec 이
  // 갖는다), Agent 핀은 P4c-4 에서 사라졌다. 남은 참조자는 전역 기본값뿐이다.
  private async impact(id: string) {
    const defaultId = await this.defaultId();
    return { global_default: defaultId === id };
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
    const referenced = impact.global_default;
    const replacement = body?.replacement_profile_id ? String(body.replacement_profile_id) : null;
    const detach = body?.detach === true;
    if (referenced && !replacement && !detach) return res.status(409).json({ error: 'Profile is referenced', impact });
    if (replacement && replacement === id) return res.status(400).json({ error: 'replacement must differ from deleted profile' });
    if (replacement && !(await repo.findOne({ where: { id: replacement } }))) {
      return res.status(400).json({ error: 'replacement_profile_id does not exist' });
    }
    await this.dataSource.transaction(async manager => {
      const next = replacement || null; // detach means inherit
      if (impact.global_default) {
        await manager.update(SystemSetting, { key: DEFAULT_KEY }, { value: next || '' });
      }
      await manager.delete(ClaudeBackendProfile, { id });
    });
    return res.json({ deleted: true, replacement_profile_id: replacement });
  }
}

/**
 * 비관리자도 읽을 수 있는 전역 프로필 카탈로그 (티켓 e616dbfc).
 *
 * 프로필 핀 드롭다운(에이전트 / 세션 설정 / ManagedAgentDialog)이 목록을
 * 채우던 워크스페이스 엔드포인트를 대체한다. 위의 관리자 컨트롤러는 같은
 * 목록을 주지만 `AdminGuard` 라서, 그대로 갈아끼우면 비관리자에게는 드롭다운이
 * 통째로 빈 목록이 된다 — 그래서 읽기 전용 표면을 따로 둔다. 쓰기(생성 /
 * 수정 / 삭제 / 기본값 지정)는 계속 `api/admin/claude-backend-profiles` 에만
 * 있다. 응답은 반드시 `publicProfile()` 을 거쳐 `credential_ref` 를 떨어뜨리고
 * `credential_status` 만 노출한다 — 자격증명 값 자체는 `Credential` 에만 둔다.
 */
@Controller('api/claude-backend-profiles')
@UseGuards(AuthGuard)
export class ClaudeBackendProfileCatalogController {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  @Get()
  async list() {
    const [rows, defaultSetting] = await Promise.all([
      this.dataSource.getRepository(ClaudeBackendProfile).find({ order: { name: 'ASC' } }),
      this.dataSource.getRepository(SystemSetting).findOne({ where: { key: DEFAULT_KEY } }),
    ]);
    return {
      profiles: rows.map(publicProfile),
      default_profile_id: defaultSetting?.value || null,
    };
  }
}
