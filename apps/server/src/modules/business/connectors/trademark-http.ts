import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { TrademarkHttpOptions } from './trademark-connector';

const HOSTS = new Set(['api.resend.com', 'gmail.googleapis.com', 'oauth2.googleapis.com', 'graph.microsoft.com', 'login.microsoftonline.com',
  'account.docusign.com', 'account-d.docusign.com', 'app.clio.com', 'eu.app.clio.com', 'ca.app.clio.com', 'au.app.clio.com', 'tsdrapi.uspto.gov']);
export function providerUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash ||
    (!HOSTS.has(url.hostname) && !/^(demo|www|na\d*|eu\d*|au\d*|ca\d*)\.docusign\.net$/.test(url.hostname))) {
    throw new BadRequestException('허용된 공급자 API 주소가 아닙니다.');
  }
  return url;
}
export async function trademarkRequest(value: string, options: TrademarkHttpOptions = {}): Promise<any> {
  const url = providerUrl(value);
  const headers: Record<string, string> = { Accept: options.response === 'pdf' ? 'application/pdf' : options.response === 'text' ? 'application/xml' : 'application/json', ...options.headers };
  let body: string | undefined;
  if (options.json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(options.json); }
  if (options.form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(options.form).toString(); }
  let response: Response;
  try { response = await fetch(url.toString(), { method: options.method || 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(15_000) }); }
  catch { throw new BadGatewayException('외부 서비스 응답을 확인하지 못했습니다. 연결 기록에서 다시 확인하세요.'); }
  if (!response.ok) { await response.body?.cancel(); throw new BadGatewayException(`외부 서비스 응답 ${response.status}. 연결 권한·유효기간·호출 한도를 확인하세요.`); }
  if (options.response === 'empty') { await response.body?.cancel(); return null; }
  const reader = response.body?.getReader();
  if (!reader) throw new BadGatewayException('외부 서비스가 빈 응답을 반환했습니다.');
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value: chunk } = await reader.read(); if (done) break;
      size += chunk.length; if (size > (options.response === 'pdf' ? 8_000_000 : 2_000_000)) throw new Error('size');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (options.response === 'pdf') { if (!data.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('pdf'); return data; }
    if (options.response === 'text') return data.toString('utf8');
    return JSON.parse(data.toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new BadGatewayException('공급자 응답의 형식 또는 크기를 확인하세요.'); }
}
export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const bearer = (token?: string) => {
  if (!token || /\s/.test(token)) throw new BadRequestException('서비스 로그인을 연결하세요.');
  return { Authorization: `Bearer ${token}` };
};
export const id = (value: unknown): string => {
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value) || String(value).length > 500 || /[\r\n]/.test(String(value))) throw new BadGatewayException('외부 식별자를 확인하지 못했습니다.');
  return String(value);
};
export const list = (value: unknown): any[] => { if (!Array.isArray(value)) throw new BadGatewayException('공급자 목록 형식을 확인하지 못했습니다.'); return value; };
export const text = (value: unknown, max = 1000) => typeof value === 'string' ? value.slice(0, max) : '';
export const parseConfig = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) throw new BadRequestException('연결 설정과 입력 값을 확인하세요.'); return result.data;
};
export function nextPage(value: unknown, origin: string, path: string): string | null {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 8000) throw new BadGatewayException('다음 페이지 주소를 확인하지 못했습니다.');
  const url = providerUrl(value);
  if (url.origin !== origin || url.pathname !== path) throw new BadGatewayException('목록의 다음 페이지가 현재 서비스 경로와 다릅니다.');
  return url.toString();
}
