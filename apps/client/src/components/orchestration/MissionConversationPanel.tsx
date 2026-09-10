import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { ChatRoomMessageItem, OrchestrationTimelineEvent, OrchestrationUserChatMode } from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useAuth } from '../../contexts/AuthContext';
import MessageList from '../chat/MessageList';
import ChatMessageInput from '../chat/ChatMessageInput';
import { projectParticipants, countUserParticipants } from '../chat/utils/participantFlow';
import type { MentionParticipant } from '../chat/utils/markdown';
import { eventColor } from './status';
import { relativeTime } from '../../utils/time';

/**
 * 서버 `PERMISSIONS.MANAGE_ACTIONS` 와 같은 문자열. 클라이언트에는 권한 상수 모듈이 없어
 * 다른 화면들도 리터럴을 쓴다(`hasPermission('admin.access')` 등) — 그 관행을 따르되,
 * 이 값이 서버 상수와 짝이라는 사실을 여기 한 곳에 적어 둔다.
 */
const MANAGE_ACTIONS = 'admin.actions';

/**
 * Mission 화면의 대화 패널 — 진행 중인 orchestrator 에게 직접 묻고 방향을 바꾸는 곳.
 *
 * 새 채팅 구현을 만들지 않고 기존 Chat 의 두 primitive 를 그대로 재사용한다:
 * `MessageList`(마크다운·첨부·ref 카드·멘션 렌더링)와 `ChatMessageInput`(작성·첨부
 * 업로드·멘션 자동완성·전송). 그래서 이 패널은 "또 하나의 채팅 UI"가 아니라 미션
 * room 에 붙인 같은 채팅이고, Chat 쪽 UX 개선이 자동으로 따라온다.
 *
 * 대화가 미션에 귀속되는 근거는 `mission.room_id` 다 — orchestrator 브리핑이 오가는
 * 바로 그 ChatRoom 이라, 여기서 보낸 메시지는 orchestrator 세션의 대화 맥락에
 * 그대로 들어가고 서버에 영속되므로 재시작 뒤에도 기록과 thread context 가 남는다.
 *
 * ── 실행 이벤트와 대화 메시지의 구분 ────────────────────────────────────────
 * 둘을 한 스트림에 섞되 **서로 다른 렌더러**로 그린다. 실행 이벤트를 가짜 채팅
 * 메시지로 만들어 MessageList 에 밀어 넣지 않는다 — 그렇게 하면 첨부/ref 카드/
 * 발신자 그룹핑 같은 MessageList 의 계약이 전부 거짓이 된다. 대신 시간순으로
 * 구간을 나눠, 대화 구간은 MessageList 로, 실행 구간은 전용 compact 행으로 그린다.
 * 운영자가 "내가 방향을 바꾼 직후 무엇이 디스패치됐는지"를 한 화면에서 읽을 수 있는
 * 것이 이 패널의 존재 이유다.
 */

/** 한 번에 불러오는 메시지 수. 스크롤을 위로 올리면 같은 크기로 이어 붙인다. */
const PAGE_SIZE = 50;

/** 이 거리 안쪽까지 올라가면 과거 메시지를 더 부른다. */
const LOAD_OLDER_THRESHOLD = 120;

/** 이 거리 안쪽이면 "맨 아래를 보고 있다"고 보고 새 메시지에 자동 추종한다. */
const NEAR_BOTTOM_THRESHOLD = 80;

/**
 * 한 번에 DOM 에 유지하는 실행 이벤트 수의 상한(bounded window).
 *
 * 긴 미션의 타임라인은 수천 건이라 전부 그리면 패널이 멈춘다. 그렇다고 잘라 버리면
 * 이전 이력을 볼 방법이 사라지므로, **창을 뒤로 밀 수 있게** 함께 만들었다:
 * 위로 스크롤하면 `listOrchestrationMissionEvents` 커서로 과거 이벤트를 이어 붙이고,
 * 창 크기를 넘으면 화면 밖 반대쪽 끝을 잘라 DOM 노드 수를 일정하게 유지한다.
 *
 * (이전 주석은 "Timeline 섹션이 전체 이력을 갖고 있으니 잘라도 된다"고 적었는데
 *  사실이 아니었다 — mission detail 응답 자체가 최신 N건만 싣는 bounded window 다.)
 */
const EVENT_WINDOW = 200;

