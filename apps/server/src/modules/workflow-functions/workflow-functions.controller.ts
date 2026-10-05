import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { WorkflowFunctionsService } from './workflow-functions.service';

@ApiBearerAuth('user-session')
@ApiTags('functions')
@Controller('api/functions')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_FUNCTIONS)
export class WorkflowFunctionsController {
  constructor(private readonly functions: WorkflowFunctionsService) {}

  private fail(res: Response, error: any, fallback: string) {
    return res.status(error?.status || 400).json({ error: error?.message || fallback, run_id: error?.run_id });
  }

  private isAdmin(req: Request): boolean {
    return (req as any).currentUser?.role === 'admin';
  }

  @Get()
  async list(
    @Query('account_id') accountId: string | undefined,
    @Query('include_shadowed') shadowed: string,
    @Res() res: Response,
  ) {
    try {
      return res.json(await this.functions.list(accountId || null, shadowed === 'true'));
    } catch (error) {
      return this.fail(res, error, 'Failed to list Functions');
    }
  }

  @Get('runs')
  async listRuns(
    @Query('account_id') accountId: string,
    @Query('function_id') functionId: string | undefined,
    @Query('ticket_id') ticketId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Res() res: Response,
  ) {
    try {
      if (!accountId) return res.status(400).json({ error: 'account_id is required' });
      return res.json(await this.functions.listRuns(accountId, functionId, ticketId, Number(limit || 50)));
    } catch (error) {
      return this.fail(res, error, 'Failed to list Function runs');
    }
  }

  @Get('runs/:runId')
  async getRun(@Param('runId') runId: string, @Query('account_id') accountId: string, @Res() res: Response) {
    try {
      return res.json(await this.functions.getRun(runId, accountId));
    } catch (error) {
      return this.fail(res, error, 'Function run not found');
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Res() res: Response) {
    try {
      return res.json(await this.functions.get(id));
    } catch (error) {
      return this.fail(res, error, 'Function not found');
    }
  }

  @Post()
  async create(@Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      if ((body?.scope === 'global' || !body?.account_id) && !this.isAdmin(req)) {
        return res.status(403).json({ error: 'Only admins can create Global Functions' });
      }
      return res.status(201).json(await this.functions.create(body));
    } catch (error) {
      return this.fail(res, error, 'Failed to create Function');
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const current = await this.functions.get(id);
      if (current.account_id === null && !this.isAdmin(req)) {
        return res.status(403).json({ error: 'Only admins can update Global Functions' });
      }
      return res.json(await this.functions.update(id, body));
    } catch (error) {
      return this.fail(res, error, 'Failed to update Function');
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Req() req: Request, @Res() res: Response) {
    try {
      const current = await this.functions.get(id);
      if (current.account_id === null && !this.isAdmin(req)) {
        return res.status(403).json({ error: 'Only admins can delete Global Functions' });
      }
      await this.functions.remove(id);
      return res.json({ success: true, id });
    } catch (error) {
      return this.fail(res, error, 'Failed to delete Function');
    }
  }

  @Post(':id/run')
  async run(@Param('id') id: string, @Body() body: any, @Req() req: Request, @Res() res: Response) {
    try {
      const user = (req as any).currentUser || {};
      const run = await this.functions.execute({
        functionId: id,
        accountId: body.account_id,
        ticketId: body.ticket_id,
        inputs: body.inputs,
        idempotencyKey: body.idempotency_key,
        actorType: 'user',
        actorId: user.id || '',
        actorName: user.name || '',
        actorRole: user.role || '',
      });
      return res.status(201).json(run);
    } catch (error) {
      return this.fail(res, error, 'Failed to execute Function');
    }
  }
}
