import type { BusinessConnector } from '../business.types';
import { minor, number, rows, text } from './connector-http';

export const mercuryConnector: BusinessConnector = {
  descriptor: {
    id: 'mercury', name: 'Mercury', stage: 'banking', color: '#c4b5fd', monogram: 'M', mode: 'api',
    summary: '사업자 계좌와 최근 입출금 내역', capabilities: ['계좌 조회', '최근 거래 40건'],
    setup_note: 'Mercury의 읽기 전용 API 토큰을 사용하세요. 계좌 개설·심사와 송금 승인은 Mercury에서 진행합니다.',
    docs_url: 'https://docs.mercury.com/docs/getting-started', portal_url: 'https://mercury.com',
    credential_provider: 'mercury', secret_fields: ['api_token'], fields: [], environments: ['sandbox', 'live'],
  },
  async sync({ environment, secrets, get }) {
    const base = environment === 'sandbox' ? 'https://api-sandbox.mercury.com/api/v1' : 'https://api.mercury.com/api/v1';
    const headers = { Authorization: `Bearer ${secrets.api_token}` };
    const accounts = await get(`${base}/accounts?limit=100`, headers);
    const transactions = await get(`${base}/transactions?limit=40&order=desc`, headers);
    return {
      metrics: [{ label: '조회한 계좌', value: rows(accounts.accounts).length }, { label: '조회한 최근 거래', value: rows(transactions.transactions).length }],
      records: rows(transactions.transactions).slice(0, 40).map(t => ({
        id: text(t.id), label: text(t.counterpartyName, text(t.bankDescription, '거래')), status: text(t.status),
        amount_minor: minor(Math.round(number(t.amount) * 100)), currency: 'USD', date: text(t.createdAt),
      })),
      note: '최근 거래 최대 40건입니다. 양수는 입금, 음수는 출금이며, pending 거래는 확정 입출금이 아닙니다. 전체 내역은 Mercury에서 확인하세요.',
    };
  },
};
