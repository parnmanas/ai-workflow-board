import { BadGatewayException, BadRequestException } from '@nestjs/common';
import type { BusinessConnector } from '../business.types';
import { number, rows, text } from './connector-http';

export const quickbooksConnector: BusinessConnector = {
  descriptor: {
    id: 'quickbooks', name: 'QuickBooks', stage: 'accounting', color: '#86efac', monogram: 'Q', mode: 'api',
    summary: 'QuickBooks Online 미수 청구서 상태', capabilities: ['미수 청구서 조회', '청구일 · 잔액 유무'],
    setup_note: 'QuickBooks Online OAuth 접근 토큰(com.intuit.quickbooks.accounting)과 회사 realm ID가 필요합니다. 접근 토큰은 만료 시 직접 갱신하세요.',
    docs_url: 'https://developer.intuit.com/docs/api/accounting/invoice', portal_url: 'https://qbo.intuit.com',
    credential_provider: 'quickbooks', secret_fields: ['access_token'], fields: [{ key: 'realm_id', label: '회사 realm ID', placeholder: '1234567890' }], environments: ['sandbox', 'live'],
  },
  async sync({ environment, config, secrets, get }) {
    if (!/^\d{1,30}$/.test(config.realm_id)) throw new BadRequestException('QuickBooks realm ID는 숫자여야 합니다.');
    const host = environment === 'sandbox' ? 'sandbox-quickbooks.api.intuit.com' : 'quickbooks.api.intuit.com';
    const query = encodeURIComponent('SELECT * FROM Invoice WHERE Balance > \'0\' MAXRESULTS 50');
    const body = await get(`https://${host}/v3/company/${config.realm_id}/query?query=${query}&minorversion=75`, { Authorization: `Bearer ${secrets.access_token}` });
    if (body?.Fault || !body?.QueryResponse || typeof body.QueryResponse !== 'object' || Array.isArray(body.QueryResponse)) throw new BadGatewayException('QuickBooks 조회 결과를 확인하지 못했습니다.');
    const invoices = rows(body.QueryResponse.Invoice ?? []).slice(0, 50);
    return {
      metrics: [{ label: '조회된 미수 청구서 (최대 50건)', value: invoices.length }],
      records: invoices.map(item => ({ id: text(item.Id), label: `청구서 ${text(item.DocNumber, text(item.Id))}`, status: number(item.Balance) > 0 ? '미수 잔액 있음' : '잔액 없음', date: text(item.DueDate, text(item.TxnDate)) })),
      note: '미수 청구서 최대 50건의 메타데이터입니다. 전체 매출·결산 자료가 아니며 분개와 토큰 갱신은 QuickBooks에서 진행합니다.',
    };
  },
};
