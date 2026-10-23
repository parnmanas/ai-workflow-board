import { BadRequestException } from '@nestjs/common';
import type { BusinessConnector } from '../business.types';
import { number, rows, text } from './connector-http';

export function supportSubdomain(value: string): string {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) throw new BadRequestException('서비스 subdomain만 입력하세요. URL·점·슬래시는 허용하지 않습니다.');
  return value;
}
export const zendeskConnector: BusinessConnector = {
  descriptor: {
    id: 'zendesk', name: 'Zendesk', stage: 'support', color: '#99f6e4', monogram: 'Z', mode: 'api',
    summary: '최근 고객지원 티켓의 처리 상태', capabilities: ['최근 티켓 상태', '조회 목록의 미완료 수'],
    setup_note: 'Support OAuth 접근 토큰(read 권한)과 subdomain이 필요합니다. API 토큰을 OAuth 토큰 대신 넣지 마세요.',
    docs_url: 'https://developer.zendesk.com/api-reference/ticketing/tickets/tickets/', portal_url: 'https://www.zendesk.com/login/',
    credential_provider: 'zendesk', secret_fields: ['access_token'], fields: [{ key: 'subdomain', label: 'Zendesk subdomain', placeholder: 'acme (acme.zendesk.com)' }], environments: ['live'],
  },
  async sync({ config, secrets, get }) {
    const body = await get(`https://${supportSubdomain(config.subdomain)}.zendesk.com/api/v2/tickets.json?per_page=30&sort_by=updated_at&sort_order=desc`, { Authorization: `Bearer ${secrets.access_token}` });
    const tickets = rows(body?.tickets).slice(0, 30);
    return {
      metrics: [{ label: '조회된 티켓 (최대 30건)', value: tickets.length }, { label: '조회 목록 중 미완료', value: tickets.filter(t => !['solved', 'closed'].includes(t.status)).length }],
      records: tickets.map(t => ({ id: String(number(t.id)), label: `티켓 #${number(t.id)}`, status: text(t.status), date: text(t.updated_at) })),
      note: '최근 티켓 최대 30건이며 전체 미완료 수가 아닙니다. 고객 본문은 저장하지 않습니다. 응답은 Zendesk에서 진행하세요.',
    };
  },
};
