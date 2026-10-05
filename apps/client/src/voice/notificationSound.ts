/** Short work-update cues, played through the speech queue so the microphone pauses. */
export const NOTIFICATION_SOUNDS = [
  { value: 'chime', label: 'Chime', tones: [659, 880, 1047] },
  { value: 'bell', label: 'Bell', tones: [1047] },
  { value: 'soft', label: 'Soft', tones: [440, 554] },
] as const;
export type NotificationSound = typeof NOTIFICATION_SOUNDS[number]['value'];

export function isNotificationSound(value: unknown): value is NotificationSound {
  return NOTIFICATION_SOUNDS.some((sound) => sound.value === value);
}

/** PCM WAV requires no engine or AudioContext and works with the unlocked audio element. */
export function notificationSoundClip(sound: NotificationSound): Blob {
  const tones = NOTIFICATION_SOUNDS.find((item) => item.value === sound)!.tones;
  const rate = 24000;
  const duration = tones.length * 0.16 + 0.3;
  const length = Math.ceil(rate * duration);
  const buffer = new ArrayBuffer(44 + length * 2);
  const view = new DataView(buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, 'RIFF'); view.setUint32(4, buffer.byteLength - 8, true); tag(8, 'WAVE'); tag(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
  view.setUint16(34, 16, true); tag(36, 'data'); view.setUint32(40, length * 2, true);
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    let sample = 0;
    tones.forEach((frequency, n) => {
      const elapsed = t - n * 0.16;
      if (elapsed >= 0) sample += Math.sin(2 * Math.PI * frequency * elapsed) * Math.min(1, elapsed / 0.008) * Math.exp(-elapsed * 12) * 0.18;
    });
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, sample)) * 32767), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}
