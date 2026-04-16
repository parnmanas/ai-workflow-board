import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Channel } from '../entities/Channel';
import { LogService } from './log.service';

interface DiscordMessage {
  content: string;
  embeds?: Array<{
    title?: string;
    description?: string;
    color?: number;
    fields?: Array<{ name: string; value: string; inline?: boolean }>;
    timestamp?: string;
  }>;
}

@Injectable()
export class DiscordService {
  constructor(
    @InjectRepository(Channel) private readonly channelRepo: Repository<Channel>,
    private readonly logService: LogService,
  ) {}

  async sendDiscordMessage(channel: Channel, message: DiscordMessage): Promise<boolean> {
    if (!channel.bot_token || !channel.channel_id) {
      this.logService.warn('Discord', `Channel ${channel.name} missing bot_token or channel_id`);
      return false;
    }

    try {
      let response = await fetch(`https://discord.com/api/v10/channels/${channel.channel_id}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bot ${channel.bot_token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      // Handle rate limiting with retry
      if (response.status === 429) {
        const retryAfter = parseFloat(response.headers.get('retry-after') || '1') * 1000;
        this.logService.warn('Discord', `Rate limited on ${channel.name}, retrying after ${retryAfter}ms`);
        await new Promise(r => setTimeout(r, Math.min(retryAfter, 10000)));
        response = await fetch(`https://discord.com/api/v10/channels/${channel.channel_id}/messages`, {
          method: 'POST',
          headers: {
            'Authorization': `Bot ${channel.bot_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(message),
        });
      }

      if (!response.ok) {
        const err = await response.text();
        this.logService.error('Discord', `Failed to send message to ${channel.name}: ${err}`);
        return false;
      }

      this.logService.info('Discord', `Message sent to ${channel.name}`);
      return true;
    } catch (err) {
      this.logService.error('Discord', `Error sending message to ${channel.name}`, { error: String(err) });
      return false;
    }
  }

  async testDiscordConnection(channel: Channel): Promise<{ success: boolean; error?: string }> {
    if (!channel.bot_token || !channel.channel_id) {
      return { success: false, error: 'Missing bot_token or channel_id' };
    }

    try {
      const response = await fetch(`https://discord.com/api/v10/channels/${channel.channel_id}`, {
        headers: { 'Authorization': `Bot ${channel.bot_token}` },
      });

      if (!response.ok) {
        const err = await response.text();
        return { success: false, error: `Discord API error: ${err}` };
      }

      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  async getChannelsByIds(channelIds: string[]): Promise<Channel[]> {
    if (!channelIds || channelIds.length === 0) return [];
    return this.channelRepo.find({
      where: channelIds.map(id => ({ id, is_active: 1 })),
    });
  }
}
