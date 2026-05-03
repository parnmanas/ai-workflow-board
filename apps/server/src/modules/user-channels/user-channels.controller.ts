import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Body, Controller, Delete, Get, Param, Patch, Post, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { UserChannelsService } from './user-channels.service';

/**
 * Per-user notification channel bindings (discord / slack / telegram).
 *
 * Self-service surface mounted under `/api/me/channels` — every operation is
 * scoped to the authenticated `currentUser.id`. The `/api/admin/users/:userId/channels`
 * sibling is admin-only and read-only, for support / debugging.
 */
@ApiBearerAuth('user-session')
@ApiTags('user-channels')
@Controller('api')
export class UserChannelsController {
  constructor(private readonly service: UserChannelsService) {}

  // ─── Self-service: /api/me/channels ─────────────────────────────────

  @Get('me/channels/providers')
  @UseGuards(AuthGuard)
  async listProviders(@Res() res: Response) {
    return res.json(this.service.listSupportedProviders());
  }

  @Get('me/channels')
  @UseGuards(AuthGuard)
  async listMine(@Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const items = await this.service.listPublic(currentUser.id);
    return res.json(items);
  }

  @Post('me/channels')
  @UseGuards(AuthGuard)
  async createMine(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    try {
      const created = await this.service.create(currentUser.id, body || {});
      return res.status(201).json(created);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message || 'Failed to create channel' });
    }
  }

  @Patch('me/channels/:id')
  @UseGuards(AuthGuard)
  async updateMine(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    try {
      const updated = await this.service.update(currentUser.id, id, body || {});
      return res.json(updated);
    } catch (err: any) {
      return res.status(err.status || 400).json({ error: err.message || 'Failed to update channel' });
    }
  }

  @Delete('me/channels/:id')
  @UseGuards(AuthGuard)
  async deleteMine(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    try {
      await this.service.delete(currentUser.id, id);
      return res.json({ success: true });
    } catch (err: any) {
      return res.status(err.status || 404).json({ error: err.message || 'Failed to delete channel' });
    }
  }

  @Post('me/channels/:id/test')
  @UseGuards(AuthGuard)
  async testMine(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    try {
      const result = await this.service.test(currentUser.id, id);
      return res.json(result);
    } catch (err: any) {
      return res.status(err.status || 404).json({ error: err.message || 'Failed to test channel' });
    }
  }

  // ─── Admin: /api/admin/users/:userId/channels (read-only) ───────────

  @Get('admin/users/:userId/channels')
  @UseGuards(AuthGuard, AdminGuard)
  async listForUser(@Param('userId') userId: string, @Res() res: Response) {
    const items = await this.service.listPublic(userId);
    return res.json(items);
  }
}
