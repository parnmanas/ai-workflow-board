import type { SttProviderId, TtsProviderId, VoiceConfig } from '../voice-config';

/**
 * 음성 공급자 계약(docs/voice-operator.md "공급자 인터페이스").
 *
 * 공급자 파일은 HTTP 모양만 안다 — 어느 공급자를 쓸지, 키가 있는지, 실패를 어떻게 보여 줄지는
 * VoiceService 가 정한다. `fetch` 를 주입받아 테스트가 실제 네트워크 없이 요청 모양을 고정한다.
 */

export interface ProviderContext {
  config: VoiceConfig;
  fetch: typeof fetch;
  /** 실시간 API 를 쓰는 공급자용(Soniox). 테스트가 가짜를 끼운다. */
  WebSocket?: typeof WebSocket;
  signal?: AbortSignal;
}

export interface SttInput {
  audio: Buffer;
  /** 녹음 형식 그대로(`audio/webm;codecs=opus`, `audio/mp4` …). */
  mimeType: string;
  model: string;
  /** ISO 639-1 힌트. 비어 있으면 공급자가 언어를 알아서 판정한다. */
  languages: string[];
  /** 인식기가 기대해야 할 어휘(제품·호스트 이름 등). */
  terms: string[];
}

export interface SttProvider {
  id: SttProviderId;
  defaultModel: string;
  /** 키·지역 같은 필수 설정이 빠졌으면 사유, 아니면 null. */
  missing(config: VoiceConfig): string | null;
  transcribe(input: SttInput, ctx: ProviderContext): Promise<string>;
}

export interface TtsInput {
  text: string;
  model: string;
  voice: string;
  languages: string[];
}

export interface TtsOutput {
  audio: Buffer;
  contentType: string;
}

export interface VoiceOption {
  id: string;
  name: string;
  /** 공급자가 알려 준 언어/로캘(있을 때만). */
  language?: string;
  gender?: string;
  preview_url?: string;
}

export interface TtsProvider {
  id: TtsProviderId;
  defaultModel: string;
  /**
   * 목소리를 정하지 않았을 때 쓸 기본값. 비어 있으면 voice 설정이 필수다 — 언어마다 고를 목소리가
   * 다른 공급자에 우리가 고른 목록을 박아 두지 않는다(낡은 목록이 실패를 가린다). 고르는 일은
   * Admin → Voice 가 공급자의 목소리 목록(listVoices)으로 돕는다.
   */
  defaultVoice: string;
  missing(config: VoiceConfig): string | null;
  synthesize(input: TtsInput, ctx: ProviderContext): Promise<TtsOutput>;
  /** 공급자 API 가 알려 주는 목소리. `languages` 로 거를 수 있으면 거른다. 목록 API 가 없으면 생략. */
  listVoices?(languages: string[], ctx: ProviderContext): Promise<VoiceOption[]>;
}

/** 공급자가 돌려준 실패. 상태 코드와 공급자 메시지를 그대로 싣는다 — 운영자가 키·쿼터 문제를 바로 알아보게. */
export class VoiceProviderError extends Error {
  constructor(
    readonly provider: string,
    readonly upstreamStatus: number,
    message: string,
  ) {
    super(message);
    this.name = 'VoiceProviderError';
  }
}

/** 실패 응답 본문에서 사람이 읽을 사유를 꺼낸다(공급자마다 모양이 다르다). */
export async function upstreamFailure(provider: string, res: Response): Promise<VoiceProviderError> {
  const raw = await res.text().catch(() => '');
  let detail = raw;
  try {
    const body = JSON.parse(raw);
    detail = body?.detail?.message || body?.detail?.status || (typeof body?.detail === 'string' ? body.detail : '')
      || body?.error?.message || (typeof body?.error === 'string' ? body.error : '')
      || body?.message || body?.error_message || raw;
  } catch { /* plain text */ }
  const trimmed = String(detail || res.statusText || 'request failed').slice(0, 300);
  return new VoiceProviderError(provider, res.status, `${provider} ${res.status}: ${trimmed}`);
}
