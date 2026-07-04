import { Controller, Get, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard } from '../../common/guards/auth.guard';
import { HandoffService } from './handoff.service';

/**
 * Cross-board handoff pipeline REST bridge (ticket ac21a745).
 *
 * The client is REST-only (it never speaks MCP), so the read-only pipeline
 * rollup that get_handoff_pipeline exposes over MCP needs a matching HTTP route
 * for the TicketPanel to render the relay across boards. Read-only + AuthGuard
 * (a ticket-scoped read, same posture as the boards read routes).
 */
@ApiBearerAuth('user-session')
@ApiTags('handoff')
@Controller('api')
@UseGuards(AuthGuard)
export class HandoffController {
  constructor(private readonly handoffService: HandoffService) {}

  @Get('tickets/:id/handoff-pipeline')
  async pipeline(@Param('id') id: string, @Res() res: Response) {
    try {
      const pipeline = await this.handoffService.getPipeline(id);
      return res.json(pipeline);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to load handoff pipeline' });
    }
  }
}
