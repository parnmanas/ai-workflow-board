import type { BusinessConnector } from '../business.types';
import { number, rows, text } from './connector-http';
import { supportSubdomain } from './zendesk';
export const freshdeskConnector: BusinessConnector = {
  descriptor: {
    id: 'freshdesk', name: 'Freshdesk', stage: 'support', color: '#86efac', monogram: 'F', mode: 'api',
    summary: '최근 30일 생성된 CS 티켓의 상태', capabilities: ['최근 티켓 상태', '조회 목록의 미완료 수'],
    setup_note: '프로필의 API 키와 Freshdesk subdomain이 필요합니다. 접근 가능한 최근 30일 티켓 중 최대 30건을 조회합니다.',
    docs_url: 'https://developers.freshdesk.com/api/#list_all_tickets', portal_url: 'https://www.freshworks.com/login/',
    credential_provider: 'freshdesk', secret_fields: ['api_key'], fields: [{ key: 'subdomain', label: 'Freshdesk subdomain', placeholder: 'acme (acme.freshdesk.com)' }], environments: ['live'],
  },
  async sync({ config, secrets, get }) {
    const body = await get(`https://${supportSubdomain(config.subdomain)}.freshdesk.com/api/v2/tickets?per_page=30&order_by=updated_at&order_type=desc`, { Authorization: `Basic ${Buffer.from(`${secrets.api_key}:X`).toString('base64')}` });
    const tickets = rows(body).slice(0, 30);
    const labels: Record<number, string> = { 2: '열림', 3: '대기', 4: '해결', 5: '종료' };
    return {
      metrics: [{ label: '조회된 티켓 (최대 30건)', value: tickets.length }, { label: '조회 목록 중 미완료', value: tickets.filter(t => ![4, 5].includes(t.status)).length }],
      records: tickets.map(t => ({ id: String(number(t.id)), label: `티켓 #${number(t.id)}`, status: labels[number(t.status)] || String(t.status), date: text(t.updated_at) })),
      note: '최근 30일 생성된 티켓 중 최대 30건. 전체 CS 현황이 아니며 고객 본문·이메일은 저장하지 않습니다.',
    };
  },
};
