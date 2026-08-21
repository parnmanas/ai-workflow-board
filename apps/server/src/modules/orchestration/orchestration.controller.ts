/**
 * REST surface for Orchestration mode — the human half of the feature.
 *
 * Split of responsibility with the MCP tool surface (orchestration-tools.ts):
 *   - Humans (this controller) author teams and missions, start/pause/cancel a
 *     mission, nudge a wedged orchestrator, and read everything.
 *   - Agents (MCP) author the plan, dispatch/report step work, and finish the
 *     mission.
 * Nothing here lets a human hand-assign or hand-complete a step: the plan is
 * the orchestrator's to own, and letting the UI mutate it mid-flight would put
 * the mission state machine and the orchestrator's model of it out of sync
 * with no channel to reconcile them. Operators intervene through `nudge`
 * (talk to the orchestrator) or `cancel` (end it).
 *
 * Permission: reuses MANAGE_ACTIONS, the same automation-authoring audience as
 * Actions / QA scenarios / Security profiles — orchestration is the same class
 * of capability (defining machine work that runs against the workspace), so it
 * gets the same gate rather than a new permission nobody's role grants yet.
 */

import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { OrchestrationTeamService } from './orchestration-team.service';
import { OrchestrationMissionService } from './orchestration-mission.service';
import { OrchestrationRunnerService, ActorRef } from './orchestration-runner.service';
import { OrchestrationReaperService } from './orchestration-reaper.service';

function actorOf(req: Request): ActorRef {
  const user = (req as any).currentUser as { id?: string; name?: string } | undefined;
  return { type: 'user', id: user?.id || '', name: user?.name || '' };
}

function fail(res: Response, e: any, fallback: string) {
  return res.status(e?.status || 400).json({ error: e?.message || fallback });
}

@ApiBearerAuth('user-session')
@ApiTags('orchestration')
@Controller('api/orchestration')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_ACTIONS)
export class OrchestrationController {
  constructor(
    private readonly teams: OrchestrationTeamService,
    private readonly missions: OrchestrationMissionService,
    private readonly runner: OrchestrationRunnerService,
    private readonly reaper: OrchestrationReaperService,
  ) {}

  // ── Teams ─────────────────────────────────────────────────────────────────

