import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import type { TrademarkConnector, TrademarkSourceRecord } from './trademark-connector';
import { digest, list, parseConfig, text } from './trademark-http';

function xml(value: string): any {
  if (typeof value !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(value) || XMLValidator.validate(value) !== true) throw new BadGatewayException('USPTO XML 응답을 확인하지 못했습니다.');
  return new XMLParser({ removeNSPrefix: true, parseTagValue: false, ignoreAttributes: true, processEntities: false }).parse(value);
}
function values(node: any, names: string[], depth = 0): any[] {
  if (!node || typeof node !== 'object' || depth > 40) return [];
  const found: any[] = [];
  for (const [key, value] of Object.entries(node)) {
    if (names.includes(key.replace(/[-_]/g, '').toLowerCase())) found.push(...(Array.isArray(value) ? value : [value]));
    if (typeof value === 'object') found.push(...(Array.isArray(value) ? value.flatMap(v => values(v, names, depth + 1)) : values(value, names, depth + 1)));
    if (found.length > 1000) return found.slice(0, 1000);
  }
  return found;
}
const value = (node: any, names: string[]) => text(values(node, names).find(v => typeof v === 'string'), 3000);
export const trademarkTsdr: TrademarkConnector = {
  descriptor: { id: 'uspto_tsdr', name: 'USPTO · TSDR', icon: 'trademark', auth: 'api_key', credential_provider: 'uspto_tsdr', secret_fields: ['api_key'],
    capabilities: ['공식 사건 상태', '접수·심사 문서 목록', '변경 시각 자동 확인'], fields: [],
    setup: 'USPTO API Key Manager에서 TSDR 키를 발급받으세요. 상표 기록의 8자리 출원번호로 조회합니다. 접수·상태·문서 데이터만 읽으며 공식 출원 제출과 기한의 법률 판단은 별도입니다.',
    docs_url: 'https://www.uspto.gov/trademarks/apply/check-status-view-documents/trademark-bulk-data' },
  config: value => parseConfig(z.object({}).strict(), value),
  async sync(context) {
    const serial = context.trademark.serial_number;
    if (!/^\d{8}$/.test(serial)) throw new BadRequestException('상표 기록에 실제 8자리 출원번호를 입력하세요.');
    const headers = { 'USPTO-API-KEY': context.secrets.api_key };
    if (!headers['USPTO-API-KEY'] || /\s/.test(headers['USPTO-API-KEY'])) throw new BadRequestException('USPTO API 키를 확인하세요.');
    const update = await context.request(`https://tsdrapi.uspto.gov/last-update/info.json?sn=${serial}`, { headers });
    const updates = list(update.caseUpdateInfo);
    const current = updates.find(row => row.serialNumber === serial);
    if (!current) throw new BadGatewayException('USPTO 응답의 출원번호가 일치하지 않습니다.');
    const status = xml(await context.request(`https://tsdrapi.uspto.gov/ts/cd/casestatus/sn${serial}/info.xml`, { headers, response: 'text' }));
    const documents = xml(await context.request(`https://tsdrapi.uspto.gov/ts/cd/casedocs/bundle.xml?sn=${serial}`, { headers, response: 'text' }));
    const returnedSerial = value(status, ['applicationnumbertext', 'serialnumber', 'usapplicationnumber']);
    if (returnedSerial && returnedSerial !== serial) throw new BadGatewayException('USPTO 상태의 출원번호가 일치하지 않습니다.');
    const url = `https://tsdr.uspto.gov/#caseNumber=${serial}&caseSearchType=US_APPLICATION&caseType=DEFAULT&searchType=statusSearch`;
    const statusText = value(status, ['markcurrentstatustext', 'trademarkstatustext', 'statusdescription', 'statusdescriptiontext']);
    const statusCode = value(status, ['markcurrentstatuscode', 'statuscode']);
    const records: TrademarkSourceRecord[] = [{ source_id: `status:${serial}`, kind: 'status', title: value(status, ['markverbalelementtext', 'markverbalelement', 'markelementtext', 'markidentification']) || context.trademark.mark,
      status: statusText || statusCode || '공식 상태 원문 확인', text: statusText, url,
      date: text(current.caseData?.caseStatusData?.lastModifiedDate || current.caseData?.caseProsecutionData?.lastModifiedDate || current.caseData?.lastModifiedDate),
      details: { serial_number: serial, status_code: statusCode, registration_number: value(status, ['registrationnumber']), filing_date: value(status, ['applicationdate', 'filingdate']) } }];
    for (const doc of values(documents, ['document', 'documentdata', 'casedocument']).slice(-200)) {
      if (!doc || typeof doc !== 'object') continue;
      const title = value(doc, ['documentdescription', 'documentdescriptiontext', 'documenttype', 'documenttitle', 'description']);
      if (!title) continue;
      const documentId = value(doc, ['documentid', 'documentidentifier']);
      records.push({ source_id: `document:${documentId || digest(JSON.stringify(doc))}`, kind: 'document', title, status: 'USPTO', url,
        date: value(doc, ['mailroomdate', 'documentdate', 'createdate']), details: { serial_number: serial, document_id: documentId } });
    }
    return { records, summary: `출원 ${serial} · 공식 상태·문서 조회 완료 · 기한은 통지서·변호사 확인 기준` };
  },
};
