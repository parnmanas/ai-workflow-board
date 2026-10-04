import { audioBlob, audioFileName, singleLanguage } from './audio-file';
import type { SttProvider, TtsProvider, VoiceOption } from './types';
import { upstreamFailure } from './types';

/**
 * ElevenLabs — Scribe(전사)와 TTS.
 * https://elevenlabs.io/docs/api-reference/speech-to-text/convert
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */

const BASE = 'https://api.elevenlabs.io';
const missingKey = (config: { keys: { elevenlabs: string } }) =>
  (config.keys.elevenlabs ? null : 'ElevenLabs API key is not set (voice.elevenlabs.api_key).');

// keyterms 규칙: 50자 미만, 5단어 이하, 금지 문자 없음. 100개를 넘으면 최소 과금이 20초로 뛴다.
const KEYTERM_FORBIDDEN = /[<>{}[\]\\]/;
const MAX_KEYTERMS = 100;

export function elevenLabsKeyterms(terms: string[]): string[] {
  return terms
    .filter((t) => t.length < 50 && t.split(/\s+/).length <= 5 && !KEYTERM_FORBIDDEN.test(t))
    .slice(0, MAX_KEYTERMS);
}

export const elevenLabsStt: SttProvider = {
  id: 'elevenlabs',
  defaultModel: 'scribe_v2',
  missing: missingKey,

  async transcribe(input, ctx) {
    const form = new FormData();
    form.append('model_id', input.model);
    form.append('file', audioBlob(input.audio, input.mimeType), audioFileName(input.mimeType));
    // 웃음·박수 같은 소리 태그는 프롬프트에 섞이면 안 된다.
    form.append('tag_audio_events', 'false');
    const language = singleLanguage(input.languages);
    if (language) form.append('language_code', language);
    for (const term of elevenLabsKeyterms(input.terms)) form.append('keyterms', term);
    const res = await ctx.fetch(`${BASE}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': ctx.config.keys.elevenlabs },
      body: form,
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('elevenlabs', res);
    const body = await res.json();
    return typeof body?.text === 'string' ? body.text : '';
  },
};

export const elevenLabsTts: TtsProvider = {
  id: 'elevenlabs',
  defaultModel: 'eleven_v4_turbo',
  defaultVoice: '',
  missing: missingKey,

  async synthesize(input, ctx) {
    const res = await ctx.fetch(
      `${BASE}/v1/text-to-speech/${encodeURIComponent(input.voice)}?output_format=mp3_44100_128`,
      {
        method: 'POST',
        headers: { 'xi-api-key': ctx.config.keys.elevenlabs, 'Content-Type': 'application/json', Accept: 'audio/mpeg' },
        body: JSON.stringify({ text: input.text, model_id: input.model }),
        signal: ctx.signal,
      },
    );
    if (!res.ok) throw await upstreamFailure('elevenlabs', res);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  },

  /** 계정 라이브러리의 목소리. 한국어 목소리는 ElevenLabs Voice Library 에서 라이브러리로 추가해 둔다. */
  async listVoices(languages, ctx) {
    const query = new URLSearchParams({ page_size: '100' });
    const res = await ctx.fetch(`${BASE}/v2/voices?${query.toString()}`, {
      headers: { 'xi-api-key': ctx.config.keys.elevenlabs },
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('elevenlabs', res);
    const body = await res.json();
    const wanted = new Set(languages.map((l) => l.toLowerCase()));
    const voices: VoiceOption[] = [];
    for (const v of Array.isArray(body?.voices) ? body.voices : []) {
      const verified: string[] = Array.isArray(v?.verified_languages)
        ? v.verified_languages.map((l: any) => String(l?.language || '').toLowerCase()).filter(Boolean)
        : [];
      const labelLanguage = String(v?.labels?.language || '').toLowerCase();
      const langs = [...new Set([...verified, ...(labelLanguage ? [labelLanguage] : [])])];
      voices.push({
        id: String(v?.voice_id || ''),
        name: String(v?.name || v?.voice_id || ''),
        language: langs.join(', ') || undefined,
        gender: v?.labels?.gender ? String(v.labels.gender) : undefined,
        preview_url: v?.preview_url ? String(v.preview_url) : undefined,
      });
    }
    // 원하는 언어를 확인받은 목소리를 앞에 — 나머지(다국어 기본 목소리)도 버리지 않는다.
    const matches = (o: VoiceOption) => !!o.language && o.language.split(', ').some((l) => wanted.has(l));
    return voices.filter((v) => v.id).sort((a, b) => Number(matches(b)) - Number(matches(a)));
  },
};
