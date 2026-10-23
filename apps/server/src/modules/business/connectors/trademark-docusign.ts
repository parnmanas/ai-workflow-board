import { BadGatewayException, BadRequestException, ConflictException } from '@nestjs/common';
import { z } from 'zod';
import type { TrademarkConnector, TrademarkConnectorContext, TrademarkSourceRecord } from './trademark-connector';
import { bearer, digest, id, list, parseConfig, providerUrl, text } from './trademark-http';

const uuid = z.string().uuid();
export const contractActionSchema = z.object({
  subject: z.string().trim().min(1).max(100).regex(/^[^\r\n]+$/),
  roles: z.array(z.object({ role: z.string().min(1).max(100), name: z.string().trim().min(1).max(100), email: z.email().max(254) })).min(1).max(10),
}).strict();
function base(context: TrademarkConnectorContext): string {
  const identity = context.data.identity;
  if (!identity?.base_uri || !identity.account_id) throw new BadRequestException('DocuSign 계정을 연결하세요.');
  const url = providerUrl(identity.base_uri);
  if (!/\.docusign\.net$/.test(url.hostname) || url.pathname !== '/') throw new BadRequestException('DocuSign API 주소를 확인하세요.');
  return `${url.origin}/restapi/v2.1/accounts/${encodeURIComponent(identity.account_id)}`;
}
async function template(context: TrademarkConnectorContext, withDocuments: boolean) {
  const root = `${base(context)}/templates/${context.data.config.template_id}`;
  const headers = bearer(context.data.tokens?.access_token);
  const metadata = await context.request(root, { headers });
  const recipients = await context.request(`${root}/recipients`, { headers });
  const listing = await context.request(`${root}/documents`, { headers });
  if (metadata.templateId !== context.data.config.template_id) throw new BadGatewayException('계약 템플릿이 일치하지 않습니다.');
  const signers = list(recipients.signers || []); const copies = list(recipients.carbonCopies || []);
  for (const kind of Object.keys(recipients).filter(key => !['signers', 'carbonCopies'].includes(key))) {
    if (Array.isArray(recipients[kind]) && recipients[kind].length) throw new BadRequestException('서명자·참조인 역할로 구성된 템플릿을 사용하세요. 다른 수신자 유형은 DocuSign에서 진행하세요.');
  }
  const roles = [...signers, ...copies].map(row => ({ role: text(row.roleName), name: text(row.name), email: text(row.email), routing_order: text(row.routingOrder), type: signers.includes(row) ? 'signer' : 'copy' }));
  if ([...signers, ...copies].some(row => row.clientUserId || (row.deliveryMethod && row.deliveryMethod !== 'Email'))) throw new BadRequestException('이 커넥터는 이메일로 전달하는 원격 서명 템플릿을 지원합니다.');
  if (!roles.length || roles.length > 10 || roles.some(r => !r.role) || new Set(roles.map(r => r.role)).size !== roles.length) throw new BadRequestException('모든 수신자에 서로 다른 역할 이름이 있는 템플릿을 사용하세요.');
  const docs = list(listing.templateDocuments || listing.envelopeDocuments);
  if (!docs.length || docs.length > 5) throw new BadRequestException('문서 1~5개로 구성된 계약 템플릿을 사용하세요.');
  const documents: Array<{ name: string; pdf: string }> = []; let bytes = 0;
  if (withDocuments) for (const doc of docs) {
    const pdf = await context.request(`${root}/documents/${encodeURIComponent(id(doc.documentId))}`, { headers, response: 'pdf' }) as Buffer;
    bytes += pdf.length; if (bytes > 8_000_000) throw new BadRequestException('계약 문서 합계는 최대 8MB입니다.');
    documents.push({ name: text(doc.name, 200) || '계약서.pdf', pdf: pdf.toString('base64') });
  }
  const fingerprint = digest(JSON.stringify({ metadata, recipients, listing, documents: documents.map(doc => digest(doc.pdf)) }));
  return { roles, documents, fingerprint, name: text(metadata.name), modified_at: text(metadata.lastModifiedDateTime) };
}
function record(row: any): TrademarkSourceRecord {
  return { source_id: id(row.envelopeId), kind: 'contract', title: text(row.emailSubject) || '서명 요청', status: text(row.status),
    date: text(row.statusChangedDateTime), details: { envelope_id: id(row.envelopeId), completed_at: text(row.completedDateTime) } };
}
export const trademarkDocusign: TrademarkConnector = {
  descriptor: { id: 'docusign', name: 'DocuSign', icon: 'lock', auth: 'oauth', credential_provider: 'docusign_oauth', secret_fields: ['client_id', 'client_secret', 'hmac_secret'], action: 'contract', webhook: 'docusign',
    capabilities: ['템플릿·문서 검토', '서명 요청 발송', '완료 웹훅·서명본 다운로드'],
    fields: [{ key: 'environment', label: '환경', options: ['sandbox', 'live'] }, { key: 'account_id', label: 'DocuSign 계정 ID · 선택', placeholder: '비우면 기본 계정' }, { key: 'template_id', label: '수임계약 템플릿 UUID' }],
    setup: 'Developer 앱에 callback URL을 등록하세요. signature·extended 동의와 운영 API 승인이 필요합니다. 합의한 템플릿의 모든 서명자·참조인 역할을 지정합니다. Connect는 JSON SIM 형식과 HMAC 서명을 켜고 표시된 웹훅 URL을 등록하세요.',
    docs_url: 'https://developers.docusign.com/docs/esign-rest-api/how-to/request-signature-template-remote/' },
  config: value => parseConfig(z.object({ environment: z.enum(['sandbox', 'live']).default('sandbox'), account_id: z.union([z.literal(''), uuid]).default(''), template_id: uuid }).strict(), value),
  oauth: {
    endpoints: config => { const host = config.environment === 'sandbox' ? 'https://account-d.docusign.com' : 'https://account.docusign.com'; return { authorize: `${host}/oauth/auth`, token: `${host}/oauth/token`, scope: 'signature extended', pkce: false, basic: true }; },
    async identify(context) {
      const host = context.data.config.environment === 'sandbox' ? 'https://account-d.docusign.com' : 'https://account.docusign.com';
      const info = await context.request(`${host}/oauth/userinfo`, { headers: bearer(context.data.tokens?.access_token) });
      const account = list(info.accounts).find(row => context.data.config.account_id ? row.account_id === context.data.config.account_id : row.is_default === true || row.is_default === 'true');
      if (!account) throw new BadRequestException('허용된 DocuSign 계정을 선택하지 못했습니다. 계정 ID를 지정하세요.');
      const url = providerUrl(id(account.base_uri));
      if (!/\.docusign\.net$/.test(url.hostname) || url.pathname !== '/') throw new BadGatewayException('DocuSign 계정 API 주소를 확인하지 못했습니다.');
      if ((context.data.config.environment === 'sandbox') !== (url.hostname === 'demo.docusign.net')) throw new BadRequestException('DocuSign 환경이 선택한 계정과 다릅니다.');
      return { account_id: id(account.account_id), base_uri: url.origin, email: text(info.email), name: text(account.account_name) };
    },
  },
  async options(context) { const source = await template(context, false); return { name: source.name, roles: source.roles }; },
  async sync(context) {
    if (!context.external_ids.length) return { records: [], summary: '서명 요청을 발송하면 계약 진행과 완료 상태를 자동 수집합니다.' };
    const query = new URLSearchParams({ envelope_ids: context.external_ids.slice(-100).join(',') });
    const response = await context.request(`${base(context)}/envelopes?${query}`, { headers: bearer(context.data.tokens?.access_token) });
    const rows = list(response.envelopes || (response.resultSetSize === '0' ? [] : undefined));
    if (rows.some(row => !context.external_ids.includes(row.envelopeId))) throw new BadGatewayException('연결된 계약 외 데이터가 반환되었습니다.');
    return { records: rows.map(record), summary: `${rows.length}개 서명 요청 상태 확인 · 본인 서명은 DocuSign에서 진행` };
  },
  async prepare(context, input, actionId) {
    const p = parseConfig(contractActionSchema, input);
    const source = await template(context, true);
    if (source.roles.length !== p.roles.length || new Set(p.roles.map(r => r.role)).size !== p.roles.length || source.roles.some(r => !p.roles.find(p => p.role === r.role))) throw new BadRequestException('템플릿의 모든 서명자·참조인 역할을 한 번씩 지정하세요.');
    return { review: { subject: p.subject, roles: p.roles, template_name: source.name, template_id: context.data.config.template_id, documents: source.documents.map(doc => doc.name) },
      request: { templateId: context.data.config.template_id, emailSubject: p.subject, templateRoles: p.roles.map(r => ({ roleName: r.role, name: r.name, email: r.email })), status: 'sent', transactionId: actionId },
      documents: source.documents, fingerprint: source.fingerprint };
  },
  async verify(context, prepared) {
    if ((await template(context, true)).fingerprint !== prepared.fingerprint) throw new ConflictException('검토 이후 계약 템플릿·문서·수신자 설정이 바뀌었습니다. 새로 검토하세요.');
  },
  async execute(context, prepared) {
    const row = await context.request(`${base(context)}/envelopes`, { method: 'POST', headers: bearer(context.data.tokens?.access_token), json: prepared.request });
    return { id: id(row.envelopeId), status: text(row.status) || 'sent' };
  },
  async reconcile(context, prepared, actionId, externalId) {
    let envelopeId = externalId;
    if (!envelopeId) {
      const response = await context.request(`${base(context)}/envelopes?${new URLSearchParams({ transaction_ids: actionId })}`, { headers: bearer(context.data.tokens?.access_token) });
      const rows = list(response.envelopes || []);
      if (rows.length !== 1) throw new ConflictException('이 요청의 계약 한 건을 확인하지 못했습니다. DocuSign의 envelope ID로 대조하세요. 자동 재발송하지 않습니다.');
      envelopeId = id(rows[0].envelopeId);
    }
    const row = await context.request(`${base(context)}/envelopes/${encodeURIComponent(id(envelopeId))}`, { headers: bearer(context.data.tokens?.access_token) });
    if (row.transactionId !== actionId || row.emailSubject !== prepared.request.emailSubject) throw new ConflictException('검토한 계약 요청과 일치하지 않습니다.');
    return { id: id(row.envelopeId), status: text(row.status) };
  },
  async document(context, externalId) {
    if (!context.external_ids.includes(externalId)) throw new BadRequestException('연결된 계약을 선택하세요.');
    const url = `${base(context)}/envelopes/${encodeURIComponent(id(externalId))}`;
    const envelope = await context.request(url, { headers: bearer(context.data.tokens?.access_token) });
    if (envelope.status !== 'completed') throw new ConflictException('모든 서명이 완료된 뒤 서명본을 다운로드할 수 있습니다.');
    return context.request(`${url}/documents/combined?certificate=true`, { headers: bearer(context.data.tokens?.access_token), response: 'pdf' });
  },
};
