import type { SttProviderId, TtsProviderId } from '../voice-config';
import { azureTts } from './azure';
import { elevenLabsStt, elevenLabsTts } from './elevenlabs';
import { googleTts } from './google';
import { openAiStt, openAiTts } from './openai';
import { sonioxStt } from './soniox';
import { typecastTts } from './typecast';
import type { SttProvider, TtsProvider } from './types';

/** 공급자 id → 구현. 목록(STT_PROVIDERS/TTS_PROVIDERS)과 이 표가 어긋나면 타입 검사가 잡는다. */
export const STT_PROVIDER_IMPLS: Record<SttProviderId, SttProvider> = {
  soniox: sonioxStt,
  elevenlabs: elevenLabsStt,
  openai: openAiStt,
};

export const TTS_PROVIDER_IMPLS: Record<TtsProviderId, TtsProvider> = {
  elevenlabs: elevenLabsTts,
  typecast: typecastTts,
  azure: azureTts,
  google: googleTts,
  openai: openAiTts,
};
