import { BadGatewayException } from '@nestjs/common';
import { z } from 'zod';
import type { TrademarkConnector, TrademarkSourceRecord } from './trademark-connector';
import { bearer, id, list, nextPage, parseConfig, text } from './trademark-http';

const regions: Record<string, string> = { us: 'https://app.clio.com', eu: 'https://eu.app.clio.com', ca: 'https://ca.app.clio.com', au: 'https://au.app.clio.com' };
export const trademarkClio: TrademarkConnector = {
  descriptor: { id: 'clio', name: 'Clio Manage', icon: 'workflow', auth: 'oauth', credential_provider: 'clio_oauth', secret_fields: ['client_id', 'client_secret'],
    capabilities: ['사건 상태', '문서 목록', '일정·기한·커뮤니케이션'],
    fields: [{ key: 'region', label: '로펌 계정 지역', options: ['us', 'eu', 'ca', 'au'] }, { key: 'matter_id', label: '로펌이 공유한 사건 ID' }],
    setup: 'Clio Manage 앱에 callback URL을 등록하고 로펌 계정으로 승인받으세요. Matters·Documents·Calendars·Communications·Profile 읽기 권한을 앱에 설정합니다. 지정한 사건만 수집합니다. 기한은 로펌 원본 일정과 확인하세요.',
    docs_url: 'https://docs.developers.clio.com/clio-manage/api-reference/' },
  config: value => parseConfig(z.object({ region: z.enum(['us', 'eu', 'ca', 'au']).default('us'), matter_id: z.string().regex(/^\d{1,20}$/) }).strict(), value),
  oauth: {
    endpoints: config => ({ authorize: `${regions[config.region]}/oauth/authorize`, token: `${regions[config.region]}/oauth/token`, scope: '', pkce: false }),
    async identify(context) {
      const row = await context.request(`${regions[context.data.config.region]}/api/v4/users/who_am_i.json?fields=id,name,email`, { headers: bearer(context.data.tokens?.access_token) });
      return { id: id(row.data?.id), name: text(row.data.name), email: text(row.data.email), region: context.data.config.region };
    },
  },
  async sync(context) {
    const origin = regions[context.data.config.region]; const matterId = context.data.config.matter_id; const headers = bearer(context.data.tokens?.access_token);
    const matter = await context.request(`${origin}/api/v4/matters/${matterId}.json?fields=id,display_number,description,status,open_date,close_date`, { headers });
    if (String(matter.data?.id) !== matterId) throw new BadGatewayException('Clio 사건 ID가 일치하지 않습니다.');
    const records: TrademarkSourceRecord[] = [{ source_id: `matter:${matterId}`, kind: 'matter', title: text(matter.data.display_number), text: text(matter.data.description, 10_000), status: text(matter.data.status), url: origin }];
    let limited = false;
    for (const source of [
      { resource: 'documents', fields: 'id,name,updated_at,matter{id}', kind: 'document' as const },
      { resource: 'calendar_entries', fields: 'id,summary,description,start_at,end_at,matter{id}', kind: 'deadline' as const },
      { resource: 'communications', fields: 'id,subject,body,date,type,matter{id}', kind: 'email' as const },
    ]) {
      const path = `/api/v4/${source.resource}.json`;
      let url: string | null = `${origin}${path}?${new URLSearchParams({ matter_id: matterId, fields: source.fields, limit: '100' })}`; let pages = 0;
      while (url && pages++ < 3) {
        const response = await context.request(url, { headers });
        for (const row of list(response.data)) {
          if (String(row.matter?.id) !== matterId) throw new BadGatewayException('지정한 Clio 사건 외 데이터가 반환되었습니다.');
          records.push({ source_id: `${source.resource}:${id(row.id)}`, kind: source.kind, title: text(row.name || row.summary || row.subject), status: text(row.type) || 'synced',
            date: text(row.start_at || row.date || row.updated_at), text: text(row.description || row.body, 100_000), url: origin, details: { matter_id: matterId, end_at: text(row.end_at) } });
        }
        url = nextPage(response.meta?.paging?.next, origin, path);
      }
      limited ||= !!url;
    }
    return { records, summary: `사건 ${text(matter.data.display_number)} · 문서·일정·커뮤니케이션별 최대 300건${limited ? ' · 전체 내역은 Clio에서 확인' : ''}` };
  },
};
