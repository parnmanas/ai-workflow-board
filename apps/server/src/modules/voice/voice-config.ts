import type { DataSource } from 'typeorm';
import { Like } from 'typeorm';
import { decrypt } from '../../services/encryption.service';

/**
 * 음성 게이트웨이 설정 — SystemSettings `voice.*` (docs/voice-operator.md "공급자 인터페이스").
 *
 * 공급자마다 키를 따로 두고(`voice.<provider>.*`) 활성 공급자는 `voice.stt.provider` /
 * `voice.tts.provider` 로 고른다. 공급자를 바꿀 때 키를 다시 넣지 않아도 되고, Voice lab 이
 * 키가 있는 공급자를 나란히 비교할 수 있다.
 *
 * 정의는 여기 두고 Admin Settings(`settings.controller.ts`)가 펼쳐서 보여 준다 — 음성 설정의
 * 의미를 아는 곳은 이 모듈 하나다.
 */

export const STT_PROVIDERS = ['soniox', 'elevenlabs', 'openai', 'local'] as const;
export const TTS_PROVIDERS = ['elevenlabs', 'typecast', 'azure', 'google', 'openai', 'local'] as const;
export type SttProviderId = typeof STT_PROVIDERS[number];
export type TtsProviderId = typeof TTS_PROVIDERS[number];
export type VoiceProviderId = SttProviderId | TtsProviderId;

/** 키를 가진 공급자 — Voice lab 이 비교할 수 있는 대상. */
export const KEYED_PROVIDERS = ['soniox', 'elevenlabs', 'typecast', 'azure', 'google', 'openai', 'local'] as const;
export type KeyedProviderId = typeof KEYED_PROVIDERS[number];

