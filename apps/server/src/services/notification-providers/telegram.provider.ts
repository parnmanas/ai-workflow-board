import { Injectable } from '@nestjs/common';
import { LogService } from '../log.service';
import { INotificationProvider, NotifyPayload, ProviderResult } from './types';

/**
 * Telegram per-user delivery via the Bot API `sendMessage`.
 *
 * `target` is a chat id — for a private DM, the user must `/start` the bot
 * once so Telegram registers the chat; the chat id is then the user's id
 * (or, for groups, the negative group chat id).
 *
 * `credentials.bot_token` is the bot token (`<bot_id>:<secret>`).
 */
@Injectable()
export class TelegramUserProvider implements INotificationProvider {
  readonly id = 'telegram' as const;

  constructor(private readonly logService: LogService) {}

  async send(target: string, credentials: Record<string, string>, payload: NotifyPayload): Promise<ProviderResult> {
    const token = credentials.bot_token;
    if (!token) return { ok: false, error: 'Missing bot_token credential' };
    if (!target) return { ok: false, error: 'Missing target' };

    const text = this._formatText(payload);
    const res = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: target, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, error: `Telegram HTTP ${res.status}: ${body.slice(0, 200)}` };
    }
    const data = await res.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!data?.ok) {
      return { ok: false, error: `Telegram API error: ${data?.description || 'unknown'}` };
    }
    return { ok: true };
  }

  async test(target: string, credentials: Record<string, string>): Promise<ProviderResult> {
    const token = credentials.bot_token;
    if (!token) return { ok: false, error: 'Missing bot_token credential' };
    const meRes = await fetch(`https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`);
    const meData = await meRes.json().catch(() => null) as { ok?: boolean; description?: string } | null;
    if (!meData?.ok) {
      return { ok: false, error: `Telegram getMe failed: ${meData?.description || 'unknown'}` };
    }
    return this.send(target, credentials, {
      title: 'AWB notification test',
      body: 'This is a test message from AI Workflow Board. Your Telegram notification channel is wired up correctly.',
    });
  }

  private _formatText(payload: NotifyPayload): string {
    const escape = (s: string) => s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    const lines: string[] = [];
    lines.push(`<b>${escape(payload.title)}</b>`);
    if (payload.actor) lines.push(`<i>by ${escape(payload.actor)}</i>`);
    if (payload.body) lines.push('', escape(payload.body));
    if (payload.url) lines.push('', payload.url);
    return lines.join('\n');
  }
}
