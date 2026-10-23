import type { BusinessConnector } from '../business.types';
import { number, rows, text } from './connector-http';
export const intercomConnector: BusinessConnector = {
  descriptor: {
    id: 'intercom', name: 'Intercom', stage: 'support', color: '#93c5fd', monogram: 'I', mode: 'api',
    summary: '상담 수와 최근 대화의 처리 상태', capabilities: ['전체 상담 수', '최근 상담 상태'],
    setup_note: '미국 리전의 Private app 접근 토큰과 대화 읽기 권한이 필요합니다. EU·AU 리전은 현재 외부 화면을 이용하세요.',
    docs_url: 'https://developers.intercom.com/docs/references/rest-api/api.intercom.io/conversations/listconversations', portal_url: 'https://app.intercom.com',
    credential_provider: 'intercom', secret_fields: ['access_token'], fields: [], environments: ['live'],
  },
  async sync({ secrets, get }) {
    const body = await get('https://api.intercom.io/conversations?per_page=30', { Authorization: `Bearer ${secrets.access_token}`, 'Intercom-Version': '2.17' });
    const conversations = rows(body?.conversations).slice(0, 30);
    return {
      metrics: [{ label: '전체 상담', value: number(body.total_count) }, { label: '조회 목록 중 열림', value: conversations.filter(c => c.state === 'open').length }],
      records: conversations.map(c => ({ id: text(c.id), label: `상담 #${text(c.id)}`, status: text(c.state), ...(typeof c.updated_at === 'number' && Number.isFinite(new Date(c.updated_at * 1000).getTime()) ? { date: new Date(c.updated_at * 1000).toISOString() } : {}) })),
      note: '최근 목록 최대 30건. 고객 이름·이메일·대화 내용은 저장하지 않습니다. 응답과 자동화 설정은 Intercom에서 진행하세요.',
    };
  },
};
