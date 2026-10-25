import { BadGatewayException, BadRequestException } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { isBlockedAddress } from '../../../common/ssrf-guard';

/** Pin the checked address, including for SMTP/IMAP, so a second DNS lookup cannot rebind it. */
export async function resolveMailHost(value: string, resolve = lookup): Promise<{ address: string; host: string }> {
  const host = value.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || !/^[a-z0-9.:-]+$/.test(host)) throw new BadRequestException('메일 서버 주소를 확인하세요.');
  const allowed = (process.env.AWB_MAIL_PRIVATE_HOSTS || '').split(',').map(s => s.trim().toLowerCase());
  const records = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host, { all: true });
  if (!records.length || (!allowed.includes(host) && records.some(r => isBlockedAddress(r.address)))) {
    throw new BadRequestException('내부 메일 서버는 운영자가 AWB_MAIL_PRIVATE_HOSTS에 호스트를 등록해야 합니다.');
  }
  return { address: records[0].address, host };
}

export function mailUrl(value: string, origin?: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BadRequestException('JMAP HTTPS 주소를 확인하세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || (origin && url.origin !== origin)) {
    throw new BadRequestException('JMAP 주소와 API는 같은 HTTPS origin이어야 합니다.');
  }
  return url;
}

export async function mailJson(value: string, token: string, body?: unknown): Promise<any> {
  const url = mailUrl(value);
  const target = await resolveMailHost(url.hostname);
  if (!token || /[\r\n]/.test(token)) throw new BadRequestException('JMAP API 토큰을 등록하세요.');
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(url, {
      method: payload ? 'POST' : 'GET',
      lookup: ((_host: string, options: any, callback: any) => options.all
        ? callback(null, [{ address: target.address, family: isIP(target.address) }])
        : callback(null, target.address, isIP(target.address))) as any,
      signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json' } : {}) },
    }, response => {
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume(); reject(new BadGatewayException('메일 서버의 인증·주소·응답 상태를 확인하세요.')); return;
      }
      const chunks: Buffer[] = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 8_000_000) { response.destroy(new Error('Mail response too large')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new BadGatewayException('메일 서버 응답 형식을 확인하세요.')); } });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** JMAP EventSource with the same HTTPS/origin/DNS policy as JSON calls; bounded SSE frames. */
export async function mailEvents(value: string, token: string, signal: AbortSignal, onState: (state: any) => void, onReady: () => void): Promise<void> {
  const url = mailUrl(value); const target = await resolveMailHost(url.hostname);
  if (!token || /[\r\n]/.test(token)) throw new BadRequestException('JMAP API 토큰을 등록하세요.');
  if (signal.aborted) return;
  return new Promise((resolve, reject) => {
    const req = request(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(30 * 60_000)]),
      lookup: ((_host: string, options: any, callback: any) => options.all
        ? callback(null, [{ address: target.address, family: isIP(target.address) }])
        : callback(null, target.address, isIP(target.address))) as any,
      headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    }, response => {
      if (response.statusCode !== 200 || !response.headers['content-type']?.includes('text/event-stream')) {
        response.resume(); reject(new BadGatewayException('JMAP 실시간 수신을 지원하지 않는 응답입니다.')); return;
      }
      onReady(); response.setEncoding('utf8');
      let buffer = '';
      response.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 128_000) { response.destroy(new Error('JMAP event too large')); return; }
        let match: RegExpExecArray | null;
        while ((match = /\r?\n\r?\n/.exec(buffer))) {
          const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
          const lines = frame.split(/\r?\n/);
          const type = lines.find(l => l.startsWith('event:'))?.slice(6).trim();
          if (type !== 'state') continue;
          const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          try { onState(JSON.parse(data)); } catch { /* Ignore a malformed event; cursor polling repairs any gap. */ }
        }
      });
      response.on('error', reject); response.on('end', resolve);
      response.on('close', resolve);
    });
    req.on('error', reject); req.end();
  });
}
