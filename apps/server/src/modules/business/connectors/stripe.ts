import { BadGatewayException } from '@nestjs/common';
import type { BusinessConnector } from '../business.types';
import { minor, number, rows, text } from './connector-http';

export const stripeConnector: BusinessConnector = {
  descriptor: {
    id: 'stripe', name: 'Stripe', stage: 'payments', color: '#a5b4fc', monogram: 'S', mode: 'api',
    summary: '통화별 결제 잔액과 정산 거래', capabilities: ['사용 가능·대기 잔액', '최근 정산 거래 25건'],
    setup_note: 'Balance와 Balance transactions 조회 권한을 가진 제한 키를 권장합니다. 결제 생성·환불은 Stripe에서 처리합니다.',
    docs_url: 'https://docs.stripe.com/api/balance', portal_url: 'https://dashboard.stripe.com',
    credential_provider: 'stripe', secret_fields: ['secret_key'], fields: [], environments: ['sandbox', 'live'],
  },
  async sync({ secrets, environment, get }) {
    const headers = { Authorization: `Bearer ${secrets.secret_key}` };
    const balance = await get('https://api.stripe.com/v1/balance', headers);
    if (balance.livemode !== (environment === 'live')) throw new BadGatewayException('Stripe 키의 테스트/운영 환경이 선택과 다릅니다.');
    const transactions = await get('https://api.stripe.com/v1/balance_transactions?limit=25', headers);
    return {
      metrics: [
        ...rows(balance.available).map(b => ({ label: '사용 가능 잔액', value: '', amount_minor: minor(b.amount), currency: text(b.currency).toUpperCase() })),
        ...rows(balance.pending).map(b => ({ label: '정산 대기', value: '', amount_minor: minor(b.amount), currency: text(b.currency).toUpperCase() })),
      ].slice(0, 20),
      records: rows(transactions.data).slice(0, 25).map(t => ({
        id: text(t.id), label: text(t.description, text(t.type, '정산 거래')), status: text(t.status),
        amount_minor: minor(t.net), currency: text(t.currency).toUpperCase(), date: new Date(number(t.created) * 1000).toISOString(),
      })),
      note: '통화별 Stripe 잔액과 최근 순액(net) 거래 25건입니다. 은행 잔액이나 전체 매출과는 별개입니다.',
    };
  },
};
