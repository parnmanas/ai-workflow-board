import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { SkillsService } from './skills.service';
import { SkillTapService } from './skill-tap.service';
import { BuiltinSkillPackService } from './builtin-skill-pack.service';

/**
 * Instance-wide skill registry: the GLOBAL skill scope and the git taps that
 * feed it.
 *
 * Separate from SkillsController on purpose. That controller is mounted under
 * `/api/workspaces/:workspaceId/...` and is reachable by anyone with
 * MANAGE_AGENTS in a workspace; global definitions are inherited by EVERY
 * workspace, so mutating them is gated on ADMIN_ACCESS instead — the
 * "Global 쓰기는 admin 권한으로 제한" rule in docs/catalog-scopes.md.
 */
@ApiTags('skills')
@ApiBearerAuth('user-session')
@UseGuards(AuthGuard, PermissionGuard)
@RequirePermission(PERMISSIONS.ADMIN_ACCESS)
@Controller('api/admin/skill-registry')
export class SkillRegistryController {
  constructor(
    private readonly skills: SkillsService,
    private readonly taps: SkillTapService,
    private readonly builtin: BuiltinSkillPackService,
  ) {}

  // ── Global skills ─────────────────────────────────────────────────────────

  @Get('skills')
  async listGlobal(@Res() res: Response) {
    return res.json(await this.skills.listGlobal());
  }

  @Get('skills/:skillId')
  async getGlobal(@Param('skillId') skillId: string, @Res() res: Response) {
    // Empty workspace id = admin/global read context.
    return this.respond(res, () => this.skills.get('', skillId));
  }

  @Post('skills')
  async createGlobal(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.respond(
      res,
      () => this.skills.create('', body, (req as any).currentUser?.id || '', 'global'),
      201,
    );
  }

  @Post('skills/:skillId/versions')
  async publishGlobal(
    @Param('skillId') skillId: string,
    @Body() body: any,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    return this.respond(
      res,
      () => this.skills.publish('', skillId, body, (req as any).currentUser?.id || ''),
      201,
    );
  }

  @Patch('skills/:skillId/quarantine')
  async quarantineGlobal(@Param('skillId') skillId: string, @Res() res: Response) {
    return this.respond(res, () => this.skills.quarantine('', skillId));
  }

  // ── Built-in pack ─────────────────────────────────────────────────────────

  /** Re-run the in-repo pack seeding without restarting. Idempotent. */
  @Post('builtin/reseed')
  async reseed(@Res() res: Response) {
    return this.respond(res, () => this.builtin.seed());
  }

  // ── Taps ──────────────────────────────────────────────────────────────────

  @Get('taps')
  async listTaps(@Res() res: Response) {
    return res.json(await this.taps.list());
  }

  @Post('taps')
  async createTap(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    return this.respond(
      res,
      () => this.taps.create(body, (req as any).currentUser?.id || ''),
      201,
    );
  }

  @Patch('taps/:tapId')
  async updateTap(@Param('tapId') tapId: string, @Body() body: any, @Res() res: Response) {
    return this.respond(res, () => this.taps.update(tapId, body));
  }

  @Delete('taps/:tapId')
  async deleteTap(@Param('tapId') tapId: string, @Res() res: Response) {
    return this.respond(res, () => this.taps.remove(tapId));
  }

  /**
   * Pull one tap now. `dry_run` reports what would change without writing —
   * the preview to run BEFORE enabling a third-party registry, since every
   * skill it carries becomes agent-facing prompt text.
   */
  @Post('taps/:tapId/sync')
  async syncTap(@Param('tapId') tapId: string, @Body() body: any, @Res() res: Response) {
    return this.respond(res, () => this.taps.syncOne(tapId, {
      dryRun: body?.dry_run === true,
      force: body?.force === true,
    }));
  }

  @Post('taps/sync')
  async syncAll(@Res() res: Response) {
    return this.respond(res, () => this.taps.syncAllEnabled());
  }

  private async respond(res: Response, operation: () => Promise<unknown>, status = 200) {
    try {
      return res.status(status).json(await operation());
    } catch (error: any) {
      return res.status(error?.status || 400).json({
        error: error?.code || 'skill_request_invalid',
        message: error?.message || 'Skill registry request failed',
      });
    }
  }
}
