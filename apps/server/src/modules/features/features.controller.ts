import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { Response, Request } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { FeaturesService, FeatureRollup } from './features.service';
import { Feature } from '../../entities/Feature';

/**
 * Normalize a Feature row for the client: coalesce the nullable simple-json
 * columns to null/[] so the UI has a stable shape. Mirrors featureToJson in the
 * MCP feature-tools.
 */
export function featureToJson(f: Feature, rollup?: FeatureRollup) {
  return {
    id: f.id,
    workspace_id: f.workspace_id,
    board_id: f.board_id,
    title: f.title,
    requirement: f.requirement,
    status: f.status,
    planner_agent_id: f.planner_agent_id,
    proposal: f.proposal ?? null,
    generated_ticket_ids: f.generated_ticket_ids ?? [],
    planning_room_id: f.planning_room_id,
    feedback: f.feedback,
    source_chat_room_id: f.source_chat_room_id,
    created_by: f.created_by,
    created_at: f.created_at,
    updated_at: f.updated_at,
    ...(rollup ? { rollup } : {}),
  };
}

/**
 * REST surface for the Feature/Epic intake pipeline (ticket aae7644c).
 *
 * The human/UI-facing surface: intake + approval/rejection + progress rollup.
 * The planner's structured-proposal submission is agent-driven via the MCP tool
 * `propose_feature_chain`, so it is intentionally NOT exposed over REST. Reuses
 * MANAGE_ACTIONS permission (same automation-authoring audience as Actions/QA).
 */
@ApiBearerAuth('user-session')
@ApiTags('features')
@Controller('api/features')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_ACTIONS)
export class FeaturesController {
  constructor(private readonly featuresService: FeaturesService) {}

  @Get()
  async list(
    @Query('workspace_id') workspaceId: string,
    @Query('board_id') boardId: string | undefined,
    @Res() res: Response,
  ) {
    if (!workspaceId) return res.status(400).json({ error: 'workspace_id query parameter is required' });
    const rows = await this.featuresService.list(workspaceId, boardId);
    return res.json(rows.map((r) => featureToJson(r)));
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      const feature = await this.featuresService.get(id);
      const rollup = await this.featuresService.rollup(feature);
      // rollup may flip status → done; re-read is cheap and keeps the payload fresh.
      const fresh = await this.featuresService.get(id);
      return res.json(featureToJson(fresh, rollup));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Feature not found' });
    }
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id: string; name?: string } | undefined;
      const feature = await this.featuresService.create({
        workspace_id: body.workspace_id,
        board_id: body.board_id ?? null,
        title: body.title,
        requirement: body.requirement,
        planner_agent_id: body.planner_agent_id,
        source_chat_room_id: body.source_chat_room_id,
        created_by: user?.name || 'User',
        // A user has no agent id; planning must target an explicit planner agent.
        created_by_id: undefined,
        auto_plan: body.auto_plan,
      });
      const rollup = await this.featuresService.rollup(feature);
      return res.status(201).json(featureToJson(feature, rollup));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create feature' });
    }
  }

  @Post(':id/approve')
  async approve(@Param('id') id: string, @Res() res: Response) {
    try {
      const { feature } = await this.featuresService.approve(id);
      const rollup = await this.featuresService.rollup(feature);
      return res.json(featureToJson(feature, rollup));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to approve feature' });
    }
  }

  @Post(':id/reject')
  async reject(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      const feature = await this.featuresService.reject(id, body?.feedback || '', {
        replan: body?.replan,
      });
      return res.json(featureToJson(feature));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to reject feature' });
    }
  }

  @Post(':id/replan')
  async replan(@Param('id') id: string, @Res() res: Response) {
    try {
      await this.featuresService.dispatchPlanning(id);
      const feature = await this.featuresService.get(id);
      return res.json(featureToJson(feature));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to dispatch planning' });
    }
  }
}
