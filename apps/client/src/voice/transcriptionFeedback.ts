import type { VoiceTranscript } from '../types';

/** An enrolled-speaker rejection must be visible instead of making a working microphone appear dead. */
export function transcriptionFeedback(transcript: Pick<VoiceTranscript, 'ignored'>): string {
  if (transcript.ignored === 'speaker_mismatch') return '등록한 내 목소리와 일치하지 않아 제외했습니다. VOICE에서 목소리 테스트나 추가 샘플 등록을 해 주세요.';
  if (transcript.ignored === 'insufficient_speech') return '목소리를 확인하기에 말이 너무 짧았습니다. 조금 길게 다시 말해 주세요.';
  return '말을 인식하지 못했습니다. 다시 말해 주세요.';
}
