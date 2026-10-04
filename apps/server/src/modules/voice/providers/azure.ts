import type { TtsProvider, VoiceOption } from './types';
import { upstreamFailure } from './types';

/**
 * Azure Speech TTS(REST). 한국어 HD 목소리(`ko-KR-SunHi:DragonHDLatestNeural` 등)는 koreacentral 에
 * 없다 — 리소스 지역을 eastus 같은 HD 지역에 두어야 한다.
 * https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-text-to-speech
 */

function escapeXml(text: string): string {
  return text.replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c] as string));
}

/** 목소리 이름의 로캘 접두(`ko-KR-SunHiNeural` → `ko-KR`). SSML xml:lang 에 쓴다. */
export function azureVoiceLocale(voice: string): string {
  const m = /^([a-z]{2,3}-[A-Z]{2})-/.exec(voice);
  return m ? m[1] : 'en-US';
}

export function azureSsml(text: string, voice: string): string {
  const lang = azureVoiceLocale(voice);
  return `<speak version='1.0' xml:lang='${lang}'><voice name='${escapeXml(voice)}'>${escapeXml(text)}</voice></speak>`;
}

export const azureTts: TtsProvider = {
  id: 'azure',
  defaultModel: '',
  defaultVoice: '',
  missing: (config) => {
    if (!config.keys.azure) return 'Azure Speech key is not set (voice.azure.api_key).';
    if (!config.azureRegion) return 'Azure Speech region is not set (voice.azure.region).';
    return null;
  },

  async synthesize(input, ctx) {
    const res = await ctx.fetch(`https://${ctx.config.azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': ctx.config.keys.azure,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-96kbitrate-mono-mp3',
        'User-Agent': 'awb-voice-gateway',
      },
      body: azureSsml(input.text, input.voice),
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('azure', res);
    return { audio: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'audio/mpeg' };
  },

  async listVoices(languages, ctx) {
    const res = await ctx.fetch(`https://${ctx.config.azureRegion}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      headers: { 'Ocp-Apim-Subscription-Key': ctx.config.keys.azure },
      signal: ctx.signal,
    });
    if (!res.ok) throw await upstreamFailure('azure', res);
    const list = await res.json();
    const wanted = languages.map((l) => l.toLowerCase());
    const out: VoiceOption[] = [];
    for (const v of Array.isArray(list) ? list : []) {
      const locale = String(v?.Locale || '');
      if (wanted.length && !wanted.some((l) => locale.toLowerCase().startsWith(`${l}-`))) continue;
      out.push({
        id: String(v?.ShortName || ''),
        name: `${v?.LocalName || v?.DisplayName || v?.ShortName}${v?.VoiceType ? ` (${v.VoiceType})` : ''}`,
        language: locale || undefined,
        gender: v?.Gender ? String(v.Gender) : undefined,
      });
    }
    return out.filter((v) => v.id);
  },
};
