import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { LogService } from '../../services/log.service';
import { splitSpeakable, toSpeakable } from './speakable';
import {
  STT_PROVIDERS,
  TTS_PROVIDERS,
  loadVoiceConfig,
  type SttProviderId,
  type TtsProviderId,
  type VoiceConfig,
} from './voice-config';
import { STT_PROVIDER_IMPLS, TTS_PROVIDER_IMPLS } from './providers';
import { VoiceProviderError, type ProviderContext, type SttProvider, type TtsProvider, type VoiceOption } from './providers/types';
import { operatorNameKey, operatorVocabulary } from './operator-config';

/** 한 번의 합성 요청에 싣는 글자 상한 — 화면은 220자 조각으로 보낸다. lab 의 긴 문장까지 받는다. */
export const MAX_SPEECH_TEXT_CHARS = 2000;
/** 읽을 문장으로 바꿀 원문 상한. 에이전트 답은 길 수 있지만 무한하지는 않다. */
export const MAX_SPEAKABLE_INPUT_CHARS = 200_000;
const TRANSCRIBE_TIMEOUT_MS = 60_000;
const SYNTHESIZE_TIMEOUT_MS = 30_000;

export class VoiceError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = 'VoiceError';
  }
}

export interface VoiceEngineStatus {
  provider: string;
  ready: boolean;
  error: string | null;
}

export interface VoiceStatusView {
  stt: VoiceEngineStatus;
  tts: VoiceEngineStatus & { voice: string };
  /** operator 를 이름으로 부르는 상시 청취를 켤 수 있는가(자체 호스팅 STT 에서만). */
  wake: { ready: boolean; error: string | null };
  lab?: { stt: string[]; tts: string[] };
}

/** 발화를 왜 보내는가 — 대화 입력(`utterance`)이거나, 잠든 operator 를 부르는 말인지 확인(`wake`). */
export type TranscribePurpose = 'utterance' | 'wake';

/**
 * 상시 청취(웨이크워드 확인)를 받는 STT. 깨어 있지 않은 동안 마이크 근처의 **모든 말**이 엔진으로
 * 가므로, 비용이 들고 대화가 바깥으로 나가는 클라우드 엔진에서는 받지 않는다.
 */
export const WAKE_STT_PROVIDERS: readonly SttProviderId[] = ['local'];

export interface VoiceTranscriptView {
  text: string;
  provider: string;
  model: string;
  latency_ms: number;
  /** 엔진의 답을 버렸으면 그 이유 — `vocabulary_echo`(용어집을 읊었을 뿐이다). text 는 ''. */
  ignored?: 'vocabulary_echo';
}

/**
 * 짧은 잡음이나 말의 앞부분만 든 구간에 대해 엔진이 **문맥으로 준 용어집을 그대로 읊는** 경우가 있다
 * (실측: Qwen3-ASR 이 "헤이 자비스" 앞 1.5초에 "자비스, Jarvis." 를 냈다). 용어 둘 이상만으로 된 전사는 그
 * 메아리로 본다 — 잠든 동안의 상시 청취에서 메아리가 이름으로 읽혀 깨어나지 않게, 대화 중에는 메아리가
 * 요청으로 가지 않게. 용어 하나("롤프")는 대답일 수 있어 남긴다.
 */
export function isVocabularyEcho(text: string, terms: readonly string[]): boolean {
  const vocabulary = new Set<string>();
  for (const term of terms) {
    for (const part of [term, ...term.split(/\s+/)]) {
      const key = operatorNameKey(part);
      if (key) vocabulary.add(key);
    }
  }
  const tokens = text.split(/[\s,.!?;:·、。…]+/u).map(operatorNameKey).filter(Boolean);
  return tokens.length >= 2 && tokens.every((token) => vocabulary.has(token));
}

function isSttProvider(id: string): id is SttProviderId {
  return (STT_PROVIDERS as readonly string[]).includes(id);
}

function isTtsProvider(id: string): id is TtsProviderId {
  return (TTS_PROVIDERS as readonly string[]).includes(id);
}

/**
 * 음성 게이트웨이 — 키는 서버에만 있고, 화면은 바이트를 보내 글자를 받고 글자를 보내 소리를 받는다
 * (docs/voice-operator.md). agent-manager 는 이 경로에 없다.
 *
 * 설정이 비었거나 틀렸을 때 **조용히 다른 공급자로 넘어가지 않는다**. 어느 엔진이 왜 못 쓰이는지를
 * 상태(`status`)와 오류에 그대로 싣는다 — 대체 경로가 전체 실패를 "조금 이상함" 으로 가린 전례가 있다.
 */
