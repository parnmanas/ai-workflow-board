import { Injectable } from '@nestjs/common';

/**
 * 지금 어느 세션 화면을 보고 있는가(docs/voice-operator.md "작업 보고"). 보고 있는 세션의 완료는 operator
 * 에게 보고하지 않는다 — 사용자가 이미 보고 있다. 화면이 세션을 열고 닫을 때와 30초마다 알려 오고,
 * 알림이 끊긴 탭은 `PRESENCE_TTL_MS` 뒤에 잊는다(탭을 닫았거나 서버가 다시 떴다).
 *
 * 메모리에만 둔다. 서버가 다시 뜨면 다음 알림(30초 안)까지는 "아무것도 보고 있지 않음" 이다 — 그
 * 사이에 끝난 턴은 보고된다(놓치는 쪽보다 한 번 더 듣는 쪽이 낫다).
 */
export const PRESENCE_TTL_MS = 75_000;
const MAX_TABS_PER_USER = 20;

interface TabPresence {
  key: string | null;
  visible: boolean;
  at: number;
}

export const presenceKey = (managerId: string, cli: string, sessionId: string) => `${managerId}\u0000${cli}\u0000${sessionId}`;

@Injectable()
export class VoicePresenceService {
  #tabs = new Map<string, Map<string, TabPresence>>();

  update(userId: string, tabId: string, session: { manager_id: string; cli: string; session_id: string } | null, visible: boolean, now = Date.now()): void {
    if (!userId || !tabId) return;
    let tabs = this.#tabs.get(userId);
    if (!tabs) {
      tabs = new Map();
      this.#tabs.set(userId, tabs);
    }
    tabs.delete(tabId); // 최근 것이 뒤로 — 상한을 넘으면 가장 오래 소식 없는 탭부터 잊는다
    tabs.set(tabId, { key: session ? presenceKey(session.manager_id, session.cli, session.session_id) : null, visible, at: now });
    while (tabs.size > MAX_TABS_PER_USER) tabs.delete(tabs.keys().next().value as string);
  }

  /** 이 사용자의 보이는 탭 중 하나가 그 세션을 보고 있다. */
  isViewing(userId: string, managerId: string, cli: string, sessionId: string, now = Date.now()): boolean {
    const tabs = this.#tabs.get(userId);
    if (!tabs) return false;
    const key = presenceKey(managerId, cli, sessionId);
    for (const [tabId, tab] of tabs) {
      if (now - tab.at > PRESENCE_TTL_MS) {
        tabs.delete(tabId);
        continue;
      }
      if (tab.visible && tab.key === key) return true;
    }
    return false;
  }
}
