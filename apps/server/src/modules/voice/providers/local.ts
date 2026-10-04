import type { VoiceConfig } from '../voice-config';
import { audioBlob, audioFileName } from './audio-file';
import type { SttProvider, TtsProvider, VoiceOption } from './types';
import { upstreamFailure } from './types';

/**
 * 셀프호스팅 음성 서버(docs/voice-operator.md "셀프호스팅 엔진") — 기본은 ragnar 의 `awb-voice-server`.
 *
 * 그 서버는 OpenAI 오디오 API 의 모양을 따르고(그래서 다른 OpenAI 호환 서버로도 바꿔 끼울 수 있다),
 * 목소리 목록을 더 준다:
 *   POST {base}/audio/transcriptions  multipart: file, [model], [language], [prompt] → { text }
 *   POST {base}/audio/speech          { input, [model], voice, response_format } → 오디오 바이트
 *   GET  {base}/audio/voices          → { voices: [{ id, name, language?, gender? }], default? }
 * 인증은 `Authorization: Bearer <voice.local.api_key>`(키를 비워 두면 보내지 않는다).
 *
 * OpenAI 클라우드 어댑터(`openai.ts`)와 따로 둔 이유: 둘을 동시에 설정해 두고 Voice lab 에서 나란히
 * 비교하려면 주소·키가 서로 달라야 한다.
 */

function headers(config: VoiceConfig): Record<string, string> {
  return config.keys.local ? { Authorization: `Bearer ${config.keys.local}` } : {};
}

const missing = (config: VoiceConfig) =>
  (config.localBaseUrl ? null : 'Self-hosted voice server URL is not set (voice.local.base_url).');

/** 모델 이름을 비워 두면 서버의 기본 모델을 쓴다 — 서버가 무엇을 띄웠는지는 서버가 안다. */
export const LOCAL_DEFAULT_VOICE = 'default';

export const localStt: SttProvider = {
  id: 'local',
  defaultModel: '',
  missing,

  async transcribe(input, ctx) {
    const form = new FormData();
    form.append('file', audioBlob(input.audio, input.mimeType), audioFileName(input.mimeType));
    if (input.model) form.append('model', input.model);
    // 한 언어만 받는 모델이 많다 — 첫 언어를 주 언어로 둔다(섞어 쓴 영어 용어는 prompt 의 용어집이 돕는다).
    if (input.languages.length) form.append('language', input.languages[0]);
    if (input.terms.length) form.append('prompt', `${input.terms.join(', ')}.`);
    form.append('response_format', 'json');
    const res = await ctx.fetch(`${ctx.config.localBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: headers(ctx.config),
      body: form,
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('local', res);
    const body = await res.json();
    return typeof body?.text === 'string' ? body.text : '';
  },
};

export const localTts: TtsProvider = {
  id: 'local',
  defaultModel: '',
  defaultVoice: LOCAL_DEFAULT_VOICE,
  missing,

  async synthesize(input, ctx) {
    const body: Record<string, unknown> = { input: input.text, voice: input.voice, response_format: 'mp3' };
    if (input.model) body.model = input.model;
    if (input.languages.length) body.language = input.languages[0];
    const res = await ctx.fetch(`${ctx.config.localBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: { ...headers(ctx.config), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('local', res);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  },

  async listVoices(_languages, ctx) {
    const res = await ctx.fetch(`${ctx.config.localBaseUrl}/audio/voices`, { headers: headers(ctx.config), signal: ctx.signal });
    if (!res.ok) throw await upstreamFailure('local', res);
    const body = await res.json();
    const list = Array.isArray(body?.voices) ? body.voices : [];
    return list
      .map((v: any): VoiceOption => ({
        id: String(v?.id || ''),
        name: String(v?.name || v?.id || ''),
        language: v?.language ? String(v.language) : undefined,
        gender: v?.gender ? String(v.gender) : undefined,
      }))
      .filter((v: VoiceOption) => v.id);
  },
};
