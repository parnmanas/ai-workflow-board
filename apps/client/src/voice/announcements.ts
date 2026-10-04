import type { VoiceAnnouncementTarget } from '../types';

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
 * 이 탭이 알림을 소리로 낼까. 보고 있는 세션에 대한 알림은 말하지 않는다(화면이 이미 보여 준다) — 단 결정을
 * 기다리는 operator 보고(승인·질문)는 보고 있어도 읽는다: 선택지를 듣고 말로 답하는 것이 그 알림의 쓰임새다.
 */
export function shouldSpeakAnnouncement(viewingTarget: boolean, needsDecision: boolean): boolean {
  return !viewingTarget || needsDecision;
}

/** 알림이 가리키는 화면 경로. 세션 경로에는 지금 워크스페이스가 필요하다(세션은 워크스페이스에 매이지 않는다). */
export function announcementPath(target: VoiceAnnouncementTarget | null | undefined, workspaceId: string | null): string | null {
  if (!target) return null;
  if (target.type === 'mission') return `/ws/${target.workspace_id}/orchestration/missions/${target.mission_id}`;
  if (!workspaceId) return null;
  return `/ws/${workspaceId}/sessions/${encodeURIComponent(target.manager_id)}/${encodeURIComponent(target.cli)}/${encodeURIComponent(target.session_id)}`;
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