/** 과거 이벤트를 한 번에 가져오는 크기. */
const EVENT_PAGE_SIZE = 100;

type Track =
  | { kind: 'messages'; at: string; messages: ChatRoomMessageItem[] }
  | { kind: 'events'; at: string; events: OrchestrationTimelineEvent[] };

/**
 * 메시지와 실행 이벤트를 시간순으로 병합하되 같은 종류가 연속되면 한 덩어리로 묶는다.
 * MessageList 는 발신자 연속 그룹핑과 날짜 구분선을 자기가 계산하므로, 한 메시지씩
 * 쪼개 넘기면 그 계산이 전부 깨진다 — 그래서 "구간" 단위로 넘긴다.
 */
export function buildConversationTracks(
  messages: ChatRoomMessageItem[],
  events: OrchestrationTimelineEvent[],
): Track[] {
  const items: Array<{ at: number; message?: ChatRoomMessageItem; event?: OrchestrationTimelineEvent }> = [];
  for (const m of messages) items.push({ at: new Date(m.created_at).getTime(), message: m });
  for (const e of events) items.push({ at: new Date(e.created_at).getTime(), event: e });
  // 같은 밀리초에 대화와 실행이 겹치면 실행 이벤트를 뒤에 둔다 — 사용자의 지시가
  // 먼저 보이고 그로 인해 벌어진 일이 뒤따르는 순서가 읽기 자연스럽다.
  items.sort((a, b) => a.at - b.at || (a.message ? -1 : 1) - (b.message ? -1 : 1));

  const tracks: Track[] = [];
  for (const item of items) {
    const last = tracks[tracks.length - 1];
    if (item.message) {
      if (last?.kind === 'messages') last.messages.push(item.message);
      else tracks.push({ kind: 'messages', at: item.message.created_at, messages: [item.message] });
    } else if (item.event) {
      if (last?.kind === 'events') last.events.push(item.event);
      else tracks.push({ kind: 'events', at: item.event.created_at, events: [item.event] });
    }
  }
  return tracks;
}

interface MissionConversationPanelProps {
  missionId: string;
  /** 이벤트 커서 조회에 필요한 workspace 스코프. */
  workspaceId: string;
  /** orchestrator 대화가 오가는 ChatRoom. null 이면 미션이 아직 시작되지 않은 것이다. */
  roomId: string | null;
  /** 실행 trace — 대화와 시간순으로 엮어 보여준다. */
  events: OrchestrationTimelineEvent[];
  /** 종료된 미션에서는 입력을 막는다(보낼 orchestrator 세션이 없다). */
  live: boolean;
  /**
   * 미션의 chat 옵션(티켓 9cfd8161). 서버 게이트와 **같은 값**을 보고 같은 순서로
   * 판정해야, 화면이 입력창을 열어놓고 전송 순간에만 403 이 뜨는 일이 없다.
   */
  userChatMode?: OrchestrationUserChatMode;
  currentUserId?: string;
}

