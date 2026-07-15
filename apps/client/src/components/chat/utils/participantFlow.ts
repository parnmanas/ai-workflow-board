// 채팅 참여자 로스터/후보 흐름의 순수 로직 (ChatPage.tsx / ParticipantPicker.tsx 공용).
//
// ChatPage 안 클로저·effect 에 흩어져 있던 참여자 흐름을 프레임워크 비의존
// 순수 함수 + 의존성 주입 팩토리로 뽑아, 컴포넌트와 회귀 테스트가 "같은 코드"를
// 실행하도록 한다. 원본 티켓 141b7414 의 P2(방 전환 후 늦게 도착한 참여자 재조회
// 응답이 현재 방 로스터를 덮어쓰는 경합)는 브라우저 E2E 하네스 부재로 자동 검증이
// 없었다 — 이 모듈이 그 공백을 메운다. 회귀 테스트: apps/client/test/chat-participants.test.mjs
//
// 규칙: 여기 담긴 매핑/가드는 ChatPage·ParticipantPicker 의 기존 동작을 "그대로"
// 옮긴 것이다. 동작을 바꾸려면 컴포넌트가 아니라 이 모듈을 고치고 테스트를 갱신할 것.

import type { ChatRoomListItem } from '../../../types';
import type { MentionParticipant } from './markdown';

// 방 상세(getChatRoom) 응답의 참여자 행 — wire 는 participant_id / participant_type
// 를 쓰고, (ChatRoomParticipantInfo 타입 선언과 달리) 평평한 `name` 을 내려준다.
// ChatPage 의 역대 매핑을 그대로 반영한다.
export interface RoomDetailParticipantWire {
  participant_id: string;
  participant_type: 'user' | 'agent';
  name: string;
}
export interface RoomDetailLike {
  participants?: RoomDetailParticipantWire[];
}

// "Add People"/"New Chat" 후보 한 명. 구조적으로 ParticipantPicker 의
// PickerParticipant 와 동일해 그대로 setParticipants 에 넣을 수 있다.
export interface ChatParticipantCandidate {
  id: string;
  name: string;
  type: 'user' | 'agent';
}

/**
 * 방 상세 응답의 참여자 배열을 멘션/로스터용 MentionParticipant[] 로 투영한다.
 * (ChatPage 의 refresh 경로와 방 변경 effect 두 곳에서 중복되던 매핑을 통합)
 */
export function projectParticipants(detail: RoomDetailLike | null | undefined): MentionParticipant[] {
  if (!detail?.participants) return [];
  return detail.participants.map((p) => ({
    id: p.participant_id,
    name: p.name,
    type: p.participant_type,
  }));
}

/** 로스터에서 사람(user) 참여자 수 — 헤더의 participantCount 계산. */
export function countUserParticipants(participants: MentionParticipant[]): number {
  return participants.filter((p) => p.type === 'user').length;
}

// ─── 활성 방 로스터 재조회 (P2 stale-response 가드) ───────────────────────────

export interface RefreshRosterDeps {
  // 방 상세 조회. observer 인자는 워크스페이스 관찰 모드에서 403 을 피하려 전달한다.
  // 반환을 any 로 둔 이유: 서버 wire 는 평평한 `name` 을 내려주지만 선언 타입
  // ChatRoomDetail.participants(ChatRoomParticipantInfo)는 participant_name 을 쓰는
  // 기존 불일치가 있어, ChatPage 도 역대 `detail: any` 로 읽어 왔다(동작 보존).
  getChatRoom: (roomId: string, observer: boolean) => Promise<any>;
  /** 응답 시점의 현재 활성 방 id (ChatPage 에선 activeRoomIdRef.current). */
  getActiveRoomId: () => string | null;
  /** 요청 시작 시점의 observer 여부 (ChatPage 에선 isObserverRef.current). */
  isObserver: () => boolean;
  setRoomParticipants: (participants: MentionParticipant[]) => void;
  setParticipantCount: (count: number) => void;
}

