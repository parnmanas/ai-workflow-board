import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { LibraryItem } from '../../entities/LibraryItem';
import { Resource } from '../../entities/Resource';
import { ReBACService } from '../../services/rebac.service';

/**
 * 자료실 — 파일 바이트는 Resource(`type='library_file'`)에, 겉장(제목·버전·종류)은
 * LibraryItem에. 업로드는 기존 `POST /api/resources/upload`(raw 바이트, 10MB JSON
 * 상한 우회)으로 먼저 하고, 여기서 resource_id로 묶는다. 다운로드는 기존
 * `GET /api/resources/:id/raw?download=1` — 새로 만들지 않는다(APK는 /raw가
 * 자동으로 attachment로 내린다).
 *
 * 권한: 읽고·올리고·지우기는 그 워크스페이스의 member/owner(admin 우회) —
 * ResourceMediaController와 같은 경계다. 삭제는 올린 본인 또는 admin만.
 */
@ApiBearerAuth('user-session')
@ApiTags('library')
@Controller('api/library')
@UseGuards(AuthGuard)
export class LibraryController {
  constructor(
    @InjectRepository(LibraryItem) private readonly libraryRepo: Repository<LibraryItem>,
    @InjectRepository(Resource) private readonly resourceRepo: Repository<Resource>,
    private readonly rebacService: ReBACService,
  ) {}

  private currentUser(req: Request): { id: string; role: string } {
    return (req as any).currentUser;
  }

  private async canAccess(user: { id: string; role: string }, accountId: string | null | undefined): Promise<boolean> {
    if (!accountId) return false;
    if (user.role === 'admin') return true;
    const sub = { type: 'user', id: user.id } as const;
    const obj = { type: 'account', id: accountId } as const;
    if (await this.rebacService.check(sub, 'member', obj)) return true;
    return this.rebacService.check(sub, 'owner', obj);
  }

  /** base64 길이를 바이트로 — 목록이 file_data를 디코드하지 않게. */
  static byteSize(base64: string): number {
    if (!base64) return 0;
    const len = base64.length;
    const pad = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    return Math.max(0, Math.floor((len * 3) / 4) - pad);
  }

  private shape(item: LibraryItem, resource: Resource | null) {
    return {
      id: item.id,
      account_id: item.account_id,
      resource_id: item.resource_id,
      title: item.title,
      description: item.description,
      version: item.version,
      kind: item.kind,
      file_name: resource?.file_name || '',
      file_mimetype: resource?.file_mimetype || '',
      size: resource ? LibraryController.byteSize(resource.file_data || '') : 0,
      created_by: item.created_by,
      created_at: item.created_at,
      updated_at: item.updated_at,
    };
  }

  /** 워크스페이스의 자료 목록 — 최신 올린 순. file_data는 절대 내보내지 않는다. */
  @Get()
  async list(@Query('account_id') accountId: string, @Req() req: Request, @Res() res: Response) {
    const user = this.currentUser(req);
    if (!accountId) return res.status(400).json({ error: 'account_id_required', message: 'account_id is required.' });
    if (!(await this.canAccess(user, accountId))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }
    const items = await this.libraryRepo.find({
      where: { account_id: accountId },
      order: { created_at: 'DESC' },
      take: 200,
    });
    if (!items.length) return res.json({ items: [] });
    let resources: Resource[] = [];
    try {
      resources = await this.resourceRepo.find({
        where: items.map((i) => ({ id: i.resource_id })),
      });
    } catch {
      resources = [];
    }
    const byId = new Map(resources.map((r) => [r.id, r]));
    return res.json({ items: items.map((i) => this.shape(i, byId.get(i.resource_id) || null)) });
  }

  /**
   * `{ account_id, resource_id, title, description?, version?, kind? }` — 먼저 올린
   * Resource를 자료로 묶는다. kind는 'app'|'file', 생략하면 .apk면 app이다.
   */
  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const user = this.currentUser(req);
    const accountId = typeof body?.account_id === 'string' ? body.account_id : '';
    const resourceId = typeof body?.resource_id === 'string' ? body.resource_id : '';
    const title = typeof body?.title === 'string' ? body.title.trim().slice(0, 200) : '';
    if (!accountId || !resourceId || !title) {
      return res.status(400).json({ error: 'account_id_resource_id_title_required', message: 'account_id, resource_id and title are required.' });
    }
    if (!(await this.canAccess(user, accountId))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }
    const resource = await this.resourceRepo.findOne({ where: { id: resourceId } });
    if (!resource || !resource.file_data) {
      return res.status(400).json({ error: 'resource_not_found', message: 'No such uploaded file.' });
    }
    if (resource.account_id !== accountId) {
      return res.status(400).json({ error: 'resource_account_mismatch', message: 'The file belongs to another workspace.' });
    }
    const rawKind = typeof body?.kind === 'string' ? body.kind : '';
    const kind = rawKind === 'app' || rawKind === 'file'
      ? rawKind
      : (resource.file_name || '').toLowerCase().endsWith('.apk') ? 'app' : 'file';
    const item = await this.libraryRepo.save(this.libraryRepo.create({
      account_id: accountId,
      resource_id: resource.id,
      title,
      description: typeof body?.description === 'string' ? body.description.slice(0, 2000) : '',
      version: typeof body?.version === 'string' ? body.version.slice(0, 64) : '',
      kind,
      created_by: user.id,
    }));
    return res.status(201).json(this.shape(item, resource));
  }

  /** 설치물의 최신본 하나 — 사이트의 "앱 다운로드" 버튼이 이것만 본다. */
  @Get('apps/latest')
  async latestApp(@Query('account_id') accountId: string, @Req() req: Request, @Res() res: Response) {
    const user = this.currentUser(req);
    if (!accountId) return res.status(400).json({ error: 'account_id_required', message: 'account_id is required.' });
    if (!(await this.canAccess(user, accountId))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }
    const items = await this.libraryRepo.find({
      where: { account_id: accountId, kind: 'app' },
      order: { created_at: 'DESC' },
      take: 1,
    });
    if (!items.length) return res.status(404).json({ error: 'no_app_published', message: 'No app published yet.' });
    const resource = await this.resourceRepo.findOne({ where: { id: items[0].resource_id } });
    return res.json(this.shape(items[0], resource));
  }

  /** 삭제 — 올린 본인 또는 admin. 딸린 Resource(`library_file`)도 함께 거둔다. */
  @Delete(':id')
  async remove(@Param('id') id: string, @Query('account_id') accountId: string, @Req() req: Request, @Res() res: Response) {
    const user = this.currentUser(req);
    if (!accountId) return res.status(400).json({ error: 'account_id_required', message: 'account_id is required.' });
    if (!(await this.canAccess(user, accountId))) {
      return res.status(403).json({ error: 'workspace_access_denied' });
    }
    const item = await this.libraryRepo.findOne({ where: { id, account_id: accountId } });
    if (!item) return res.status(404).json({ error: 'not_found' });
    if (item.created_by !== user.id && user.role !== 'admin') {
      return res.status(403).json({ error: 'only_uploader_or_admin' });
    }
    const resource = await this.resourceRepo.findOne({ where: { id: item.resource_id } });
    await this.libraryRepo.remove(item);
    if (resource && resource.type === 'library_file') {
      await this.resourceRepo.remove(resource).catch(() => undefined);
    }
    return res.json({ success: true, id });
  }
}
