import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Body, Controller, Get, Post, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { AuthGuard } from '../../common/guards/auth.guard';
import { MentionsService } from './mentions.service';

/**
 * Unread @-mention inbox for the web UI. All endpoints are scoped by
 * `currentUser.id` — even if a caller supplies a workspace they don't belong
 * to, they only see their own unread rows, and every row's user_id is set
 * at dispatch time (tickets.controller / room-messaging.service).
 */
@ApiBearerAuth('user-session')
@ApiTags('mentions')
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

  // Viewport-based clearing (see MentionsService.listUnreadBySource): the
  // client asks which mentions are pending inside ONE ticket / room, watches
  // the matching rows with an IntersectionObserver, and reports back the ones
  // that were actually on screen. Exactly one of ticket_id / room_id.
  //
  // NOTE: must be declared BEFORE `mentions/:id/read` is irrelevant (different
  // verb + path), but it IS declared before nothing that could shadow it —
  // 'unread-by-source' is a GET on its own literal path.
  @Get('mentions/unread-by-source')
  async listUnreadBySource(
    @Query('ticket_id') ticketId: string | undefined,
    @Query('room_id') roomId: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    if (!ticketId && !roomId) {
      return res.status(400).json({ error: 'ticket_id or room_id is required' });
    }
    const items = await this.mentionsService.listUnreadBySource(currentUser.id, {
      ticketId: ticketId || undefined,
      roomId: roomId || undefined,
    });
    return res.json({ items });
  }

  // Batch mark-read. The viewport reader flushes everything that became
  // visible together, so a screenful with several mentions costs one request.
  @Post('mentions/read-batch')
  async markManyRead(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    const currentUser = (req as any).currentUser;
    if (!currentUser) return res.status(401).json({ error: 'Authentication required' });
    const ids = Array.isArray(body?.ids) ? body.ids : null;
    if (!ids) return res.status(400).json({ error: 'ids must be an array' });
    // Bounded so a malformed/hostile caller can't hand us an unbounded IN list.
    if (ids.length > 200) return res.status(400).json({ error: 'ids may contain at most 200 entries' });
    const updated = await this.mentionsService.markManyRead(ids, currentUser.id);
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
