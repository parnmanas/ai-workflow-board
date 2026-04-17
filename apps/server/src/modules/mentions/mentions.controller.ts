import { Controller, Get, Post, Param, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { MentionsService } from './mentions.service';

/**
 * Unread @-mention inbox for the web UI. All endpoints are scoped by
 * `currentUser.id` — even if a caller supplies a workspace they don't belong
 * to, they only see their own unread rows, and every row's user_id is set
 * at dispatch time (tickets.controller / room-messaging.service).
 */
@Controller('api')
@UseGuards(AuthGuard)
export class MentionsController {
  constructor(private readonly mentionsService: MentionsService) {}

  @Get('workspaces/:wsId/mentions/unread')
  async listUnread(@Param('wsId') wsId: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const [items, count] = await Promise.all([
      this.mentionsService.listUnread(wsId, currentUser.id),
      this.mentionsService.countUnread(wsId, currentUser.id),
    ]);
    return res.json({ count, items });
  }

  @Post('workspaces/:wsId/mentions/read-all')
  async markAllRead(@Param('wsId') wsId: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const updated = await this.mentionsService.markAllRead(wsId, currentUser.id);
    return res.json({ updated });
  }

  @Post('mentions/:id/read')
  async markRead(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });

    const row = await this.mentionsService.markRead(id, currentUser.id);
    if (!row) return res.status(404).json({ error: 'Mention not found' });
    return res.json(row);
  }
}
