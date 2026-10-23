import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { TrademarkMailPayload } from '../trademark.types';
import { connectorGet, connectorPost } from './connector-http';

export interface BusinessEmailConnector {
  id: string;
  credential_provider: string;
  send(payload: TrademarkMailPayload, apiKey: string, idempotencyKey: string): Promise<string>;
  delivery(messageId: string, apiKey: string): Promise<string>;
  reconcile(messageId: string, payload: TrademarkMailPayload, apiKey: string): Promise<string>;
}
// Email is a separate write capability, never hidden in a read/sync adapter.
const resend: BusinessEmailConnector = {
  id: 'resend', credential_provider: 'resend',
  async send(payload, apiKey, idempotencyKey) {
    const result = await connectorPost('https://api.resend.com/emails', { Authorization: `Bearer ${apiKey}`, 'Idempotency-Key': idempotencyKey }, { ...payload, to: [payload.to] });
    if (typeof result?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(result.id)) throw new BadGatewayException('메일 접수 번호를 확인하지 못했습니다.');
    return result.id;
  },
  async delivery(messageId, apiKey) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(messageId)) throw new BadRequestException('메일 접수 번호를 확인하세요.');
    const result = await connectorGet(`https://api.resend.com/emails/${messageId}`, { Authorization: `Bearer ${apiKey}` });
    if (result?.id !== messageId || typeof result.last_event !== 'string') throw new BadGatewayException('메일 상태를 확인하지 못했습니다.');
    const allowed = ['sent', 'delivered', 'delivery_delayed', 'complained', 'bounced', 'opened', 'clicked', 'scheduled', 'canceled', 'failed'];
    return allowed.includes(result.last_event) ? result.last_event : 'unknown';
  },
  async reconcile(messageId, payload, apiKey) {
    if (!/^[a-zA-Z0-9_-]{1,120}$/.test(messageId)) throw new BadRequestException('메일 접수 번호를 확인하세요.');
    const result = await connectorGet(`https://api.resend.com/emails/${messageId}`, { Authorization: `Bearer ${apiKey}` });
    const replyTo = Array.isArray(result?.reply_to) ? result.reply_to : [result?.reply_to];
    if (result?.id !== messageId || result.from !== payload.from || !Array.isArray(result.to) || result.to.length !== 1 || result.to[0] !== payload.to ||
      replyTo.length !== 1 || replyTo[0] !== payload.reply_to || result.subject !== payload.subject || result.text !== payload.text) {
      throw new BadRequestException('공급자의 발송 원문이 검토한 메일과 일치하지 않습니다.');
    }
    return this.delivery(messageId, apiKey);
  },
};
export const BUSINESS_EMAIL_CONNECTORS: readonly BusinessEmailConnector[] = [resend];
export function businessEmailConnector(id: string) {
  const connector = BUSINESS_EMAIL_CONNECTORS.find(item => item.id === id);
  if (!connector) throw new BadRequestException('지원하지 않는 메일 커넥터입니다.');
  return connector;
}
