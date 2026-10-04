import type { TtsProvider, VoiceOption } from './types';
import { upstreamFailure } from './types';

/**
 * Typecast TTS — 한국어 특화 후보. 동기 응답(본문이 곧 오디오)이다.
 * https://typecast.ai/docs/api-reference/text-to-speech/text-to-speech
 */

const BASE = 'https://api.typecast.ai';

/** Typecast 는 언어를 ISO 639-3 로 받는다. 모르는 것은 보내지 않는다(자동 판정). */
const ISO_639_3: Record<string, string> = { ko: 'kor', en: 'eng', ja: 'jpn', zh: 'zho' };

export const typecastTts: TtsProvider = {
  id: 'typecast',
  defaultModel: 'ssfm-v30',
  defaultVoice: '',
  missing: (config) => (config.keys.typecast ? null : 'Typecast API key is not set (voice.typecast.api_key).'),

  async synthesize(input, ctx) {
    const body: Record<string, unknown> = {
      voice_id: input.voice,
      text: input.text,
      model: input.model,
      output: { audio_format: 'mp3' },
    };
    // 섞어 쓴 문장에서 한 언어로 강제하면 다른 언어 단어 발음이 무너진다 — 언어가 하나일 때만 준다.
    const language = input.languages.length === 1 ? ISO_639_3[input.languages[0]] : undefined;
    if (language) body.language = language;
    const res = await ctx.fetch(`${BASE}/v1/text-to-speech`, {
      method: 'POST',
      headers: { 'X-API-KEY': ctx.config.keys.typecast, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('typecast', res);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  },

  async listVoices(_languages, ctx) {
    const res = await ctx.fetch(`${BASE}/v3/voices?model=ssfm-v30`, {
      headers: { 'X-API-KEY': ctx.config.keys.typecast },
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('typecast', res);
    const body = await res.json();
    const list = Array.isArray(body) ? body : Array.isArray(body?.voices) ? body.voices : [];
    return list
      .map((v: any): VoiceOption => ({
        id: String(v?.voice_id || ''),
        name: String(v?.voice_name?.kor || v?.voice_name?.eng || v?.voice_id || ''),
        gender: v?.gender ? String(v.gender) : undefined,
        preview_url: v?.preview_url ? String(v.preview_url) : undefined,
      }))
      .filter((v: VoiceOption) => v.id);
  },
};
