import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Controller, Get, Post, Patch, Delete, Body, Param, Res, UseGuards } from '@nestjs/common';
import { Response } from 'express';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../../entities/Channel';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { WorkspaceGuard } from '../../common/guards/workspace.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { CurrentWorkspaceId } from '../../common/decorators/current-workspace.decorator';
import { PERMISSIONS } from '../../common/types/permissions';
import { DiscordService } from '../../services/discord.service';
import { findOrFail } from '../../common/find-or-fail';

@ApiBearerAuth('user-session')
@ApiTags('channels')
@Controller('api/channels')
@UseGuards(PermissionGuard, WorkspaceGuard)
@RequirePermission(PERMISSIONS.MANAGE_CHANNELS)
export class ChannelsController {
  constructor(
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    private readonly discordService: DiscordService,
  ) {}

  @Get()
  async list(@CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    if (!workspaceId) return res.json([]);
    const channels = await this.channelRepo.find({ where: { workspace_id: workspaceId }, order: { name: 'ASC' } });
    const masked = channels.map(ch => ({
      ...ch, bot_token: ch.bot_token ? '***' + ch.bot_token.slice(-4) : '',
    }));
    return res.json(masked);
  }

  @Get(':id')
  async get(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const channel = await findOrFail(this.channelRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Channel not found');
    return res.json({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
  }

  @Post()
  async create(@Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const { name, type = 'discord', bot_token = '', channel_id = '', is_active = 1, notify_on_status_change = 1, notify_on_update = 1, notify_on_comment = 1 } = body;
    if (!name) return res.status(400).json({ error: 'name is required' });

    const channel = await this.channelRepo.save(this.channelRepo.create({
      name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment, workspace_id: workspaceId || '',
    }));
    return res.status(201).json({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
  }

  @Patch(':id')
  async update(@Param('id') id: string, @Body() body: any, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const channel = await findOrFail(this.channelRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Channel not found');

    const { name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment } = body;
    if (name !== undefined) channel.name = name;
    if (type !== undefined) channel.type = type;
    if (bot_token !== undefined && bot_token !== '') channel.bot_token = bot_token;
    if (channel_id !== undefined) channel.channel_id = channel_id;
    if (is_active !== undefined) channel.is_active = is_active;
    if (notify_on_status_change !== undefined) channel.notify_on_status_change = notify_on_status_change;
    if (notify_on_update !== undefined) channel.notify_on_update = notify_on_update;
    if (notify_on_comment !== undefined) channel.notify_on_comment = notify_on_comment;

    await this.channelRepo.save(channel);
    return res.json({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
  }

  @Delete(':id')
  async delete(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const channel = await findOrFail(this.channelRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Channel not found');
    await this.channelRepo.delete(channel.id);
    return res.json({ success: true });
  }

  @Post(':id/test')
  async test(@Param('id') id: string, @CurrentWorkspaceId() workspaceId: string | null, @Res() res: Response) {
    const channel = await findOrFail(this.channelRepo, {
      where: { id, ...(workspaceId ? { workspace_id: workspaceId } : {}) },
    }, 'Channel not found');
    const result = await this.discordService.testDiscordConnection(channel);
    return res.json(result);
  }
}
