import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import type { FormationConnector, FormationContext } from './formation-connector';
import { externalId, minor, rows, text } from './connector-http';

const addressSchema = z.object({
  line1: z.string().trim().min(1).max(200), line2: z.string().trim().max(200).default(''),
  city: z.string().trim().min(1).max(100), state: z.string().trim().min(1).max(100),
  postalCode: z.string().trim().min(1).max(30), country: z.string().regex(/^[A-Z]{3}$/),
  phone: z.string().regex(/^\+[1-9]\d{6,14}$/),
}).strict();
const inputSchema = z.object({
  name: z.string().trim().min(1).max(100).refine(v => !/\b(?:LLC|L\.L\.C\.|Limited Liability Company)\s*$/i.test(v), '회사명에서 LLC 접미사를 빼세요.'),
  state: z.enum(['WY', 'DE']), industry: z.string().trim().min(1).max(250), description: z.string().trim().min(1).max(50),
  first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), email: z.email().max(254),
  address: addressSchema,
}).strict();
function api(context: FormationContext) {
  if (!context.secrets.api_key?.startsWith(context.environment === 'sandbox' ? 'dk_test_' : 'dk_live_')) throw new BadRequestException('doola 키와 선택한 환경이 일치하지 않습니다.');
  return { base: context.environment === 'sandbox' ? 'https://api.test.doola.com' : 'https://api.doola.com', headers: { Authorization: context.secrets.api_key } };
}
function payload(body: any) {
  if (body?.error || !body?.payload || typeof body.payload !== 'object') throw new BadGatewayException('doola 응답을 확인하지 못했습니다. 신청 기록을 유지하고 동일한 요청으로 결과를 확인하세요.');
  return body.payload;
}
export const doolaFormation: FormationConnector = {
  async references(context) {
    const { base, headers } = api(context);
    const [fees, industries] = await Promise.all([
      context.get(`${base}/v1/partner/references/state-fees?entityType=LLC`, headers),
      context.get(`${base}/v1/partner/references/naics-codes`, headers),
    ]);
    return {
      fees: rows(payload(fees)).filter(f => ['WY', 'DE'].includes(f.state)).map(f => {
        const amount = minor(f.priceInCents);
        if (amount < 0) throw new BadGatewayException('주정부 수수료를 확인하지 못했습니다.');
        return { state: f.state as string, price_in_cents: amount };
      }),
      industries: [...new Set<string>(rows(payload(industries)).map(i => i.industry).filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 250))].sort(),
    };
  },
  prepare(input, references) {
    const result = inputSchema.safeParse(input);
    if (!result.success) throw new BadRequestException(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; '));
    const v = result.data;
    if (!references.industries.includes(v.industry) || !references.fees.some(f => f.state === v.state)) throw new BadRequestException('doola에서 확인된 업종과 설립 주를 선택하세요.');
    const person = { legalFirstName: v.first_name, legalLastName: v.last_name, address: v.address };
    return {
      customer: { email: v.email, firstName: v.first_name, lastName: v.last_name, countryOfResidence: v.address.country, phoneNumber: v.address.phone },
      company: { entityType: 'LLC', state: v.state, nameOptions: [{ name: v.name, entityTypeEnding: 'LLC' }], industry: v.industry, description: v.description,
        responsibleParty: { ...person, email: v.email }, members: [{ ...person, isNaturalPerson: true, ownershipPercent: 100 }],
        addresses: [{ type: 'mailing', provider: 'customer', address: v.address }, { type: 'business', provider: 'registeredAgent' }],
      },
      summary: { name: `${v.name} LLC`, state: v.state, entity_type: 'LLC', industry: v.industry },
    };
  },
  async customer(context, input, key) {
    const { base, headers } = api(context);
    const result = payload(await context.post(`${base}/v1/partner/customers`, { ...headers, 'Idempotency-Key': key }, input));
    if (typeof result.doolaCustomerId !== 'string') throw new BadGatewayException('doola 고객 ID를 확인하지 못했습니다.');
    return externalId(result.doolaCustomerId);
  },
  async submit(context, input, customerId, key) {
    const { base, headers } = api(context);
    const result = payload(await context.post(`${base}/v1/partner/companies`, { ...headers, 'Idempotency-Key': key }, { ...input, doolaCustomerId: customerId }));
    if (typeof result.doolaCompanyId !== 'string' || typeof result.formationSubmissionStatus !== 'string') throw new BadGatewayException('doola 제출 결과를 확인하지 못했습니다.');
    return { id: externalId(result.doolaCompanyId), status: text(result.formationSubmissionStatus) };
  },
  async signature(context, companyId, documentType) {
    const { base, headers } = api(context);
    const result = payload(await context.post(`${base}/v1/partner/companies/${externalId(companyId)}/signatures`, headers, { documentType }));
    let url: URL;
    try { url = new URL(result.url); } catch { throw new BadGatewayException('서명 주소를 확인하지 못했습니다.'); }
    // This link comes only from the authenticated provider, is never fetched by AWB, and never persisted.
    if (url.protocol !== 'https:' || url.username || url.password) throw new BadGatewayException('서명 주소를 확인하지 못했습니다.');
    return { url: url.href, expires_at: text(result.expiresAt) };
  },
};
