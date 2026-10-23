import { BadGatewayException, BadRequestException } from '@nestjs/common';

/** Only adapter-owned HTTPS URLs reach this transport; config cannot supply a host or headers. */
export function connectorGet(url: string, headers: Record<string, string>): Promise<any> {
  return connectorRequest('GET', url, headers);
}

/** Mutation adapters supply fixed URLs, reviewed bodies and persisted idempotency keys. No automatic retry. */
export function connectorPost(url: string, headers: Record<string, string>, body: unknown): Promise<any> {
  return connectorRequest('POST', url, headers, body);
}

async function connectorRequest(method: 'GET' | 'POST', url: string, headers: Record<string, string>, body?: unknown): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, { method, headers: { Accept: 'application/json', ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal: AbortSignal.timeout(15_000) });
  } catch {
    throw new BadGatewayException('서비스에 연결하지 못했습니다. 네트워크 상태를 확인하고 다시 동기화하세요.');
  }
  if (!response.ok) {
    await response.body?.cancel();
    // Do not relay a provider body, URL or headers: they can echo credentials or personal data.
    const hint = response.status === 401 || response.status === 403 ? '키의 유효기간과 조회 권한을 확인하세요.'
      : response.status === 429 ? '호출 한도에 도달했습니다. 잠시 후 다시 시도하세요.'
      : response.status === 404 ? '연결한 외부 ID와 환경을 확인하세요.' : '잠시 후 다시 시도하세요.';
    throw new BadGatewayException(`외부 서비스 응답 ${response.status}. ${hint}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new BadGatewayException('서비스가 빈 응답을 반환했습니다.');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw new Error('response_too_large');
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    await reader.cancel().catch(() => {});
    throw new BadGatewayException('서비스 응답을 읽지 못했습니다. 이전 조회 데이터는 유지됩니다.');
  }
}

export function rows(value: unknown): any[] {
  if (!Array.isArray(value)) throw new BadGatewayException('서비스 응답 형식이 변경되었습니다. 커넥터를 확인하세요.');
  return value;
}
export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new BadGatewayException('서비스의 수치 데이터를 확인하지 못했습니다.');
  return value;
}
export function minor(value: unknown): number {
  const n = number(value);
  if (!Number.isSafeInteger(n)) throw new BadGatewayException('서비스의 금액 단위를 확인하지 못했습니다.');
  return n;
}
export function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 200) : fallback;
}
export function externalId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(value)) throw new BadRequestException('외부 ID에는 영문, 숫자, -와 _만 사용할 수 있습니다.');
  return value;
}