export default function MissionConversationPanel({
  missionId,
  workspaceId,
  roomId,
  events,
  live,
  userChatMode = 'open',
  currentUserId,
}: MissionConversationPanelProps) {
  const { user, hasPermission } = useAuth();
  // 프롭이 있으면 그걸 쓰고, 없으면 로그인 사용자를 쓴다 — "내 메시지" 정렬/스타일이
  // 이 값으로 갈린다.
  const viewerId = currentUserId ?? user?.id;
  const [messages, setMessages] = useState<ChatRoomMessageItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 참여자가 아니면 서버가 읽기를 거부한다. 그때만 observer 모드로 한 번 더 시도해
   * "읽기 전용"으로 떨어뜨린다 — 권한이 없는 사용자에게 조용히 빈 패널을 보여주는
   * 대신 왜 못 쓰는지 알려주기 위해서다.
   */
  const [observer, setObserver] = useState(false);
  /** 참여 요청이 진행 중인가 — 버튼 중복 클릭을 막고 진행 상태를 보여준다. */
  const [joining, setJoining] = useState(false);
  /** 참여 실패 사유(권한 없음 등). 조용히 실패하면 사용자는 버튼이 죽은 줄 안다. */
  const [joinError, setJoinError] = useState<string | null>(null);
  /**
   * 참여자 로스터 — 없으면 `MessageList` 가 `@[user:uuid|이름]` 을 pill 로 못 그리고
   * 읽음 수("Read by N")도 표시하지 못한다. 즉 "기존 Chat 의 멘션·읽음 UX 재사용"이
   * 로스터 없이는 성립하지 않는다.
   */
  const [participants, setParticipants] = useState<MentionParticipant[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  /** 커서로 추가로 가져온 과거 실행 이벤트(오래된 것부터). */
  const [olderEvents, setOlderEvents] = useState<OrchestrationTimelineEvent[]>([]);
  const [eventCursor, setEventCursor] = useState<{ at: string; seq: number } | null>(null);
  const [hasMoreEvents, setHasMoreEvents] = useState(false);
  const loadingEventsRef = useRef(false);
  /**
   * 창이 어느 쪽 끝에 붙어 있는가.
   *
   * `latest`(기본) = 최신 끝. 새 이벤트를 따라간다.
   * `history`      = 과거 끝. 사용자가 위로 스크롤해 과거를 불러온 상태다.
   *
   * 이 상태가 없으면 창을 항상 `slice(-N)` 으로 잡게 되는데, 그러면 방금 앞에 붙인
   * 과거 페이지가 그 자리에서 잘려나가 **N건보다 오래된 이벤트는 영원히 볼 수 없다**.
   * "창을 뒤로 민다"는 설명과 정반대 동작이 된다(리뷰 라운드2 P1 지적).
   */
  const [eventWindowEdge, setEventWindowEdge] = useState<'latest' | 'history'>('latest');

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  /** 과거 로드 직전의 스크롤 높이 — 로드 후 위치를 보정해 화면이 튀지 않게 한다. */
  const pendingAnchorRef = useRef<number | null>(null);

  // ── 미션 경계 (리뷰 라운드3 P0) ─────────────────────────────────────────────
  //
  // 이 패널의 상태는 전부 **한 미션에 귀속**된다. 그런데 라우터는 미션 A → B 로 옮길 때
  // 같은 컴포넌트 인스턴스를 재사용하므로, 초기화하지 않으면 A 에서 커서로 불러온
  // `olderEvents` 가 B 의 `events` 앞에 그대로 합쳐져 렌더링된다 — 미션 기록 경계가
  // 깨지는 사용자 가시 결함이다. `messages`/`observer`/`error` 도 B 의 조회가 끝날
  // 때까지 A 값이 노출된다.
  //
  // 초기화를 `useEffect` 로 하지 않고 **렌더 단계**에서 하는 이유: effect 는 커밋 뒤에
  // 돌기 때문에 A 의 데이터가 최소 한 프레임 그려진다. 아래 방식은 React 의 "props 가
  // 바뀌면 렌더 중에 state 를 조정한다" 패턴이라, 낡은 화면이 한 프레임도 커밋되지 않는다.
  const missionKey = `${missionId}|${roomId ?? ''}`;
  const [renderedMissionKey, setRenderedMissionKey] = useState(missionKey);
  // 늦게 도착하는 응답이 새 미션의 상태를 덮어쓰지 못하게 하는 출처 표식. 클로저 캡처만으로는
  // 막을 수 없다 — 응답을 적용할 시점에 "지금 화면의 미션"과 대조해야 한다.
  const activeMissionKeyRef = useRef(missionKey);
  if (renderedMissionKey !== missionKey) {
    setRenderedMissionKey(missionKey);
    activeMissionKeyRef.current = missionKey;
    setMessages([]);
    setOlderEvents([]);
    setEventCursor(null);
    setHasMoreEvents(false);
    setEventWindowEdge('latest');
    setParticipants([]);
    setParticipantCount(0);
    setObserver(false);
    setJoining(false);
    setJoinError(null);
    setError(null);
    setHasMore(false);
    setLoading(true);
    setLoadingOlder(false);
    loadingOlderRef.current = false;
    loadingEventsRef.current = false;
    pendingAnchorRef.current = null;
  }

  const load = useCallback(async () => {
    if (!roomId) return;
    // 이 조회가 어느 미션의 것인지 박아둔다 — 응답이 늦게 오는 사이 사용자가 다른
    // 미션으로 옮겼다면 그 결과를 적용하면 안 된다.
    const issuedFor = `${missionId}|${roomId}`;
    const stillCurrent = () => activeMissionKeyRef.current === issuedFor;
    setLoading(true);
    setError(null);
    try {
      let asObserver = false;
      let rows: ChatRoomMessageItem[];
      try {
        rows = await api.getChatRoomMessages(roomId, PAGE_SIZE);
      } catch (e: any) {
        // 참여자가 아닌 경우에만 관전 모드로 재시도한다.
        rows = await api.getChatRoomMessages(roomId, PAGE_SIZE, undefined, true);
        asObserver = true;
      }
      if (!stillCurrent()) return;
      setObserver(asObserver);
      setMessages(rows);
      setHasMore(rows.length >= PAGE_SIZE);

      // 로스터는 멘션 pill 렌더링과 읽음 수에 쓰인다. 실패해도 대화 자체는 계속
      // 보여준다 — 부가 정보 때문에 본문을 막을 이유가 없다.
      try {
        // `any` 캐스팅은 ChatPage 와 같은 이유다: 서버 wire 는 평평한 `name` 을
        // 내려주는데 선언 타입 `ChatRoomDetail.participants` 는 `participant_name` 을
        // 쓰는 기존 불일치가 있다(participantFlow.ts 주석 참고). 여기서 타입을
        // 새로 맞추려 들면 그 불일치를 이 파일에만 다르게 해석하는 셈이 된다.
        const detail: any = await api.getChatRoom(roomId, asObserver);
        const roster = projectParticipants(detail);
        if (!stillCurrent()) return;
        setParticipants(roster);
        setParticipantCount(countUserParticipants(roster));
      } catch {
        if (!stillCurrent()) return;
        setParticipants([]);
        setParticipantCount(0);
      }

      // 관전자는 남의 방 읽음 표시를 건드리면 안 된다(ChatPage 와 같은 규칙).
      if (!asObserver) api.markChatRoomRead(roomId).catch(() => {});
    } catch (e: any) {
      if (!stillCurrent()) return;
      setError(e?.message || '대화를 불러오지 못했습니다');
      setMessages([]);
    } finally {
      if (stillCurrent()) setLoading(false);
    }
  }, [missionId, roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = useCallback(async () => {
    if (!roomId || loadingOlderRef.current || !hasMore || messages.length === 0) return;
    const issuedFor = `${missionId}|${roomId}`;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    pendingAnchorRef.current = scrollRef.current?.scrollHeight ?? null;
    try {
      const older = await api.getChatRoomMessages(roomId, PAGE_SIZE, messages[0].id, observer);
      if (activeMissionKeyRef.current !== issuedFor) return;
      setHasMore(older.length >= PAGE_SIZE);
      if (older.length > 0) {
        setMessages((prev) => {
          const known = new Set(prev.map((m) => m.id));
          return [...older.filter((m) => !known.has(m.id)), ...prev];
        });
      }
    } catch {
      // 조용히 실패한다 — 사용자가 다시 위로 올리면 재시도된다.
    } finally {
      setLoadingOlder(false);
      loadingOlderRef.current = false;
    }
  }, [roomId, hasMore, messages, observer]);

  // 과거 메시지를 앞에 붙인 만큼 스크롤을 내려 보던 위치를 유지한다.
  useEffect(() => {
    const anchor = pendingAnchorRef.current;
    const el = scrollRef.current;
    if (anchor == null || !el) return;
    pendingAnchorRef.current = null;
    el.scrollTop += el.scrollHeight - anchor;
  }, [messages]);

  // detail 이 실어준 첫 페이지의 가장 오래된 이벤트가 커서의 출발점이다.
  useEffect(() => {
    if (events.length === 0) {
      setEventCursor(null);
      setHasMoreEvents(false);
      return;
    }
    const oldest = events[0];
    setEventCursor({ at: oldest.created_at, seq: oldest.write_seq ?? 0 });
    // detail 의 창이 가득 찼다면 그 뒤로 더 있을 수 있다고 본다.
    setHasMoreEvents(events.length >= EVENT_PAGE_SIZE);
  }, [events]);

  const loadOlderEvents = useCallback(async () => {
    if (!workspaceId || loadingEventsRef.current || !hasMoreEvents || !eventCursor) return;
    const issuedFor = `${missionId}|${roomId ?? ''}`;
    loadingEventsRef.current = true;
    try {
      const page = await api.listOrchestrationMissionEvents(missionId, workspaceId, {
        limit: EVENT_PAGE_SIZE,
        before_at: eventCursor.at,
        before_seq: eventCursor.seq,
      });
      // 미션이 바뀐 뒤 도착한 페이지를 붙이면 남의 미션 이력이 섞인다.
      if (activeMissionKeyRef.current !== issuedFor) return;
      // 서버는 최신 → 과거 순으로 준다. 화면은 과거 → 최신이므로 뒤집어 앞에 붙인다.
      const older = [...page.events].reverse();
      if (older.length > 0) {
        setOlderEvents((prev) => {
          const known = new Set(prev.map((e) => e.id));
          return [...older.filter((e) => !known.has(e.id)), ...prev];
        });
        // 방금 가져온 과거를 실제로 보여주려면 창이 과거 끝을 향해야 한다.
        setEventWindowEdge('history');
      }
      setHasMoreEvents(page.has_more);
      if (page.next_cursor) setEventCursor(page.next_cursor);
    } catch {
      // 조용히 실패한다 — 다시 위로 올리면 재시도된다.
    } finally {
      loadingEventsRef.current = false;
    }
  }, [missionId, workspaceId, hasMoreEvents, eventCursor]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD) {
      void loadOlder();
      void loadOlderEvents();
      return;
    }
    // 맨 아래로 돌아오면 창을 다시 최신 끝에 붙인다 — 그래야 실시간 이벤트가 보인다.
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_THRESHOLD) setEventWindowEdge('latest');
  }, [loadOlder, loadOlderEvents]);

  // 새 메시지 자동 추종 — 사용자가 위쪽 이력을 읽는 중이면 끌어내리지 않는다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // 과거를 파고 있는 중이면 새 이벤트가 와도 끌어내리지 않는다.
    if (eventWindowEdge === 'history') return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_THRESHOLD + 200) el.scrollTop = el.scrollHeight;
  }, [messages.length, events.length, eventWindowEdge]);

  useBoardStreamEvent(
    'chat_room_message',
    useCallback(
      (data: any) => {
        const msg = data as ChatRoomMessageItem;
        if (!msg?.room_id || msg.room_id !== roomId) return;
        // POST 응답과 SSE 브로드캐스트 중 어느 쪽이 먼저 와도 한 번만 그린다
        // (ChatPage 의 3203bbaf "Chat Echo back" 가드와 같은 이유).
        setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
        // 패널을 열어 둔 채로 받은 메시지는 읽은 것이다 — 안 그러면 미읽음 배지가
        // 눈앞에서 계속 쌓인다.
        if (!observer) api.markChatRoomRead(roomId).catch(() => {});
      },
      [roomId, observer],
    ),
  );

  // SSE 가 끊겼다 붙으면 그 사이 프레임을 놓쳤을 수 있으므로 전체를 다시 읽는다.
  useBoardStreamEvent(
    'server_meta',
    useCallback(() => {
      void load();
    }, [load]),
  );

  const handleSent = useCallback((msg: ChatRoomMessageItem) => {
    setMessages((prev) => (prev.some((m) => m.id === msg.id) ? prev : [...prev, msg]));
  }, []);

  /**
   * 관전 상태에서 대화에 참여한다(티켓 f6a0de0e).
   *
   * 관전으로 떨어지는 경우는 두 가지다 — 자동 등록이 없던 시절의 과거 미션이거나,
   * 미션을 만들지 않은 다른 운영자거나. 둘 다 서버의 같은 멱등 엔드포인트로 해결되므로
   * 화면은 어느 쪽인지 구분할 필요가 없다.
   *
   * 성공하면 `load()` 로 전체를 다시 읽는다. `observer` 만 내리면 로스터와 읽음 표시가
   * 관전 시절 값 그대로 남아, 멘션 pill 이 안 그려지거나 미읽음이 안 내려가는 상태로
   * 입력창만 열린다.
   */
  const join = useCallback(async () => {
    if (!workspaceId) return;
    setJoining(true);
    setJoinError(null);
    try {
      await api.joinOrchestrationMissionConversation(missionId, workspaceId);
      await load();
    } catch (e: any) {
      setJoinError(e?.message || '대화에 참여하지 못했습니다');
    } finally {
      setJoining(false);
    }
  }, [missionId, workspaceId, load]);

  /**
   * 왜 발화가 막혀 있는가 — 없으면 발화 가능(티켓 9cfd8161, 요구사항 C).
   *
   * 예전에는 화면이 이유를 하나만 알았다: 읽기가 403 이면 "참여자가 아님". 그래서
   * 권한이 없어 막히는 사용자에게도 "참여자가 아니어서 읽기만 할 수 있습니다"라고
   * 말했고, 참여 버튼을 눌러 참여에 성공한 뒤에도 발화가 계속 막혀 이유를 알 수 없었다.
   * 자유 참여가 켜진 방에서는 더 나빴다 — 읽기가 성공하므로 관전으로도 안 떨어지고,
   * 입력창이 열린 채 전송 순간에만 403 이 떴다.
   *
   * **판정 순서는 서버 게이트와 같아야 한다**(room-membership.service.ts의
   * `requireMissionRoomSpeaker`): 종료 → chat off → 권한 → 참여자. 순서가 어긋나면
   * 화면이 대는 이유와 서버가 실제로 막는 이유가 갈린다.
   */
  const speakBlock: { reason: string; testId: string; canJoin: boolean } | null = (() => {
    if (!live) {
      return {
        reason: '종료된 미션이라 새 지시를 보낼 수 없습니다. 기록은 그대로 보존됩니다.',
        testId: 'mission-conversation-closed-notice',
        canJoin: false,
      };
    }
    if (userChatMode === 'off') {
      return {
        reason:
          '이 미션은 대화 옵션이 꺼져 있어 읽기 전용입니다. 미션 화면 위쪽의 User chat 을 ' +
          'Open 또는 Participants only 로 바꾸면 다시 대화할 수 있습니다.',
        testId: 'mission-conversation-chat-off-notice',
        canJoin: false,
      };
    }
    // 서버가 매 발화마다 users 행에서 직접 확인하는 것과 같은 권한이다
    // (PERMISSIONS.MANAGE_ACTIONS = 'admin.actions').
    //
    // `user` 가 아직 없으면(프로필 로딩 중 등) **권한 문제라고 말하지 않는다**. 그때
    // `hasPermission` 은 "권한 없음"이 아니라 "모름"을 false 로 돌려주므로, 그것을 근거로
    // 배너를 띄우면 멀쩡한 사용자에게 없는 문제를 지어내게 된다. 실제 차단은 어차피 서버가
    // 하므로, 모를 때는 조용히 통과시키고 전송 시 서버 사유를 그대로 받는 편이 정확하다.
    if (user && !hasPermission(MANAGE_ACTIONS)) {
      return {
        reason:
          'orchestration 대화에 발화하려면 Manage Actions 권한이 필요합니다. 참여자 등록 여부와는 ' +
          '무관하며, 워크스페이스 관리자에게 권한을 요청해야 합니다. 읽기는 그대로 가능합니다.',
        testId: 'mission-conversation-permission-notice',
        canJoin: false,
      };
    }
    if (observer) {
      return {
        reason: '이 미션의 대화방 참여자가 아니어서 읽기만 할 수 있습니다.',
        testId: 'mission-conversation-observer-notice',
        canJoin: true,
      };
    }
    return null;
  })();

  if (!roomId) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: tokens.colors.textMuted }}>
        미션이 아직 시작되지 않아 orchestrator 대화방이 없습니다. 미션을 시작하면 여기에서 대화할 수 있습니다.
      </div>
    );
  }

  // 과거 페이지 + detail 첫 페이지를 합치고, DOM 노드 수를 일정하게 유지하도록
  // 창 크기로 자른다. 최신 쪽을 남기는 이유는 운영자가 보는 것이 "지금"이기 때문이고,
  // 잘려나간 과거는 위로 스크롤하면 커서로 다시 들어온다.
  const knownIds = new Set(events.map((e) => e.id));
  const allEvents = [...olderEvents.filter((e) => !knownIds.has(e.id)), ...events];
  // DOM 상한은 어느 쪽 끝에 붙어 있든 EVENT_WINDOW 로 동일하다. 다른 것은 **어느 쪽을
  // 버리는가**다: 최신을 보고 있으면 오래된 쪽을, 과거를 파고 있으면 최신 쪽을 버린다.
  // 늘 `slice(-N)` 이면 과거 페이지를 불러오는 즉시 그게 잘려 창이 뒤로 밀리지 않는다.
  const windowedEvents =
    allEvents.length <= EVENT_WINDOW
      ? allEvents
      : eventWindowEdge === 'history'
        ? allEvents.slice(0, EVENT_WINDOW)
        : allEvents.slice(-EVENT_WINDOW);
  const tracks = buildConversationTracks(messages, windowedEvents);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        data-testid="mission-conversation-scroll"
        style={{ flex: 1, overflowY: 'auto', minHeight: 0, padding: '4px 0' }}
      >
        {loadingOlder && (
          <div style={{ padding: 8, textAlign: 'center', fontSize: 11, color: tokens.colors.textMuted }}>
            이전 대화 불러오는 중...
          </div>
        )}
        {loading && messages.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: tokens.colors.textMuted }}>대화를 불러오는 중...</div>
        )}
        {error && (
          <div style={{ padding: 16, fontSize: 12, color: tokens.colors.danger }} data-testid="mission-conversation-error">
            {error}
          </div>
        )}
        {!loading && !error && tracks.length === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: tokens.colors.textMuted }}>
            아직 대화가 없습니다. orchestrator 에게 질문하거나 방향을 지시해 보세요.
          </div>
        )}
        {tracks.map((track, index) =>
          track.kind === 'messages' ? (
            <MessageList
              key={`m-${track.messages[0].id}`}
              messages={track.messages}
              participantCount={participantCount}
              participants={participants}
              currentUserId={viewerId}
            />
          ) : (
            <ExecutionEventRun key={`e-${track.at}-${index}`} events={track.events} />
          ),
        )}
      </div>

      {speakBlock ? (
        <div
          style={{
            padding: '8px 12px',
            borderTop: `1px solid ${tokens.colors.border}`,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
          data-testid={speakBlock.testId}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, color: tokens.colors.textMuted }}>{speakBlock.reason}</span>
            {/*
              참여 버튼은 **참여가 실제로 문제를 푸는 경우에만** 건다. 종료된 미션이나
              chat off, 권한 부족에서는 참여에 성공해도 발화가 그대로 막히므로, 아무 일도
              못 하는 버튼을 주는 대신 이유를 문장으로 말한다.
            */}
            {speakBlock.canJoin && (
              <button
                type="button"
                onClick={() => void join()}
                disabled={joining}
                data-testid="mission-conversation-join"
                style={{
                  padding: '4px 10px',
                  fontSize: 11,
                  borderRadius: 4,
                  border: `1px solid ${tokens.colors.border}`,
                  background: tokens.colors.surfaceHover,
                  color: tokens.colors.textPrimary,
                  cursor: joining ? 'default' : 'pointer',
                  opacity: joining ? 0.6 : 1,
                  flexShrink: 0,
                }}
              >
                {joining ? '참여하는 중...' : '대화에 참여'}
              </button>
            )}
          </div>
          {joinError && (
            <span
              style={{ fontSize: 11, color: tokens.colors.danger }}
              data-testid="mission-conversation-join-error"
            >
              {joinError}
            </span>
          )}
        </div>
      ) : (
        <div style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
          <ChatMessageInput roomId={roomId} onSent={handleSent} isMobile={false} />
        </div>
      )}
    </div>
  );
}

/**
 * 실행 이벤트 구간 — 대화 말풍선과 확실히 달라 보이도록 좌측 색 띠 + 고정폭 글꼴의
 * compact 행으로 그린다. 여기서 "구분해 렌더링"이 실제로 눈에 보이는 지점이다.
 */
function ExecutionEventRun({ events }: { events: OrchestrationTimelineEvent[] }) {
  return (
    <div
      data-testid="mission-execution-run"
      style={{
        margin: '6px 12px',
        borderLeft: `2px solid ${tokens.colors.border}`,
        paddingLeft: 10,
      }}
    >
      {events.map((event, i) => (
        <div
          key={event.id || `${event.created_at}-${i}`}
          data-testid="mission-execution-event"
          data-event-type={event.type}
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'baseline',
            fontSize: 11,
            lineHeight: 1.6,
            color: tokens.colors.textMuted,
          }}
        >
          <span style={{ color: eventColor(event.type), fontFamily: 'monospace', flexShrink: 0 }}>
            {event.type}
          </span>
          <span style={{ flex: 1, minWidth: 0 }}>{event.message}</span>
          <span style={{ flexShrink: 0, fontSize: 10 }}>{relativeTime(event.created_at)}</span>
        </div>
      ))}
    </div>
  );
}