  @Get('teams')
  async listTeams(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.teams.listTeams(workspaceId));
    } catch (e: any) {
      return fail(res, e, 'Failed to list teams');
    }
  }

  @Get('teams/:id')
  async getTeam(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.teams.getTeam(id, workspaceId));
    } catch (e: any) {
      return fail(res, e, 'Team not found');
    }
  }

  @Post('teams')
  async createTeam(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id?: string } | undefined;
      const team = await this.teams.createTeam({ ...body, created_by: body?.created_by || user?.id || '' });
      return res.status(201).json(team);
    } catch (e: any) {
      return fail(res, e, 'Failed to create team');
    }
  }

  @Patch('teams/:id')
  async updateTeam(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      return res.json(await this.teams.updateTeam(id, body?.workspace_id, body));
    } catch (e: any) {
      return fail(res, e, 'Failed to update team');
    }
  }

  @Delete('teams/:id')
  async deleteTeam(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.teams.deleteTeam(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return fail(res, e, 'Failed to delete team');
    }
  }

  @Post('teams/:id/members')
  async addMember(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      return res.status(201).json(await this.teams.addMember(id, body?.workspace_id, body));
    } catch (e: any) {
      return fail(res, e, 'Failed to add member');
    }
  }

  @Patch('teams/:id/members/:memberId')
  async updateMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      return res.json(await this.teams.updateMember(id, body?.workspace_id, memberId, body));
    } catch (e: any) {
      return fail(res, e, 'Failed to update member');
    }
  }

  @Delete('teams/:id/members/:memberId')
  async removeMember(
    @Param('id') id: string,
    @Param('memberId') memberId: string,
    @Query('workspace_id') workspaceId: string,
    @Res() res: Response,
  ) {
    try {
      return res.json(await this.teams.removeMember(id, workspaceId, memberId));
    } catch (e: any) {
      return fail(res, e, 'Failed to remove member');
    }
  }

  /** Agents the UI may offer as orchestrator / member for this workspace. */
  @Get('assignable-agents')
  async assignableAgents(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      const agents = await this.teams.listAssignableAgents(workspaceId);
      // The service already carries manager_name so the picker can render the
      // canonical `<Manager>/<Agent>` identity — pass the rows through as-is.
      return res.json(agents);
    } catch (e: any) {
      return fail(res, e, 'Failed to list agents');
    }
  }

  // ── Missions ──────────────────────────────────────────────────────────────

  @Get('missions')
  async listMissions(
    @Query('workspace_id') workspaceId: string,
    @Query('team_id') teamId: string,
    @Query('status') status: string,
    @Query('limit') limit: string,
    @Res() res: Response,
  ) {
    try {
      return res.json(
        await this.missions.listMissions(workspaceId, {
          teamId: teamId || undefined,
          status: status || undefined,
          limit: limit ? Number(limit) : undefined,
        }),
      );
    } catch (e: any) {
      return fail(res, e, 'Failed to list missions');
    }
  }

  @Get('missions/:id')
  async getMission(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.missions.getMissionDetail(id, workspaceId));
    } catch (e: any) {
      return fail(res, e, 'Mission not found');
    }
  }

  @Post('missions')
  async createMission(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser as { id?: string } | undefined;
      const mission = await this.missions.createMission({
        ...body,
        created_by_type: 'user',
        created_by: user?.id || '',
      });
      // `start: true` is the common case from the UI — create and immediately
      // brief the orchestrator. Kept as one round trip so a create that succeeds
      // and a start that fails can be reported together.
      if (body?.start) {
        try {
          await this.runner.startMission(mission.id, mission.workspace_id, actorOf(req));
        } catch (e: any) {
          return res.status(201).json({
            ...(await this.missions.getMissionDetail(mission.id, mission.workspace_id)),
            start_error: e?.message || 'failed to start mission',
          });
        }
      }
      return res.status(201).json(await this.missions.getMissionDetail(mission.id, mission.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to create mission');
    }
  }

  @Patch('missions/:id')
  async updateMission(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      await this.missions.updateMission(id, body?.workspace_id, body);
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to update mission');
    }
  }

  @Delete('missions/:id')
  async deleteMission(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.missions.deleteMission(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return fail(res, e, 'Failed to delete mission');
    }
  }

  @Post('missions/:id/start')
  async startMission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      await this.runner.startMission(id, body?.workspace_id, actorOf(req));
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to start mission');
    }
  }

  @Post('missions/:id/pause')
  async pauseMission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      await this.runner.pauseMission(id, body?.workspace_id, actorOf(req));
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to pause mission');
    }
  }

  @Post('missions/:id/resume')
  async resumeMission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      await this.runner.resumeMission(id, body?.workspace_id, actorOf(req));
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to resume mission');
    }
  }

  @Post('missions/:id/cancel')
  async cancelMission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      await this.runner.cancelMission(id, body?.workspace_id, actorOf(req), body?.reason || '');
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to cancel mission');
    }
  }

  /** Post an operator note into the mission room and wake the orchestrator. */
  @Post('missions/:id/nudge')
  async nudgeMission(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      await this.runner.nudgeOrchestrator(id, body?.workspace_id, actorOf(req), body?.note || '');
      return res.json(await this.missions.getMissionDetail(id, body?.workspace_id));
    } catch (e: any) {
      return fail(res, e, 'Failed to nudge orchestrator');
    }
  }

  /** On-demand reaper sweep — the operator escape hatch for a wedged mission. */
  @Post('reap')
  async reap(@Res() res: Response) {
    return res.json(await this.reaper.runOnce());
  }
}