export const VOICE_SETTING_DEFINITIONS: Record<string, { description: string; is_secret: boolean; default_value: string }> = {
  'voice.stt.provider': {
    description: `Speech-to-text provider for voice input: none | ${STT_PROVIDERS.join(' | ')}`,
    is_secret: false,
    default_value: 'none',
  },
  'voice.stt.model': {
    description: 'Speech-to-text model id. Blank = the provider default.',
    is_secret: false,
    default_value: '',
  },
  'voice.stt.languages': {
    description: 'Comma-separated language hints for speech-to-text (ISO 639-1), e.g. ko,en',
    is_secret: false,
    default_value: 'ko,en',
  },
  'voice.stt.terms': {
    description: 'Comma-separated vocabulary the recognizer should expect (product names, host names, jargon).',
    is_secret: false,
    default_value: 'AWB, agent-manager, orchestration, Claude, Codex, rolf, ralf, ragnar',
  },
  'voice.tts.provider': {
    description: `Text-to-speech provider for spoken replies and announcements: none | ${TTS_PROVIDERS.join(' | ')}`,
    is_secret: false,
    default_value: 'none',
  },
  'voice.tts.model': {
    description: 'Text-to-speech model id. Blank = the provider default.',
    is_secret: false,
    default_value: '',
  },
  'voice.tts.voice': {
    description: 'Voice for the TTS provider (ElevenLabs/Typecast voice_id, Azure/Google voice name, OpenAI voice). Admin → Voice lists the provider\'s voices.',
    is_secret: false,
    default_value: '',
  },
  'voice.soniox.api_key': {
    description: 'Soniox API key (speech-to-text). Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.elevenlabs.api_key': {
    description: 'ElevenLabs API key (text-to-speech and Scribe speech-to-text). Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.typecast.api_key': {
    description: 'Typecast API key (text-to-speech). Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.azure.api_key': {
    description: 'Azure Speech resource key (text-to-speech). Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.azure.region': {
    description: 'Azure Speech resource region, e.g. eastus. Korean HD (DragonHD) voices are not offered in koreacentral.',
    is_secret: false,
    default_value: '',
  },
  'voice.google.api_key': {
    description: 'Google Cloud API key with the Text-to-Speech API enabled. Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.openai.api_key': {
    description: 'OpenAI (or OpenAI-compatible server) API key for speech-to-text / text-to-speech. Stored encrypted.',
    is_secret: true,
    default_value: '',
  },
  'voice.openai.base_url': {
    description: 'Base URL of the OpenAI audio API (or another OpenAI-compatible server).',
    is_secret: false,
    default_value: 'https://api.openai.com/v1',
  },
  'voice.local.base_url': {
    description: 'Base URL of the self-hosted voice server (awb-voice-server on ragnar, OpenAI-compatible), e.g. http://192.168.0.6:8410/v1',
    is_secret: false,
    default_value: '',
  },
  'voice.local.api_key': {
    description: 'Bearer key of the self-hosted voice server. Stored encrypted. Leave blank if the server has none.',
    is_secret: true,
    default_value: '',
  },
};

export interface VoiceConfig {
  stt: { provider: string; model: string; languages: string[]; terms: string[] };
  tts: { provider: string; model: string; voice: string };
  keys: Record<KeyedProviderId, string>;
  azureRegion: string;
  openaiBaseUrl: string;
  /** 셀프호스팅 음성 서버 주소(끝 `/` 없이). 비어 있으면 그 공급자는 꺼진 것이다. */
  localBaseUrl: string;
}

function list(raw: string): string[] {
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** 설정 행(복호화 전) → 형식화된 설정. 저장 안 된 키는 정의의 기본값을 쓴다. */
export function parseVoiceConfig(rows: Record<string, string | null | undefined>): VoiceConfig {
  const get = (key: string): string => {
    const def = VOICE_SETTING_DEFINITIONS[key];
    const raw = rows[key];
    if (raw === undefined || raw === null) return def?.default_value ?? '';
    return def?.is_secret ? (raw ? decrypt(raw) : '') : raw;
  };
  return {
    stt: {
      provider: get('voice.stt.provider').trim().toLowerCase() || 'none',
      model: get('voice.stt.model').trim(),
      languages: list(get('voice.stt.languages')),
      terms: list(get('voice.stt.terms')),
    },
    tts: {
      provider: get('voice.tts.provider').trim().toLowerCase() || 'none',
      model: get('voice.tts.model').trim(),
      voice: get('voice.tts.voice').trim(),
    },
    keys: {
      soniox: get('voice.soniox.api_key'),
      elevenlabs: get('voice.elevenlabs.api_key'),
      typecast: get('voice.typecast.api_key'),
      azure: get('voice.azure.api_key'),
      google: get('voice.google.api_key'),
      openai: get('voice.openai.api_key'),
      local: get('voice.local.api_key'),
    },
    azureRegion: get('voice.azure.region').trim(),
    openaiBaseUrl: (get('voice.openai.base_url').trim() || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    localBaseUrl: get('voice.local.base_url').trim().replace(/\/+$/, ''),
  };
}

// 응답 한 번에 문장 조각마다 설정을 읽으므로 짧게 캐시한다. Admin Settings 가 voice.* 를
// 저장하면 invalidateVoiceConfig() 로 즉시 버린다 — 바꾼 키가 10초 뒤에야 먹으면 "저장했는데
// 안 된다" 로 보인다.
const CACHE_TTL_MS = 10_000;
let cached: { at: number; generation: number; config: VoiceConfig } | null = null;
let generation = 0;

export function invalidateVoiceConfig(): void {
  generation += 1;
}

export async function loadVoiceConfig(dataSource: DataSource): Promise<VoiceConfig> {
  const now = Date.now();
  if (cached && cached.generation === generation && now - cached.at < CACHE_TTL_MS) return cached.config;
  const seenGeneration = generation;
  const rows = await dataSource.getRepository('SystemSetting').find({ where: { key: Like('voice.%') } });
  const byKey: Record<string, string> = {};
  for (const row of rows as Array<{ key: string; value: string }>) byKey[row.key] = row.value;
  const config = parseVoiceConfig(byKey);
  cached = { at: now, generation: seenGeneration, config };
  return config;
}
