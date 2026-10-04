import type { SttProvider } from './types';
import { VoiceProviderError } from './types';

/**
 * Soniox 전사. 발화 하나(이미 끝난 녹음)를 **실시간 WebSocket** 으로 흘려 보낸다.
 *
 * 비동기(file) API 는 업로드 → 작업 생성 → 상태 폴링 → 결과 조회 → 정리까지 왕복이 다섯 번이라
 * 짧은 발화에서는 대기가 길다. 실시간 엔드포인트는 webm/mp4 를 `audio_format: "auto"` 로 그대로
 * 받으므로 연결 하나로 끝난다. 확정(final) 토큰만 모은다 — 비확정 토큰은 다시 오고 바뀔 수 있다.
 *
 * https://soniox.com/docs/api-reference/stt/websocket-api
 */

export const SONIOX_WS_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';
const FRAME_BYTES = 64 * 1024;
// 특수 토큰: <fin>(수동 확정), <end>(endpoint). 글자가 아니다.
const CONTROL_TOKEN_RE = /^<(fin|end)>$/;

interface SonioxToken {
  text?: string;
  is_final?: boolean;
}

interface SonioxMessage {
  tokens?: SonioxToken[];
  finished?: boolean;
  error_code?: number;
  error_message?: string;
}

export const sonioxStt: SttProvider = {
  id: 'soniox',
  defaultModel: 'stt-rt-v5',
  missing: (config) => (config.keys.soniox ? null : 'Soniox API key is not set (voice.soniox.api_key).'),

  transcribe(input, ctx) {
    const WS = ctx.WebSocket ?? (globalThis as any).WebSocket as typeof WebSocket | undefined;
    if (!WS) return Promise.reject(new Error('this Node runtime has no WebSocket client'));
    return new Promise<string>((resolve, reject) => {
      const finals: string[] = [];
      let settled = false;
      const ws = new WS(SONIOX_WS_URL);
      ws.binaryType = 'arraybuffer';

      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        ctx.signal?.removeEventListener('abort', onAbort);
        try { ws.close(); } catch { /* already closed */ }
        if (err) reject(err);
        else resolve(finals.join(''));
      };
      const onAbort = () => finish(new Error('aborted'));
      ctx.signal?.addEventListener('abort', onAbort);

      ws.onopen = () => {
        const config: Record<string, unknown> = {
          api_key: ctx.config.keys.soniox,
          model: input.model,
          audio_format: 'auto',
          enable_endpoint_detection: false,
        };
        if (input.languages.length) config.language_hints = input.languages;
        if (input.terms.length) config.context = { terms: input.terms };
        ws.send(JSON.stringify(config));
        for (let i = 0; i < input.audio.length; i += FRAME_BYTES) {
          const slice = input.audio.subarray(i, Math.min(i + FRAME_BYTES, input.audio.length));
          ws.send(new Uint8Array(slice));
        }
        ws.send(''); // 오디오 끝
      };

      ws.onmessage = (event: MessageEvent) => {
        let msg: SonioxMessage;
        try {
          msg = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8'));
        } catch {
          return;
        }
        if (msg.error_code) {
          finish(new VoiceProviderError('soniox', msg.error_code, `soniox ${msg.error_code}: ${msg.error_message || 'error'}`));
          return;
        }
        for (const token of msg.tokens ?? []) {
          if (token.is_final && typeof token.text === 'string' && !CONTROL_TOKEN_RE.test(token.text)) finals.push(token.text);
        }
        if (msg.finished) finish(null);
      };

      ws.onerror = () => finish(new Error('soniox connection failed'));
      ws.onclose = (event: CloseEvent) => {
        if (!settled) finish(new Error(`soniox closed the connection before finishing (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`));
      };
    });
  },
};
