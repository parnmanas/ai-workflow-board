import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { doolaFormation } from './doola-formation';
import type { BusinessConnector } from '../business.types';
import { externalId, rows, text } from './connector-http';

export const doolaConnector: BusinessConnector = {
  formation: doolaFormation,
  descriptor: {
    id: 'doola', name: 'doola', stage: 'formation', color: '#facc15', monogram: 'd', mode: 'api',
    summary: '법인 설립 진행 상황과 연차 보고 기한', capabilities: ['LLC 설립 신청', '설립 · EIN 상태 조회', '컴플라이언스 일정'],
    setup_note: '파트너 API 키로 1인 LLC(WY·DE) 신청서를 제출하거나, 기존 회사 ID를 연결해 조회할 수 있습니다. 본인 서명·심사·추가 서류는 doola 절차로 이어집니다.',
    docs_url: 'https://docs.doola.com/api/introduction', portal_url: 'https://app.doola.com',
    formation: { states: ['WY', 'DE'], entity_types: ['LLC'] },
    credential_provider: 'doola', secret_fields: ['api_key'],
    fields: [{ key: 'company_id', label: 'doola 회사 ID', placeholder: 'doolaCompanyId' }], environments: ['sandbox', 'live'],
  },
  async sync({ config, secrets, environment, get }) {
    if (!secrets.api_key.startsWith(environment === 'sandbox' ? 'dk_test_' : 'dk_live_')) {
      throw new BadRequestException('doola 키와 선택한 환경이 일치하지 않습니다.');
    }
    const base = environment === 'sandbox' ? 'https://api.test.doola.com' : 'https://api.doola.com';
    const path = `${base}/v1/partner/companies/${externalId(config.company_id)}`;
    const headers = { Authorization: secrets.api_key };
    const unwrap = (body: any) => {
      if (body?.error || !body?.payload || typeof body.payload !== 'object') throw new BadGatewayException('doola 응답을 확인하지 못했습니다. 회사 ID와 파트너 권한을 확인하세요.');
      return body.payload;
    };
    const company = unwrap(await get(path, headers));
    const calendar = unwrap(await get(`${path}/compliance/calendar`, headers));
    if (!company.formationSubmissionStatus) throw new BadGatewayException('doola 설립 상태가 응답에 없습니다.');
    return {
      metrics: [
        { label: '설립 진행', value: text(company.formationSubmissionStatus) },
        { label: 'EIN', value: company.ein ? '발급됨' : '발급 대기' },
      ],
      records: rows(calendar.events).slice(0, 20).map((event, i) => ({
        id: `compliance-${i}`, label: event.type === 'ANNUAL_REPORT' ? '연차 보고' : text(event.type),
        status: text(event.status), ...(event.nextDueDate ? { date: text(event.nextDueDate) } : {}),
      })),
      note: 'doola의 현재 조회 결과입니다. 상태 조회와 업무 체크리스트 완료는 각각 관리됩니다.',
    };
  },
};