@Injectable()
export class VoiceService {
  /** 테스트가 실제 네트워크 대신 끼워 넣는다. */
  fetchImpl: typeof fetch = (input, init) => fetch(input, init);
  webSocketImpl: typeof WebSocket | undefined = undefined;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logService: LogService,
  ) {}

  private config(): Promise<VoiceConfig> {
    return loadVoiceConfig(this.dataSource);
  }

  private context(config: VoiceConfig, signal?: AbortSignal): ProviderContext {
    return { config, fetch: this.fetchImpl, WebSocket: this.webSocketImpl, signal };
  }

  private resolveStt(config: VoiceConfig, providerId: string): SttProvider {
    if (providerId === 'none' || !providerId) {
      throw new VoiceError(409, 'voice_stt_disabled', 'Speech-to-text is off — pick a provider in Admin → Voice.');
    }
    if (!isSttProvider(providerId)) {
      throw new VoiceError(409, 'voice_stt_unknown_provider', `Unknown speech-to-text provider "${providerId}" (expected one of: ${STT_PROVIDERS.join(', ')}).`);
    }
    const impl = STT_PROVIDER_IMPLS[providerId];
    const missing = impl.missing(config);
    if (missing) throw new VoiceError(409, 'voice_stt_not_configured', missing);
    return impl;
  }

  private resolveTts(config: VoiceConfig, providerId: string): TtsProvider {
    if (providerId === 'none' || !providerId) {
      throw new VoiceError(409, 'voice_tts_disabled', 'Text-to-speech is off — pick a provider in Admin → Voice.');
    }
    if (!isTtsProvider(providerId)) {
      throw new VoiceError(409, 'voice_tts_unknown_provider', `Unknown text-to-speech provider "${providerId}" (expected one of: ${TTS_PROVIDERS.join(', ')}).`);
    }
    const impl = TTS_PROVIDER_IMPLS[providerId];
    const missing = impl.missing(config);
    if (missing) throw new VoiceError(409, 'voice_tts_not_configured', missing);
    return impl;
  }

  private engineStatus(resolve: () => unknown, provider: string): VoiceEngineStatus {
    try {
      resolve();
      return { provider, ready: true, error: null };
    } catch (err) {
      return { provider, ready: false, error: err instanceof VoiceError && provider !== 'none' ? err.message : null };
    }
  }

  async status(includeLab: boolean): Promise<VoiceStatusView> {
    const config = await this.config();
    const view: VoiceStatusView = {
      stt: this.engineStatus(() => this.resolveStt(config, config.stt.provider), config.stt.provider),
      tts: {
        ...this.engineStatus(() => {
          const provider = this.resolveTts(config, config.tts.provider);
          // 목소리가 없으면 첫 낭독에서야 실패한다 — 그 전에 "준비 안 됨" 으로 보인다.
          if (!config.tts.voice && !provider.defaultVoice) {
            throw new VoiceError(409, 'voice_tts_no_voice', `Pick a voice for ${provider.id} in Admin → Voice (voice.tts.voice).`);
          }
        }, config.tts.provider),
        voice: config.tts.voice,
      },
      wake: { ready: false, error: null },
    };
    try {
      this.assertWakeAllowed(config);
      view.wake.ready = view.stt.ready;
    } catch (err) {
      view.wake.error = err instanceof VoiceError ? err.message : null;
    }
    if (includeLab) {
      view.lab = {
        stt: STT_PROVIDERS.filter((id) => !STT_PROVIDER_IMPLS[id].missing(config)),
        tts: TTS_PROVIDERS.filter((id) => !TTS_PROVIDER_IMPLS[id].missing(config)),
      };
    }
    return view;
  }

  /** operator 이름은 인식을 돕는 덤이다 — 목록을 못 읽어도 전사는 한다(사유는 남긴다). */
  private async operatorTerms(): Promise<string[]> {
    try {
      return await operatorVocabulary(this.dataSource);
    } catch (err: any) {
      this.logService.warn('Voice', 'Could not read operator names for the speech vocabulary', { error: err?.message || String(err) });
      return [];
    }
  }

  private assertWakeAllowed(config: VoiceConfig): void {
    if (!WAKE_STT_PROVIDERS.includes(config.stt.provider as SttProviderId)) {
      throw new VoiceError(409, 'voice_wake_needs_self_hosted',
        'Calling an operator by name listens all the time, so it only runs on the self-hosted speech-to-text engine (Admin → Voice → Self-hosted).');
    }
  }

  /**
   * 발화 오디오 → 글자. `override` 는 Voice lab 이 공급자·모델을 골라 비교할 때만 쓴다.
   * operator 이름은 언제나 용어집에 더한다 — 부르는 이름을 엔진이 알아듣게.
   */
  async transcribe(
    audio: Buffer,
    mimeType: string,
    override?: { provider?: string; model?: string },
    purpose: TranscribePurpose = 'utterance',
  ): Promise<VoiceTranscriptView> {
    if (!audio?.length) throw new VoiceError(400, 'voice_audio_empty', 'The request carried no audio.');
    const config = await this.config();
    if (purpose === 'wake') this.assertWakeAllowed(config);
    const providerId = override?.provider || config.stt.provider;
    const provider = this.resolveStt(config, providerId);
    const model = override?.model || config.stt.model || provider.defaultModel;
    const terms = [...new Set([...config.stt.terms, ...(await this.operatorTerms())])];
    const startedAt = Date.now();
    const text = await this.callUpstream(provider.id, TRANSCRIBE_TIMEOUT_MS, (signal) => provider.transcribe(
      { audio, mimeType: mimeType || 'application/octet-stream', model, languages: config.stt.languages, terms },
      this.context(config, signal),
    ));
    const latency_ms = Date.now() - startedAt;
    // Voice lab 은 엔진의 날것을 비교하는 곳이라 거르지 않는다.
    if (!override && isVocabularyEcho(text, terms)) {
      return { text: '', provider: provider.id, model, latency_ms, ignored: 'vocabulary_echo' };
    }
    return { text: text.trim(), provider: provider.id, model, latency_ms };
  }

  /** 화면용 답 → 읽을 조각들. 읽을 것이 없으면 빈 배열(호출자는 말하지 않는다). */
  speakable(text: string): string[] {
    if (typeof text !== 'string') return [];
    if (text.length > MAX_SPEAKABLE_INPUT_CHARS) {
      throw new VoiceError(413, 'voice_text_too_long', `Text is longer than ${MAX_SPEAKABLE_INPUT_CHARS} characters.`);
    }
    return splitSpeakable(toSpeakable(text));
  }

  /** 읽을 문장 → 소리. 입력은 이미 speakable 을 거친 조각이라고 본다(여기서 다시 다듬지 않는다). */
  async synthesize(text: string, override?: { provider?: string; voice?: string; model?: string }): Promise<{ audio: Buffer; contentType: string; provider: string }> {
    const clean = (text || '').trim();
    if (!clean) throw new VoiceError(400, 'voice_text_empty', 'Nothing to say — the text is empty.');
    if (clean.length > MAX_SPEECH_TEXT_CHARS) {
      throw new VoiceError(413, 'voice_text_too_long', `One speech request takes at most ${MAX_SPEECH_TEXT_CHARS} characters — split it with /api/voice/speakable first.`);
    }
    const config = await this.config();
    const providerId = override?.provider || config.tts.provider;
    const provider = this.resolveTts(config, providerId);
    // lab 이 공급자를 바꿔 부를 때 설정의 voice/model 은 다른 공급자의 것이므로 쓰지 않는다.
    const sameAsConfigured = providerId === config.tts.provider;
    const voice = override?.voice || (sameAsConfigured ? config.tts.voice : '') || provider.defaultVoice;
    const model = override?.model || (sameAsConfigured ? config.tts.model : '') || provider.defaultModel;
    if (!voice) {
      throw new VoiceError(409, 'voice_tts_no_voice', `Pick a voice for ${provider.id} in Admin → Voice (voice.tts.voice).`);
    }
    const out = await this.callUpstream(provider.id, SYNTHESIZE_TIMEOUT_MS, (signal) => provider.synthesize(
      { text: clean, model, voice, languages: config.stt.languages },
      this.context(config, signal),
    ));
    if (!out.audio?.length) throw new VoiceError(502, 'voice_tts_empty', `${provider.id} returned no audio.`);
    return { ...out, provider: provider.id };
  }

  /** Voice lab — 공급자 API 가 알려 주는 목소리(설정의 언어로 거른다). 목록 API 가 없는 공급자는 빈 배열. */
  async listVoices(providerId: string): Promise<VoiceOption[]> {
    const config = await this.config();
    const provider = this.resolveTts(config, providerId);
    if (!provider.listVoices) return [];
    return this.callUpstream(provider.id, SYNTHESIZE_TIMEOUT_MS, (signal) =>
      provider.listVoices!(config.stt.languages, this.context(config, signal)));
  }

  private async callUpstream<T>(provider: string, timeoutMs: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } catch (err: any) {
      if (err instanceof VoiceError) throw err;
      if (err instanceof VoiceProviderError) {
        this.logService.warn('Voice', err.message, { provider, upstream_status: err.upstreamStatus });
        // 키·권한 문제(401/403)는 운영자가 고칠 설정 문제라 409 로, 나머지는 게이트웨이 실패(502)로 낸다.
        const status = err.upstreamStatus === 401 || err.upstreamStatus === 403 ? 409 : 502;
        throw new VoiceError(status, 'voice_provider_failed', err.message);
      }
      if (controller.signal.aborted) {
        this.logService.warn('Voice', `${provider} timed out after ${timeoutMs}ms`);
        throw new VoiceError(504, 'voice_provider_timeout', `${provider} did not answer within ${Math.round(timeoutMs / 1000)}s.`);
      }
      this.logService.error('Voice', `${provider} request failed: ${err?.message ?? err}`);
      throw new VoiceError(502, 'voice_provider_failed', `${provider} request failed: ${err?.message ?? err}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
