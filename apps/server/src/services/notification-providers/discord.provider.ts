import { Injectable } from '@nestjs/common';
import { LogService } from '../log.service';
import { INotificationProvider, NotifyPayload, ProviderResult } from './types';
import { describeHttpError, fetchWithTimeout, notifyHttpTimeoutMs, readJsonBody, readTextBody } from './http';

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

    // 상한은 send() 당 한 번만 읽는다 — 요청 하나가 나가는 도중 env 가 바뀌어도
    // 같은 send() 안의 요청들이 서로 다른 상한을 쓰지 않게.
    const timeoutMs = notifyHttpTimeoutMs();
    try {
      const channelId = await this._resolveDeliveryChannel(token, target, timeoutMs);
      if (!channelId) {
        return { ok: false, error: 'Unable to resolve delivery channel (target is not a reachable user or channel)' };
      }

      const body = this._formatMessage(payload);
      const res = await this._post(token, `https://discord.com/api/v10/channels/${channelId}/messages`, body, timeoutMs);
      if (!res.ok) {
        const errText = await readTextBody(res);
        return { ok: false, error: `Discord send failed: ${res.status} ${errText.slice(0, 200)}` };
      }
      return { ok: true };
    } catch (err) {
      // `INotificationProvider.send` 계약은 "throw 하지 말고 ok:false 로 돌려준다" 이다.
      // 상한 초과와 소켓 오류를 여기서 정규화해, dispatcher 의 `Promise.all` 이
      // 거부로 끊기지 않고 바인딩별 실패로만 집계되게 한다.
      return { ok: false, error: `Discord send failed: ${describeHttpError(err, timeoutMs)}` };
    }
  }

  async test(target: string, credentials: Record<string, string>): Promise<ProviderResult> {
    return this.send(target, credentials, {
      title: 'AWB notification test',
      body: 'This is a test message from AI Workflow Board. Your Discord notification channel is wired up correctly.',
    });
  }

  private async _resolveDeliveryChannel(token: string, target: string, timeoutMs: number): Promise<string | null> {
    // Try DM-open first (most common case: target is a user id).
    //
    // 여기서 상한 초과·소켓 오류를 잡지 않고 그대로 올려보내는 것은 의도된 것이다.
    // "이 target 은 사용자가 아니다"(HTTP 400/404)와 "discord.com 이 응답하지 않는다"는
    // 다른 사건이고, 후자에서 같은 호스트로 폴백 프로브를 한 번 더 던져봐야
    // 똑같이 매달릴 뿐이라 send() 의 상한만 두 배가 된다. 폴백은 응답이 실제로
    // 돌아온 경우에만 의미가 있다.
    const dmRes = await this._post(token, 'https://discord.com/api/v10/users/@me/channels', { recipient_id: target }, timeoutMs);
    if (dmRes.ok) {
      const dm = await readJsonBody<{ id?: string }>(dmRes);
      if (dm?.id) return dm.id;
    }

    // Fall back: assume `target` is itself a channel id. Probe by GET.
    const chRes = await fetchWithTimeout(`https://discord.com/api/v10/channels/${target}`, {
      headers: { Authorization: `Bot ${token}` },
    }, timeoutMs);
    if (chRes.ok) return target;

    this.logService.warn('UserChannel:Discord', `Cannot resolve target ${target} as user or channel`);
    return null;
  }

  private async _post(token: string, url: string, body: any, timeoutMs: number): Promise<Response> {
    const init: RequestInit = {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    };
    let res = await fetchWithTimeout(url, init, timeoutMs);
    if (res.status === 429) {
      // rate-limit 대기는 일부러 요청 상한 밖에 둔다. 429 를 돌려줬다는 것은
      // 상대가 살아서 응답하고 있다는 뜻이라 이 티켓이 막으려는 "매달림"이 아니다.
      // 재시도 요청은 아래에서 자기 몫의 새 상한을 받는다.
      const retryAfter = parseFloat(res.headers.get('retry-after') || '1') * 1000;
      await new Promise(r => setTimeout(r, Math.min(retryAfter, 10000)));
      res = await fetchWithTimeout(url, init, timeoutMs);
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
