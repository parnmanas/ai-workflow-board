import type { TtsProvider, VoiceOption } from './types';
import { upstreamFailure } from './types';

/**
 * Google Cloud Text-to-Speech(REST, API 키). Chirp 3 HD 한국어 목소리는
 * `ko-KR-Chirp3-HD-<이름>` 꼴이다. REST 는 한 번에 전체를 돌려준다(스트리밍은 gRPC 전용).
 * https://docs.cloud.google.com/text-to-speech/docs/chirp3-hd
 */

const BASE = 'https://texttospeech.googleapis.com/v1';

/** 목소리 이름의 로캘(`ko-KR-Chirp3-HD-Kore` → `ko-KR`). */
export function googleVoiceLocale(voice: string): string {
  const m = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice);
  return m ? m[1] : 'en-US';
}

export const googleTts: TtsProvider = {
  id: 'google',
  defaultModel: '',
  defaultVoice: '',
  missing: (config) => (config.keys.google ? null : 'Google Cloud API key is not set (voice.google.api_key).'),

  async synthesize(input, ctx) {
    const res = await ctx.fetch(`${BASE}/text:synthesize`, {
      method: 'POST',
      headers: { 'x-goog-api-key': ctx.config.keys.google, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: input.text },
        voice: { languageCode: googleVoiceLocale(input.voice), name: input.voice },
        audioConfig: { audioEncoding: 'MP3' },
      }),
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('google', res);
    const body = await res.json();
    const b64 = typeof body?.audioContent === 'string' ? body.audioContent : '';
    return { audio: Buffer.from(b64, 'base64'), contentType: 'audio/mpeg' };
  },

  async listVoices(languages, ctx) {
    // languageCode 필터는 하나만 받으므로 언어마다 묻는다.
    const codes = languages.length ? languages : [''];
    const out: VoiceOption[] = [];
    for (const code of codes) {
      const query = code ? `?languageCode=${encodeURIComponent(code)}` : '';
      const res = await ctx.fetch(`${BASE}/voices${query}`, {
        headers: { 'x-goog-api-key': ctx.config.keys.google },
        signal: ctx.signal,
      });
      if (!res.ok) throw await upstreamFailure('google', res);
      const body = await res.json();
      for (const v of Array.isArray(body?.voices) ? body.voices : []) {
        out.push({
          id: String(v?.name || ''),
          name: String(v?.name || ''),
          language: Array.isArray(v?.languageCodes) ? v.languageCodes.join(', ') : undefined,
          gender: v?.ssmlGender ? String(v.ssmlGender).toLowerCase() : undefined,
        });
      }
    }
    // 품질 순으로 보이게: Chirp3-HD → Chirp-HD → Neural2/Wavenet → 나머지.
    const rank = (id: string) => (/Chirp3-HD/.test(id) ? 0 : /Chirp/.test(id) ? 1 : /Neural2|Wavenet/.test(id) ? 2 : 3);
    const seen = new Set<string>();
    return out
      .filter((v) => v.id && !seen.has(v.id) && seen.add(v.id))
      .sort((a, b) => rank(a.id) - rank(b.id) || a.id.localeCompare(b.id));
  },
};
