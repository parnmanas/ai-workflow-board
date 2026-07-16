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

/**
 * "Add People"/"New Chat" 후보를 서버에서 로드해 세터에 넣는다. ParticipantPicker 의
 * open effect 가 실제로 구동하던 fetch→build→set 배선을 그대로 옮긴 것 — 회귀 테스트가
 * (컴포넌트 미러가 아니라) 이 함수를 직접 구동해 "후보 목록을 잘못 set 하는" 오배선을
 * 잡는다. users/agents 조회는 개별적으로 실패해도 빈 배열로 폴백한다(네트워크 방어).
 */
export function loadAddPeopleCandidates(
  deps: LoadAddPeopleCandidatesDeps,
): Promise<void> {
  return Promise.all([
    deps.getUsers().catch(() => [] as Array<{ id: string; name: string }>),
    deps.getAgents().catch(() => [] as Array<{ id: string; type?: string }>),
  ]).then(([users, agents]) => {
    deps.setParticipants(
      buildAddPeopleCandidates({
        users,
        agents,
        existingParticipantIds: deps.existingParticipantIds,
        currentUserId: deps.currentUserId,
        formatAgentName: deps.formatAgentName,
      }),
    );
  });
}

export interface LoadAddPeopleCandidatesDeps {
  /** 사용자 목록 조회 (ParticipantPicker 는 api.getUsers). */
  getUsers: () => Promise<Array<{ id: string; name: string }>>;
  /** 에이전트 목록 조회 (ParticipantPicker 는 api.getAgents). */
  getAgents: () => Promise<Array<{ id: string; type?: string; [key: string]: unknown }>>;
  existingParticipantIds?: string[];
  currentUserId?: string | null;
  formatAgentName: (agent: any) => string;
  setParticipants: (candidates: ChatParticipantCandidate[]) => void;
}

// ─── chat_room_update SSE 디스패치 (봉투 unwrap + update_type 분기) ─────────────

/** rooms 상태 세터 — React useState 세터처럼 값 또는 updater 함수를 받는다. */
export type ChatRoomListSetter = (
  update: ChatRoomListItem[] | ((prev: ChatRoomListItem[]) => ChatRoomListItem[]),
) => void;

export interface ChatRoomUpdateDispatchDeps {
  /** 본인 user id — read 이벤트가 내 것인지 판별 (ChatPage 는 user?.id). */
  currentUserId: string | null | undefined;
  /** 응답 시점 활성 방 id (ChatPage 는 activeRoomIdRef.current). */
  getActiveRoomId: () => string | null;
  /** 현재 스코프 그대로 방 목록 재조회 (ChatPage 는 showAllRooms 반영 클로저). */
  listChatRooms: () => Promise<ChatRoomListItem[]>;
  setRooms: ChatRoomListSetter;
  /** makeRefreshActiveRoomParticipants 가 만든 활성 방 로스터 재조회 함수. */
  refreshActiveRoomParticipants: (roomId: string) => void;
}

/**
 * `chat_room_update` SSE 를 처리한다. ChatPage 의 useBoardStreamEvent 콜백 본문을
 * 그대로 옮긴 것 — 컴포넌트는 이제 ref/세터만 주입해 이 함수에 위임하므로, 회귀
 * 테스트가 **실제 이벤트 페이로드**로 이 디스패치(봉투 unwrap + update_type 분기)를
 * 직접 구동한다. 그래서 참여자 추가/이탈 분기를 지우거나 다른 분기로 오배선하면
 * 테스트가 실패한다(원본 티켓 141b7414 P2 경합의 연결부 회귀 커버).
 *
 * 서버는 `{ event_type, payload, scope, timestamp }` 봉투 또는 평평한 payload 를
 * 보낸다 — 두 shape 모두 지원한다. 분기(동작 보존):
 *  - renamed          → 방 목록의 해당 방 이름만 갱신
 *  - participant_added/left → reflectParticipantChange (방 목록 + 활성 방 로스터)
 *  - read(본인)       → 해당 방 unread 를 0 으로 (다른 탭/기기 동기화)
 */
export function dispatchChatRoomUpdate(
  deps: ChatRoomUpdateDispatchDeps,
  rawData: any,
): void {
  if (!rawData) return;
  // 서버 봉투({ payload }) 또는 평평한 payload 양쪽 지원.
  const payload = rawData.payload ?? rawData;
  if (payload.update_type === 'renamed' && payload.room_id && payload.new_name) {
    deps.setRooms((prev) =>
      prev.map((r) => (r.id === payload.room_id ? { ...r, name: payload.new_name } : r)),
    );
  } else if (
    payload.update_type === 'participant_added' ||
    payload.update_type === 'participant_left'
  ) {
    // 방 목록(현재 스코프 그대로) + 열려 있는 방의 로스터를 함께 갱신 —
    // 다른 사용자의 추가/이탈까지 실시간 반영.
    reflectParticipantChange(
      {
        listChatRooms: deps.listChatRooms,
        setRooms: deps.setRooms,
        getActiveRoomId: deps.getActiveRoomId,
        refreshActiveRoomParticipants: deps.refreshActiveRoomParticipants,
      },
      payload.room_id,
    );
  } else if (
    payload.update_type === 'read' &&
    payload.room_id &&
    payload.participant_type === 'user' &&
    payload.participant_id === deps.currentUserId
  ) {
    // B3: 같은 사용자가 다른 탭/기기에서 읽음 → 로컬 unread 를 0 으로 동기화.
    deps.setRooms((prev) =>
      prev.map((r) => (r.id === payload.room_id ? { ...r, unread_count: 0 } : r)),
    );
  }
}
