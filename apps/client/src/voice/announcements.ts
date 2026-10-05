import type { VoiceAnnouncementTarget } from '../types';

/** Only a response to the user's conversation is spoken automatically. */
export function announcementPlayback(kind: string): 'speech' | 'cue' {
  return kind === 'operator_reply' ? 'speech' : 'cue';
}

/**
 * 음성 알림(docs/voice-operator.md "음성 알림")의 화면 쪽 규칙.
 *
 * 1. **한 번만 말한다.** 같은 사용자의 탭이 여러 개면 모두가 같은 SSE 를 받는다 — 먼저 집은 탭만
 *    말하고, 보이는 탭이 숨은 탭보다 먼저 집는다(숨은 탭은 잠깐 양보한 뒤 시도한다).
 * 2. **보고 있는 것은 말하지 않는다.** 그 세션을 지금 보고 있으면 화면이 이미 답을 읽고 있다 — 그
 *    탭이 알림을 "처리됨" 으로 집어 두어 다른 탭도 말하지 않게 한다.
 */

const CLAIM_PREFIX = 'awb.voice.claimed.';
const CLAIM_LOCK = 'awb-voice-announcement-claim';
/** 숨은 탭이 보이는 탭에게 양보하는 시간. */
export const HIDDEN_TAB_YIELD_MS = 700;
const CLAIM_KEEP_MS = 24 * 60 * 60 * 1000;

export function sessionTargetKey(managerId: string, cli: string, sessionId: string): string {
  return `${managerId}/${cli}/${sessionId}`;
}

let viewingSessionKey: string | null = null;

/** 세션 화면이 열려 있는 동안 등록한다. 알림이 같은 세션을 가리키면 그 알림은 말하지 않는다. */
export function setViewingSession(key: string | null): void {
  viewingSessionKey = key;
}

export function isViewingTarget(target: VoiceAnnouncementTarget | null | undefined, visible: boolean): boolean {
  return !!target && visible && target.type === 'session'
    && viewingSessionKey === sessionTargetKey(target.manager_id, target.cli, target.session_id);
}

/**
 * 보고 있는 세션의 일반 소식은 조용히 처리한다. 승인·질문은 보고 있어도 알림음을 낸다.
 * 선택지 설명과 음성 답변은 사용자가 operator 에게 자세한 내용을 요청한 뒤 시작한다.
 */
export function shouldSpeakAnnouncement(viewingTarget: boolean, needsDecision: boolean): boolean {
  return !viewingTarget || needsDecision;
}

/** Stable work URLs do not include the default ownership account. */
export function announcementPath(target: VoiceAnnouncementTarget | null | undefined, accountId: string | null): string | null {
  if (!target) return null;
  if (target.type === 'mission') return `/missions/${target.mission_id}`;
  return `/sessions/${encodeURIComponent(target.manager_id)}/${encodeURIComponent(target.cli)}/${encodeURIComponent(target.session_id)}`;
}

export interface ClaimStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length: number;
  key(index: number): string | null;
}

/** 한 탭만 이기는 집기. 저장소의 확인-기록은 탭 사이 잠금(Web Locks) 안에서 한다. */
export function tryClaim(id: string, storage: ClaimStorage, now: number = Date.now()): boolean {
  const key = CLAIM_PREFIX + id;
  if (storage.getItem(key)) return false;
  storage.setItem(key, String(now));
  // 오래된 표시는 치운다 — 알림마다 하나씩 쌓이므로.
  for (let i = storage.length - 1; i >= 0; i--) {
    const k = storage.key(i);
    if (!k || !k.startsWith(CLAIM_PREFIX) || k === key) continue;
    const at = Number(storage.getItem(k));
    if (!Number.isFinite(at) || now - at > CLAIM_KEEP_MS) storage.removeItem(k);
  }
  return true;
}

export async function claimAnnouncement(id: string, visible: boolean): Promise<boolean> {
  if (!visible) await new Promise((r) => setTimeout(r, HIDDEN_TAB_YIELD_MS));
  const locks = (navigator as any).locks as { request?: (name: string, cb: () => boolean) => Promise<boolean> } | undefined;
  if (!locks?.request) return tryClaim(id, localStorage);
  return locks.request(CLAIM_LOCK, () => tryClaim(id, localStorage));
}
