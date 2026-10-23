import { z } from 'zod';
import type { TrademarkConnector, TrademarkConnectorContext, TrademarkSourceRecord } from './trademark-connector';
import { bearer, id, list, parseConfig, text } from './trademark-http';

export function trademarkReplyAddress(context: Pick<TrademarkConnectorContext, 'id' | 'data'>): string {
  return `tm-${context.id}@${context.data.config.inbound_domain}`;
}
const addressed = (value: any, address: string) => Array.isArray(value?.to) && value.to.some((to: unknown) => typeof to === 'string' && to.toLowerCase() === address.toLowerCase());
async function receive(context: TrademarkConnectorContext, emailId: string): Promise<TrademarkSourceRecord[]> {
  const row = await context.request(`https://api.resend.com/emails/receiving/${encodeURIComponent(id(emailId))}`, { headers: bearer(context.secrets.api_key) });
  if (row.id !== emailId || !addressed(row, trademarkReplyAddress(context))) return [];
  return [{ source_id: id(row.id), kind: 'email', title: text(row.subject), status: 'received', date: text(row.created_at),
    from: text(row.from), to: list(row.to).map(value => text(value)), text: text(row.text, 100_000) || '텍스트 본문이 없습니다. 원본 메일에서 HTML·첨부를 확인하세요.',
    details: { message_id: text(row.message_id), attachments: Array.isArray(row.attachments) ? row.attachments.map((a: any) => text(a.filename, 200)).join(', ').slice(0, 2000) : '' } }];
}
export const trademarkResend: TrademarkConnector = {
  descriptor: { id: 'resend_inbound', name: 'Resend 회신', icon: 'mail', auth: 'api_key', credential_provider: 'resend_inbound', secret_fields: ['api_key', 'webhook_secret'],
    capabilities: ['상표별 회신 주소', '수신 웹훅', '누락 메일 재수집'], webhook: 'svix',
    fields: [{ key: 'inbound_domain', label: '수신 전용 도메인', placeholder: 'reply.example.com' }],
    setup: 'Resend Receiving에 수신 전용 서브도메인을 인증하세요. 생성된 상표별 주소를 발송 메일의 Reply-To로 사용합니다. email.received 웹훅과 서명 키를 등록하면 즉시 수집하며 자동 조회가 누락을 보완합니다. 기존 메일 도메인의 MX는 변경하지 마세요.',
    docs_url: 'https://resend.com/docs/dashboard/receiving/introduction' },
  config(value) { return parseConfig(z.object({ inbound_domain: z.string().toLowerCase().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/).max(190) }).strict(), value); },
  async sync(context) {
    let after = context.data.cursor?.after || ''; const records: TrademarkSourceRecord[] = []; let pages = 0;
    while (pages++ < 4 && records.length < 10) {
      const query = new URLSearchParams({ limit: '25', ...(after ? { after } : {}) });
      const result = await context.request(`https://api.resend.com/emails/receiving?${query}`, { headers: bearer(context.secrets.api_key) });
      const rows = list(result.data);
      for (const row of rows) {
        after = id(row.id);
        if (addressed(row, trademarkReplyAddress(context))) records.push(...await receive(context, after));
        if (records.length >= 10) break;
      }
      if (!rows.length || (records.length < 10 && !result.has_more)) { after = ''; break; }
    }
    return { records, cursor: { after }, summary: `${records.length}개 회신 확인${after ? ' · 다음 주기에 이전 기록 수집 계속' : ' · 최신 수신부터 다시 확인'}` };
  },
  async receive(context, event) {
    if (event?.type !== 'email.received' || !addressed(event.data, trademarkReplyAddress(context))) return [];
    return receive(context, id(event.data.email_id));
  },
};
