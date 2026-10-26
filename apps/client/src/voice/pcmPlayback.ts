import { t as translate } from '../i18n/core';
/** Play raw 24 kHz mono PCM as bytes arrive, without waiting for a complete file. */
export async function playPcmStream(response: Response, context: AudioContext, signal: AbortSignal): Promise<void> {
  if (!response.body || !response.headers.get('content-type')?.startsWith('audio/pcm')
    || response.headers.get('x-audio-sample-rate') !== '24000'
    || response.headers.get('x-audio-channels') !== '1') {
    await response.body?.cancel();
    throw new Error(translate('Unsupported streaming audio format'));
  }
  if (context.state !== 'running') {
    await response.body.cancel();
    throw new DOMException(translate('Audio needs a user gesture'), 'NotAllowedError');
  }
  const reader = response.body.getReader();
  const playing = new Map<AudioBufferSourceNode, Promise<void>>();
  let pending = new Uint8Array(0);
  let nextTime = context.currentTime + 0.04;
  let total = 0;
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
    for (const source of playing.keys()) { try { source.stop(); } catch { /* already ended */ } }
  };
  signal.addEventListener('abort', cancel, { once: true });
  const schedule = async (bytes: Uint8Array) => {
    // Keep at most about a second queued in Web Audio; backpressure reaches fetch.
    while (nextTime - context.currentTime > 1 && playing.size) {
      await Promise.race(playing.values());
      signal.throwIfAborted();
    }
    const buffer = context.createBuffer(1, bytes.length / 2, 24000);
    const samples = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getInt16(i * 2, true) / 32768;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    const ended = new Promise<void>((resolve) => {
      source.onended = () => { playing.delete(source); source.disconnect(); resolve(); };
    });
    playing.set(source, ended);
    nextTime = Math.max(nextTime, context.currentTime + 0.01);
    source.start(nextTime);
    nextTime += buffer.duration;
  };
  try {
    signal.throwIfAborted();
    for (;;) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      total += value.length;
      const bytes = new Uint8Array(pending.length + value.length);
      bytes.set(pending); bytes.set(value, pending.length);
      let offset = 0;
      // 40 ms packets avoid both tiny AudioNodes and large scheduled buffers.
      while (bytes.length - offset >= 1920) {
        await schedule(bytes.subarray(offset, offset + 1920));
        offset += 1920;
      }
      pending = bytes.slice(offset);
    }
    if (!total || pending.length % 2) throw new Error(translate('Empty or truncated PCM audio'));
    if (pending.length) await schedule(pending);
    await Promise.all(playing.values());
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener('abort', cancel);
    cancel();
    reader.releaseLock();
  }
}
