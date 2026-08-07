import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { OutreachChannelService } from './outreach-channel.service';
import { OutreachChannel } from '../../entities/OutreachChannel';

/**
 * Allowlist projection (mirrors resource-helpers.ts's `resourceToJson`) —
 * `credential_id` never reaches the client; `has_credential` is enough for
 * the UI to show "configured" without exposing even the pointer. The
 * decrypted token itself never reaches this layer at all (see
 * outreach-credential.ts) — this projection is belt-and-suspenders on top of
 * that, satisfying the ticket's "자격증명이... API 응답 어디에도 평문 노출되지
 * 않음" completion criterion at the REST boundary specifically.
 */
function channelToJson(c: OutreachChannel) {
  return {
    id: c.id,
    workspace_id: c.workspace_id,
    kind: c.kind,
    name: c.name,
    targets: Array.isArray(c.targets) ? c.targets : [],
    has_credential: !!c.credential_id,
    enabled: c.enabled,
    publish_policy: c.publish_policy,
    rate_limit_per_hour: c.rate_limit_per_hour,
    target_board_id: c.target_board_id,
    poll_interval_ms: c.poll_interval_ms,
    poll_cron: c.poll_cron,
    next_poll_at: c.next_poll_at,
    last_poll_at: c.last_poll_at,
    classify_threshold: c.classify_threshold,
    classifier_agent_id: c.classifier_agent_id,
    deploy_post_mode: c.deploy_post_mode,
    reply_thread_ref: c.reply_thread_ref,
    auto_reuse_window_days: c.auto_reuse_window_days,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

/**
 * REST surface for OutreachChannel (ticket 2500fea3 step 7) — "채널 등록/상태
 * 확인을 위한 최소 REST 엔드포인트" from the ticket's scope. 2500fea3 itself added
 * no MCP tools (Reddit/GitHub polling was fully automatic, no agent consumer
 * yet); ticket 20fa0197's AgentDispatchClassifier is that first consumer, so
 * `record_outreach_classification` lives in mcp/tools/outreach-tools.ts —
 * this REST controller only ever handled channel CRUD/status, unaffected.
 *
 * Gated on MANAGE_RESOURCES — an OutreachChannel is, shape-wise, a workspace
 * catalog item that attaches a Credential exactly like Resource does, so it
 * reuses that permission rather than introducing a new one.
 */
@ApiBearerAuth('user-session')
@ApiTags('outreach-channels')
@Controller('api/outreach-channels')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_RESOURCES)
export class OutreachController {
  constructor(private readonly channelService: OutreachChannelService) {}

  @Get()
  async list(@Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      const rows = await this.channelService.list(workspaceId);
      return res.json(rows.map(channelToJson));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list outreach channels' });
    }
  }

  @Get(':id')
  async get(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(channelToJson(await this.channelService.get(id, workspaceId)));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Outreach channel not found' });
    }
  }

  // Channel status — last/next poll timestamps + a per-status count rollup,
  // the "상태 확인" half of the ticket's minimal REST scope.
  @Get(':id/status')
  async status(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      return res.json(await this.channelService.status(id, workspaceId));
    } catch (e: any) {
      return res.status(e?.status || 404).json({ error: e?.message || 'Outreach channel not found' });
    }
  }

  @Post()
  async create(@Body() body: any, @Res() res: Response) {
    try {
      const row = await this.channelService.create({
        workspaceId: body?.workspace_id,
        kind: body?.kind,
        name: body?.name,
        targets: body?.targets,
        credentialId: body?.credential_id ?? null,
        enabled: body?.enabled,
        publishPolicy: body?.publish_policy,
        rateLimitPerHour: body?.rate_limit_per_hour,
        targetBoardId: body?.target_board_id ?? null,
        pollIntervalMs: body?.poll_interval_ms,
        pollCron: body?.poll_cron ?? null,
        classifyThreshold: body?.classify_threshold,
        classifierAgentId: body?.classifier_agent_id ?? null,
        deployPostMode: body?.deploy_post_mode,
        replyThreadRef: body?.reply_thread_ref ?? null,
        autoReuseWindowDays: body?.auto_reuse_window_days,
      });
      return res.status(201).json(channelToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to create outreach channel' });
    }
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @Res() res: Response) {
    try {
      // NOTE: fields below are passed through as-is (no `?? null` coercion) —
      // an OMITTED key must mean "leave alone", not "clear it". The service
      // distinguishes `undefined` (untouched) from an explicit `null`/''`
      // (clear) via `patch.field !== undefined`.
      const row = await this.channelService.update(id, body?.workspace_id, {
        kind: body?.kind,
        name: body?.name,
        targets: body?.targets,
        credentialId: body?.credential_id,
        enabled: body?.enabled,
        publishPolicy: body?.publish_policy,
        rateLimitPerHour: body?.rate_limit_per_hour,
        targetBoardId: body?.target_board_id,
        pollIntervalMs: body?.poll_interval_ms,
        pollCron: body?.poll_cron,
        classifyThreshold: body?.classify_threshold,
        classifierAgentId: body?.classifier_agent_id,
        deployPostMode: body?.deploy_post_mode,
        replyThreadRef: body?.reply_thread_ref,
        autoReuseWindowDays: body?.auto_reuse_window_days,
      });
      return res.json(channelToJson(row));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to update outreach channel' });
    }
  }

  @Delete(':id')
  async remove(@Param('id') id: string, @Query('workspace_id') workspaceId: string, @Res() res: Response) {
    try {
      await this.channelService.remove(id, workspaceId);
      return res.json({ success: true, id });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to delete outreach channel' });
    }
  }
}
