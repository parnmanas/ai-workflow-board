import { Injectable } from '@nestjs/common';
import { LogService } from '../log.service';
import { INotificationProvider, NotifyPayload, ProviderResult } from './types';

/**
 * Discord per-user delivery.
 *
 * The binding's `target` is interpreted as one of:
 *   - a recipient user id (snowflake) — provider opens a DM channel via
 *     `POST /users/@me/channels` and posts there
 *   - a channel id (snowflake) — provider posts directly to that channel
 *
 * Heuristic: Discord doesn't disambiguate user vs. channel by id shape, so
 * we always try the DM-open path first and fall back to direct-channel send
 * if that fails with 400/404. Both paths use the same bot token.
 */
@Injectable()
export class DiscordUserProvider implements INotificationProvider {
  readonly id = 'discord' as const;

  constructor(private readonly logService: LogService) {}

  async send(target: string, credentials: Record<string, string>, payload: NotifyPayload): Promise<ProviderResult> {
    const token = credentials.bot_token;
    if (!token) return { ok: false, error: 'Missing bot_token credential' };
    if (!target) return { ok: false, error: 'Missing target' };

    const channelId = await this._resolveDeliveryChannel(token, target);
    if (!channelId) {
      return { ok: false, error: 'Unable to resolve delivery channel (target is not a reachable user or channel)' };
    }

    const body = this._formatMessage(payload);
    const res = await this._post(token, `https://discord.com/api/v10/channels/${channelId}/messages`, body);
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      return { ok: false, error: `Discord send failed: ${res.status} ${errText.slice(0, 200)}` };
    }
    return { ok: true };
  }

  async test(target: string, credentials: Record<string, string>): Promise<ProviderResult> {
    return this.send(target, credentials, {
      title: 'AWB notification test',
      body: 'This is a test message from AI Workflow Board. Your Discord notification channel is wired up correctly.',
    });
  }

  private async _resolveDeliveryChannel(token: string, target: string): Promise<string | null> {
    // Try DM-open first (most common case: target is a user id).
    const dmRes = await this._post(token, 'https://discord.com/api/v10/users/@me/channels', { recipient_id: target });
    if (dmRes.ok) {
      const dm = await dmRes.json().catch(() => null) as { id?: string } | null;
      if (dm?.id) return dm.id;
    }

    // Fall back: assume `target` is itself a channel id. Probe by GET.
    const chRes = await fetch(`https://discord.com/api/v10/channels/${target}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (chRes.ok) return target;

    this.logService.warn('UserChannel:Discord', `Cannot resolve target ${target} as user or channel`);
    return null;
  }

  private async _post(token: string, url: string, body: any): Promise<Response> {
    let res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.status === 429) {
      const retryAfter = parseFloat(res.headers.get('retry-after') || '1') * 1000;
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 10000)));
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }
    return res;
  }

  private _formatMessage(payload: NotifyPayload): any {
    const lines: string[] = [];
    lines.push(`**${payload.title}**`);
    if (payload.actor) lines.push(`_by ${payload.actor}_`);
    if (payload.body) lines.push('', payload.body);
    if (payload.url) lines.push('', payload.url);
    return { content: lines.join('\n').slice(0, 1900) };
  }
}
