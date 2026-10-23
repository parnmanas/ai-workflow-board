import type { BusinessConnector } from '../business.types';
import { externalId, number, rows, text } from './connector-http';
import { BadRequestException } from '@nestjs/common';

export const chatwootConnector: BusinessConnector = {
  descriptor: {
    id: 'chatwoot', name: 'Chatwoot', stage: 'support', color: '#93c5fd', monogram: 'C', mode: 'api',
    summary: '고객지원 채널과 미처리 대화', capabilities: ['인박스 조회', '진행 중·미배정 대화 수'],
    setup_note: 'Chatwoot Cloud의 프로필 API 토큰과 숫자 account ID를 입력하세요. 채널 개설과 고객 응답은 Chatwoot에서 진행합니다.',
    docs_url: 'https://developers.chatwoot.com/api-reference/introduction', portal_url: 'https://app.chatwoot.com',
    credential_provider: 'chatwoot', secret_fields: ['api_token'],
    fields: [{ key: 'account_id', label: 'Chatwoot account ID', placeholder: '예: 12345 (AWB 계정 ID와 다릅니다)' }], environments: ['live'],
  },
  async sync({ config, secrets, get }) {
    if (!/^[1-9]\d*$/.test(config.account_id)) throw new BadRequestException('Chatwoot account ID는 양의 정수입니다.');
    const base = `https://app.chatwoot.com/api/v1/accounts/${externalId(config.account_id)}`;
    const headers = { Authorization: `Bearer ${secrets.api_token}` };
    const counts = await get(`${base}/conversations/meta?status=open`, headers);
    const inboxes = await get(`${base}/inboxes`, headers);
    return {
      metrics: [{ label: '진행 중 대화', value: number(counts.meta?.all_count) }, { label: '담당자 미배정', value: number(counts.meta?.unassigned_count) }],
      records: rows(inboxes.payload).slice(0, 30).map(inbox => ({ id: String(inbox.id), label: text(inbox.name), status: text(inbox.channel_type, 'inbox') })),
      note: '고객 메시지나 개인정보를 복사하지 않고 대화 수와 채널 목록만 조회합니다.',
    };
  },
};
