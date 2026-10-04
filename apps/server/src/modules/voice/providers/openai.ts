import type { VoiceConfig } from '../voice-config';
import { audioBlob, audioFileName } from './audio-file';
import type { SttProvider, TtsProvider } from './types';
import { upstreamFailure } from './types';

/**
 * OpenAI 오디오 API — 그리고 같은 경로를 구현한 셀프호스팅 서버(vLLM · vLLM-Omni · speaches ·
 * LocalAI). `voice.openai.base_url` 하나로 갈린다(docs/voice-operator.md "공급자 인터페이스").
 *
 * 셀프호스팅 서버는 `languages[]` / `keywords[]` 를 모른다 — 그쪽에는 `language` 와 `prompt` 만 보낸다.
 * https://developers.openai.com/api/docs/guides/speech-to-text
 */

export function isOpenAiHosted(config: VoiceConfig): boolean {
  return /^https:\/\/api\.openai\.com(\/|$)/.test(config.openaiBaseUrl);
}

/** gpt-transcribe 만 `languages[]`·`keywords[]` 를 받는다(같이 `language` 를 보내면 안 된다). */
function takesKeywords(model: string): boolean {
  return /^gpt-transcribe/.test(model);
}

const missing = (config: VoiceConfig) =>
  (isOpenAiHosted(config) && !config.keys.openai ? 'OpenAI API key is not set (voice.openai.api_key).' : null);

function authHeaders(config: VoiceConfig): Record<string, string> {
  return config.keys.openai ? { Authorization: `Bearer ${config.keys.openai}` } : {};
}

export const openAiStt: SttProvider = {
  id: 'openai',
  defaultModel: 'gpt-transcribe',
  missing,

  async transcribe(input, ctx) {
    const form = new FormData();
    form.append('model', input.model);
    form.append('file', audioBlob(input.audio, input.mimeType), audioFileName(input.mimeType));
    form.append('response_format', 'json');
    if (takesKeywords(input.model) && isOpenAiHosted(ctx.config)) {
      for (const lang of input.languages) form.append('languages[]', lang);
      for (const term of input.terms) form.append('keywords[]', term);
    } else {
      // 한 언어만 받는 모델: 첫 언어를 주 언어로 둔다. 용어는 prompt 로 실어 철자를 유도한다.
      if (input.languages.length) form.append('language', input.languages[0]);
      if (input.terms.length) form.append('prompt', `${input.terms.join(', ')}.`);
    }
    const res = await ctx.fetch(`${ctx.config.openaiBaseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(ctx.config),
      body: form,
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('openai', res);
    const body = await res.json();
    return typeof body?.text === 'string' ? body.text : '';
  },
};

export const openAiTts: TtsProvider = {
  id: 'openai',
  defaultModel: 'gpt-4o-mini-tts',
  // OpenAI 목소리는 언어와 무관하다 — 그래서 이 공급자만 기본 목소리를 둔다(OpenAI 권장 목소리).
  defaultVoice: 'marin',
  missing,

  async synthesize(input, ctx) {
    const res = await ctx.fetch(`${ctx.config.openaiBaseUrl}/audio/speech`, {
      method: 'POST',
      headers: { ...authHeaders(ctx.config), 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: input.model, input: input.text, voice: input.voice, response_format: 'mp3' }),
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('openai', res);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  },
};
