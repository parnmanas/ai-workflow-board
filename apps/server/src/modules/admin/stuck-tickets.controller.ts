import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Delete, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { AdminGuard } from '../../common/guards/admin.guard';
import { StuckTicketDetectorService } from '../agents/stuck-ticket-detector.service';

/**
 * Admin surface for the stale-WAIT detector (ticket 8e934802).
 *
 * Endpoints:
 *   - GET    /api/admin/stuck-tickets             → current alerts
 *   - POST   /api/admin/stuck-tickets/:id/realert → reset cooldown
 *   - DELETE /api/admin/stuck-tickets/:id         → dismiss alert
 *
 * The detector itself runs as a background sweep — these endpoints are
 * pure observability + manual override hooks. They share the same
 * AdminGuard as the existing /api/admin/settings surface.
 */
@ApiBearerAuth('user-session')
@ApiTags('admin')
@Controller('api/admin/stuck-tickets')
@UseGuards(AdminGuard)
export class StuckTicketsController {
  constructor(private readonly detector: StuckTicketDetectorService) {}

  @Get()
  async list(@Res() res: Response): Promise<Response> {
    const rows = await this.detector.listActiveAlerts();
    return res.json({ alerts: rows });
  }

  @Post(':id/realert')
  async realert(@Param('id') id: string, @Res() res: Response): Promise<Response> {
    if (!id) return res.status(400).json({ error: 'ticket_id is required' });
    const ok = await this.detector.forceRealert(id);
    if (!ok) return res.status(404).json({ error: 'no alert row for this ticket' });
    return res.json({ success: true, ticket_id: id, action: 'realert_queued' });
  }

  @Delete(':id')
  async dismiss(@Param('id') id: string, @Res() res: Response): Promise<Response> {
    if (!id) return res.status(400).json({ error: 'ticket_id is required' });
    const ok = await this.detector.dismissAlert(id);
    if (!ok) return res.status(404).json({ error: 'no alert row for this ticket' });
    return res.json({ success: true, ticket_id: id, action: 'dismissed' });
  }
}
