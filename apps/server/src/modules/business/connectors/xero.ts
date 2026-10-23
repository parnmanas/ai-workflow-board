import type { BusinessConnector } from '../business.types';
import { BadGatewayException } from '@nestjs/common';
import { externalId, rows, text } from './connector-http';

export const xeroConnector: BusinessConnector = {
  descriptor: {
    id: 'xero', name: 'Xero', stage: 'accounting', color: '#67e8f9', monogram: 'X', mode: 'api',
    summary: '회계 조직과 승인된 미수 청구서', capabilities: ['회계 조직 조회', '미수 청구서 조회'],
    setup_note: 'OAuth로 발급받은 access_token과 Xero tenant ID가 필요합니다. 토큰 자동 갱신은 아직 지원하지 않으며, 만료 시 Credentials에서 갱신하세요.',
    docs_url: 'https://developer.xero.com/documentation/api/accounting/overview/', portal_url: 'https://go.xero.com',
    credential_provider: 'xero', secret_fields: ['access_token'],
    fields: [{ key: 'tenant_id', label: 'Xero tenant ID', placeholder: '조직 tenant UUID' }], environments: ['live'],
  },
  async sync({ config, secrets, get }) {
    const headers = { Authorization: `Bearer ${secrets.access_token}`, 'Xero-tenant-id': externalId(config.tenant_id) };
    const organisation = await get('https://api.xero.com/api.xro/2.0/Organisation', headers);
    const query = new URLSearchParams({ where: 'Type=="ACCREC"&&Status=="AUTHORISED"', page: '1', pageSize: '50' });
    const invoices = await get(`https://api.xero.com/api.xro/2.0/Invoices?${query}`, headers);
    const org = rows(organisation.Organisations)[0];
    if (!text(org?.Name)) throw new BadGatewayException('연결된 Xero 조직을 확인하지 못했습니다. tenant ID와 토큰 권한을 확인하세요.');
    return {
      metrics: [{ label: '회계 조직', value: text(org?.Name, '조회됨') }, { label: '조회한 승인 청구서', value: rows(invoices.Invoices).length }],
      records: rows(invoices.Invoices).slice(0, 50).map(invoice => ({
        id: text(invoice.InvoiceID), label: text(invoice.InvoiceNumber, '청구서'), status: text(invoice.Status),
        ...(invoice.DueDateString ? { date: text(invoice.DueDateString) } : {}),
      })),
      note: '승인된 매출 청구서의 첫 페이지(최대 50건)입니다. 장부 작성·은행 대사·신고는 회계 서비스에서 처리하세요.',
    };
  },
};
