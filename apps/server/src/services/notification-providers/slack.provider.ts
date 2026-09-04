import { Injectable } from '@nestjs/common';
import { LogService } from '../log.service';
import { INotificationProvider, NotifyPayload, ProviderResult } from './types';
import { describeHttpError, fetchWithTimeout, notifyHttpTimeoutMs, readJsonBody } from './http';

/**
 * Slack per-user delivery via `chat.postMessage`.
 *
 * `target` is either a Slack user id (e.g., `U12345`) — Slack auto-opens a DM
 * when the bot posts to a user id — or a channel id (e.g., `C12345` /
 * `D12345`). Either way the API shape is the same: `{ channel, text }`.
 *
 * `credentials.bot_token` is the bot user OAuth token (`xoxb-…`).
 */
@Injectable()
export class SlackUserProvider implements INotificationProvider {
  readonly id = 'slack' as const;

  constructor(private readonly logService: LogService) {}

  async send(target: string, credentials: Record<string, string>, payload: NotifyPayload): Promise<ProviderResult> {
    const token = credentials.bot_token;
    if (!token) return { ok: false, error: 'Missing bot_token credential' };
    if (!target) return { ok: false, error: 'Missing target' };

    const timeoutMs = notifyHttpTimeoutMs();
    try {
      const text = this._formatText(payload);
      const res = await fetchWithTimeout('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ channel: target, text, mrkdwn: true }),
      }, timeoutMs);

      if (!res.ok) {
        return { ok: false, error: `Slack HTTP ${res.status}` };
      }

      const data = await readJsonBody<{ ok?: boolean; error?: string }>(res);
      if (!data?.ok) {
        return { ok: false, error: `Slack API error: ${data?.error || 'unknown'}` };
      }
      return { ok: true };
    } catch (err) {
      // `INotificationProvider.send` 계약대로 상한 초과·소켓 오류를 ok:false 로 정규화한다.
      return { ok: false, error: `Slack send failed: ${describeHttpError(err, timeoutMs)}` };
    }
  }

  async test(target: string, credentials: Record<string, string>): Promise<ProviderResult> {
    // auth.test is the canonical token-validation probe. It confirms the
    // token is well-formed and live without sending a noisy DM. We follow
    // up with a real send so the user gets a "your channel works" ping.
    const token = credentials.bot_token;
    if (!token) return { ok: false, error: 'Missing bot_token credential' };
    const timeoutMs = notifyHttpTimeoutMs();
    let authData: { ok?: boolean; error?: string } | null;
    try {
      const authRes = await fetchWithTimeout('https://slack.com/api/auth.test', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }, timeoutMs);
      authData = await readJsonBody<{ ok?: boolean; error?: string }>(authRes);
    } catch (err) {
      // 이 probe 는 REST 의 "채널 테스트" 버튼이 그대로 await 한다. 던지면
      // 엔드포인트가 500 을 내므로 여기서도 ok:false 로 정규화한다.
      return { ok: false, error: `Slack auth failed: ${describeHttpError(err, timeoutMs)}` };
    }
    if (!authData?.ok) {
      return { ok: false, error: `Slack auth failed: ${authData?.error || 'unknown'}` };
    }
    return this.send(target, credentials, {
      title: 'AWB notification test',
      body: 'This is a test message from AI Workflow Board. Your Slack notification channel is wired up correctly.',
    });
  }

  private _formatText(payload: NotifyPayload): string {
    const lines: string[] = [];
    lines.push(`*${payload.title}*`);
    if (payload.actor) lines.push(`_by ${payload.actor}_`);
    if (payload.body) lines.push('', payload.body);
    if (payload.url) lines.push('', `<${payload.url}>`);
    return lines.join('\n');
  }
}
