import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { OutreachChannelService } from './outreach-channel.service';
import { OutreachPublisherService } from './outreach-publisher.service';
import { OutreachChannel } from '../../entities/OutreachChannel';
import { OutreachOutboundPost } from '../../entities/OutreachOutboundPost';

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

/** Outbound ledger row projection — no secrets ever land in this table
 *  (see OutreachOutboundPost docstring), so this is a straight field list
 *  rather than a strict allowlist, kept explicit for consistency with
 *  channelToJson and to avoid an unreviewed future column leaking silently. */
function outboundToJson(p: OutreachOutboundPost) {
  return {
    id: p.id,
    workspace_id: p.workspace_id,
    channel_id: p.channel_id,
    kind: p.kind,
    status: p.status,
    target: p.target,
    title: p.title,
    body: p.body,
    thread_ref: p.thread_ref,
    external_item_id: p.external_item_id,
    permalink: p.permalink,
    deployed_commit_sha: p.deployed_commit_sha,
    source_ticket_id: p.source_ticket_id,
    source_item_id: p.source_item_id,
    error: p.error,
    created_at: p.created_at,
    published_at: p.published_at,
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
 * reuses that permission rather than introducing a new one. The outbound
 * approval endpoints below (ticket d86d0c24 step 6) reuse the SAME gate —
 * approving/rejecting a draft post is exactly as sensitive as editing the
 * channel itself, and adding a dedicated permission for one sub-resource of
 * an already-gated resource would just be more surface to keep in sync.
 */
@ApiBearerAuth('user-session')
@ApiTags('outreach-channels')
@Controller('api/outreach-channels')
@UseGuards(PermissionGuard)
@RequirePermission(PERMISSIONS.MANAGE_RESOURCES)
export class OutreachController {
  constructor(
    private readonly channelService: OutreachChannelService,
    private readonly publisherService: OutreachPublisherService,
  ) {}

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

  // ── Outbound approval queue (ticket d86d0c24 step 6) ──────────────────────
  // "승인 대기 상태에서는 실제 외부 호출이 일어나지 않음" — these three endpoints
  // are the ONLY way a 'draft' row ever leaves that state; nothing here calls
  // a connector directly (OutreachPublisherService.approve does, behind its
  // own single-winner conditional-UPDATE claim).

  @Get(':id/outbound')
  async listOutbound(
    @Param('id') channelId: string,
    @Query('workspace_id') workspaceId: string,
    @Query('status') status: string | undefined,
    @Res() res: Response,
  ) {
    try {
      const rows = await this.publisherService.listOutbound(channelId, workspaceId, status);
      return res.json(rows.map(outboundToJson));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to list outbound posts' });
    }
  }

  @Post(':id/outbound/:postId/approve')
  async approveOutbound(
    @Param('id') channelId: string,
    @Param('postId') postId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      const workspaceId = body?.workspace_id;
      const post = await this.publisherService.approve(postId, workspaceId, body?.body);
      if (post.channel_id !== channelId) {
        return res.status(404).json({ error: 'outbound post does not belong to this channel' });
      }
      return res.json(outboundToJson(post));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to approve outbound post' });
    }
  }

  @Post(':id/outbound/:postId/reject')
  async rejectOutbound(
    @Param('id') channelId: string,
    @Param('postId') postId: string,
    @Body() body: any,
    @Res() res: Response,
  ) {
    try {
      const workspaceId = body?.workspace_id;
      const post = await this.publisherService.reject(postId, workspaceId);
      if (post.channel_id !== channelId) {
        return res.status(404).json({ error: 'outbound post does not belong to this channel' });
      }
      return res.json(outboundToJson(post));
    } catch (e: any) {
      return res.status(e?.status || 400).json({ error: e?.message || 'Failed to reject outbound post' });
    }
  }
}