/**
 * 활성 방의 참여자 로스터(roomParticipants/participantCount)를 서버 최신값으로
 * 재조회하는 함수를 만든다. 참여자 추가/이탈 직후 상단 로스터를 즉시 반영하려
 * 모달 콜백 + participant_* SSE 양쪽에서 호출한다.
 *
 * Stale-response 가드(P2, 티켓 141b7414): 재조회를 시작한 방이 **응답 시점에도**
 * 여전히 활성 방일 때만 로스터를 반영한다. 그 사이 다른 방으로 전환하고 새 방
 * 상세가 먼저 도착했다면, 늦게 도착한 이전 방 응답이 현재 방 로스터/카운트를
 * 덮어써 "현재 참여자"가 잘못 표시되므로 폐기한다.
 */
export function makeRefreshActiveRoomParticipants(
  deps: RefreshRosterDeps,
): (roomId: string) => void {
  return (roomId: string) => {
    deps
      .getChatRoom(roomId, deps.isObserver())
      .then((detail) => {
        // 가드 1: 응답이 도착한 지금도 이 방이 활성 방인가? 아니면 폐기.
        if (deps.getActiveRoomId() !== roomId) return;
        // 가드 2: 참여자 필드가 없으면 로스터를 건드리지 않는다(빈 배열로 지우지 않음).
        if (!detail?.participants) return;
        const participants = projectParticipants(detail);
        deps.setRoomParticipants(participants);
        deps.setParticipantCount(countUserParticipants(participants));
      })
      .catch(() => {});
  };
}

// ─── 참여자 추가/이탈 반영 (방 목록 + 활성 방 로스터) ─────────────────────────

export interface ReflectParticipantChangeDeps {
  /** 현재 스코프(내 방/워크스페이스) 그대로 방 목록 재조회. */
  listChatRooms: () => Promise<ChatRoomListItem[]>;
  setRooms: (rooms: ChatRoomListItem[]) => void;
  getActiveRoomId: () => string | null;
  /** makeRefreshActiveRoomParticipants 가 만든 함수. */
  refreshActiveRoomParticipants: (roomId: string) => void;
}

/**
 * 참여자 추가/이탈이 반영돼야 할 때(모달 콜백 + participant_added/left SSE) 공통 반응:
 *  ① 방 목록의 참여자 프로젝션을 현재 스코프 그대로 재조회한다.
 *  ② 바뀐 방이 지금 열려 있으면 상단 로스터도 즉시 재조회한다
 *     (다른 사용자의 추가/이탈까지 실시간 반영).
 */
export function reflectParticipantChange(
  deps: ReflectParticipantChangeDeps,
  roomId: string | null | undefined,
): void {
  deps.listChatRooms().then(deps.setRooms).catch(() => {});
  if (roomId && roomId === deps.getActiveRoomId()) {
    deps.refreshActiveRoomParticipants(roomId);
  }
}

// ─── Add People / New Chat 후보 빌더 (기존 참여자·본인·매니저 제외) ───────────

export interface AddPeopleCandidateSource {
  users: Array<{ id: string; name: string }>;
  /** type==='manager' 인 Agent Manager 는 채팅 참가 불가라 후보에서 제외한다. */
  agents: Array<{ id: string; type?: string; [key: string]: unknown }>;
  /** 방에 이미 있는 참여자 id — 중복 선택 방지로 제외. */
  existingParticipantIds?: string[];
  /** 본인은 후보에서 제외. */
  currentUserId?: string | null;
  /** 에이전트 표시 이름 포매터 (ParticipantPicker 는 formatAgentDisplayName 주입). */
  formatAgentName: (agent: any) => string;
}

/**
 * "Add People"/"New Chat" 후보 목록을 만든다. 서버의 users+agents 원본에서:
 *  ① 기존 참여자(existingParticipantIds) 제외, ② 본인(currentUserId) 제외,
 *  ③ Agent Manager(type==='manager', 티켓 941c72d3) 제외 후 후보로 매핑한다.
 */
export function buildAddPeopleCandidates(
  src: AddPeopleCandidateSource,
): ChatParticipantCandidate[] {
  const excludeIds = new Set(
    [...(src.existingParticipantIds ?? []), src.currentUserId].filter(Boolean) as string[],
  );
  return [
    ...src.users.map((u) => ({ id: u.id, name: u.name, type: 'user' as const })),
    ...src.agents
      .filter((a) => a.type !== 'manager')
      .map((a) => ({ id: a.id, name: src.formatAgentName(a), type: 'agent' as const })),
  ].filter((p) => !excludeIds.has(p.id));
}
