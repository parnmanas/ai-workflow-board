import { toSpeakable } from './speakable';

/**
 * 음성 알림 문장(docs/voice-operator.md "음성 알림"). 템플릿이라 즉시·결정적이다 — 알림 하나마다
 * LLM 을 부르지 않는다. 답·요약이 있으면 그 첫머리(한두 문장)를 덧붙여 화면을 열지 않고도 결과를 듣게 한다.
 *
 * 한국어 문장은 받침에 따라 바뀌는 조사(이/가, 을/를)를 제목 바로 뒤에 붙이지 않게 짠다 — 제목은
 * 무엇이든 올 수 있다("'배포 정리' 작업이", "'X' 미션이" 처럼 고정 명사 뒤에만 조사를 단다).
 */

export type AnnouncementKind =
  | 'session_turn_finished'
  | 'session_turn_failed'
  | 'session_needs_input'
  | 'mission_completed'
  | 'mission_failed'
  | 'mission_cancelled'
  | 'mission_needs_decision';

export type AnnouncementLanguage = 'ko' | 'en';

/** 알림에 덧붙이는 답·요약의 길이 상한 — 알림은 짧아야 한다(상세는 화면에). */
export const ANNOUNCEMENT_DETAIL_CHARS = 160;

export function announcementLanguage(languages: string[]): AnnouncementLanguage {
  return (languages[0] || '').toLowerCase() === 'ko' ? 'ko' : 'en';
}

function detail(text: string | null | undefined): string {
  const spoken = toSpeakable(text || '', ANNOUNCEMENT_DETAIL_CHARS);
  return spoken ? ` ${spoken}` : '';
}

export interface SessionAnnouncementInput {
  hostName: string;
  cliLabel: string;
  title: string;
  /** 턴의 최종 답(마크다운 그대로) — 끝난 턴에만. */
  answer?: string | null;
}

export function sessionAnnouncementText(
  kind: Extract<AnnouncementKind, `session_${string}`>,
  input: SessionAnnouncementInput,
  lang: AnnouncementLanguage,
): string {
  const title = input.title.trim();
  if (lang === 'ko') {
    const subject = `${input.hostName}의 ${input.cliLabel} 세션${title ? ` '${title}'` : ''}`;
    if (kind === 'session_turn_finished') return `${subject} 작업이 끝났어요.${detail(input.answer)}`;
    if (kind === 'session_turn_failed') return `${subject}에서 오류가 났어요.`;
    return `${subject}에서 확인을 기다리고 있어요.`;
  }
  const subject = `The ${input.cliLabel} session${title ? ` "${title}"` : ''} on ${input.hostName}`;
  if (kind === 'session_turn_finished') return `${subject} finished.${detail(input.answer)}`;
  if (kind === 'session_turn_failed') return `${subject} hit an error.`;
  return `${subject} is waiting for you.`;
}

export interface MissionAnnouncementInput {
  title: string;
  counts?: { total?: number; done?: number; failed?: number } | null;
  /** 완료 요약 또는 실패 사유. */
  summary?: string | null;
  /** 결정을 기다리는 단계 이름(확인 게이트). */
  stepTitle?: string | null;
}

export function missionAnnouncementText(
  kind: Extract<AnnouncementKind, `mission_${string}`>,
  input: MissionAnnouncementInput,
  lang: AnnouncementLanguage,
): string {
  const title = input.title.trim() || (lang === 'ko' ? '이름 없는' : 'untitled');
  const total = Number(input.counts?.total ?? 0);
  const done = Number(input.counts?.done ?? 0);
  const failed = Number(input.counts?.failed ?? 0);
  if (lang === 'ko') {
    if (kind === 'mission_completed') {
      const tally = total ? ` 단계 ${total}개 중 ${done}개가 끝났어요.` : '';
      return `'${title}' 미션이 끝났어요.${tally}${detail(input.summary)}`;
    }
    if (kind === 'mission_failed') {
      const tally = failed ? ` 실패한 단계가 ${failed}개 있어요.` : '';
      return `'${title}' 미션이 실패했어요.${tally}${detail(input.summary)}`;
    }
    if (kind === 'mission_cancelled') return `'${title}' 미션이 취소됐어요.`;
    const step = input.stepTitle?.trim();
    return `'${title}' 미션에서 결정이 필요해요.${step ? ` 단계: ${step}.` : ''}`;
  }
  if (kind === 'mission_completed') {
    const tally = total ? ` ${done} of ${total} steps done.` : '';
    return `Mission "${title}" completed.${tally}${detail(input.summary)}`;
  }
  if (kind === 'mission_failed') {
    const tally = failed ? ` ${failed} step${failed === 1 ? '' : 's'} failed.` : '';
    return `Mission "${title}" failed.${tally}${detail(input.summary)}`;
  }
  if (kind === 'mission_cancelled') return `Mission "${title}" was cancelled.`;
  const step = input.stepTitle?.trim();
  return `Mission "${title}" needs your decision.${step ? ` Step: ${step}.` : ''}`;
}
