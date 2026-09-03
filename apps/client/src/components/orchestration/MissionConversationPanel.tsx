import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import type { ChatRoomMessageItem, OrchestrationTimelineEvent } from '../../types';
import { useBoardStreamEvent } from '../../contexts/BoardStreamContext';
import { useAuth } from '../../contexts/AuthContext';
import MessageList from '../chat/MessageList';
import ChatMessageInput from '../chat/ChatMessageInput';
import { projectParticipants, countUserParticipants } from '../chat/utils/participantFlow';
import type { MentionParticipant } from '../chat/utils/markdown';
import { eventColor } from './status';
import { relativeTime } from '../../utils/time';

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
 * 실행 이벤트는 한 화면에 수천 건이 쌓일 수 있어 전부 그리면 긴 미션에서 패널이
 * 멈춘다. 최신 것부터 이 개수까지만 렌더링하고 나머지는 접는다 — Timeline 섹션이
 * 전체 이력을 따로 갖고 있으므로 여기서 잘라도 정보가 사라지지 않는다.
 */
const MAX_RENDERED_EVENTS = 200;

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
  for (const e of events.slice(-MAX_RENDERED_EVENTS)) items.push({ at: new Date(e.created_at).getTime(), event: e });
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
  /** orchestrator 대화가 오가는 ChatRoom. null 이면 미션이 아직 시작되지 않은 것이다. */
  roomId: string | null;
  /** 실행 trace — 대화와 시간순으로 엮어 보여준다. */
  events: OrchestrationTimelineEvent[];
  /** 종료된 미션에서는 입력을 막는다(보낼 orchestrator 세션이 없다). */
  live: boolean;
  currentUserId?: string;
}

export default function MissionConversationPanel({
  missionId,
  roomId,
  events,
  live,
  currentUserId,
}: MissionConversationPanelProps) {
  const { user } = useAuth();
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
  /**
   * 참여자 로스터 — 없으면 `MessageList` 가 `@[user:uuid|이름]` 을 pill 로 못 그리고
   * 읽음 수("Read by N")도 표시하지 못한다. 즉 "기존 Chat 의 멘션·읽음 UX 재사용"이
   * 로스터 없이는 성립하지 않는다.
   */
  const [participants, setParticipants] = useState<MentionParticipant[]>([]);
  const [participantCount, setParticipantCount] = useState(0);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const loadingOlderRef = useRef(false);
  /** 과거 로드 직전의 스크롤 높이 — 로드 후 위치를 보정해 화면이 튀지 않게 한다. */
  const pendingAnchorRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    if (!roomId) return;
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
        setParticipants(roster);
        setParticipantCount(countUserParticipants(roster));
      } catch {
        setParticipants([]);
        setParticipantCount(0);
      }

      // 관전자는 남의 방 읽음 표시를 건드리면 안 된다(ChatPage 와 같은 규칙).
      if (!asObserver) api.markChatRoomRead(roomId).catch(() => {});
    } catch (e: any) {
      setError(e?.message || '대화를 불러오지 못했습니다');
      setMessages([]);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = useCallback(async () => {
    if (!roomId || loadingOlderRef.current || !hasMore || messages.length === 0) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    pendingAnchorRef.current = scrollRef.current?.scrollHeight ?? null;
    try {
      const older = await api.getChatRoomMessages(roomId, PAGE_SIZE, messages[0].id, observer);
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

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollTop < LOAD_OLDER_THRESHOLD) void loadOlder();
  }, [loadOlder]);

  // 새 메시지 자동 추종 — 사용자가 위쪽 이력을 읽는 중이면 끌어내리지 않는다.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance <= NEAR_BOTTOM_THRESHOLD + 200) el.scrollTop = el.scrollHeight;
  }, [messages.length, events.length]);

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

  if (!roomId) {
    return (
      <div style={{ padding: 16, fontSize: 12, color: tokens.colors.textMuted }}>
        미션이 아직 시작되지 않아 orchestrator 대화방이 없습니다. 미션을 시작하면 여기에서 대화할 수 있습니다.
      </div>
    );
  }

  const tracks = buildConversationTracks(messages, events);

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

      {observer ? (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            color: tokens.colors.textMuted,
            borderTop: `1px solid ${tokens.colors.border}`,
          }}
          data-testid="mission-conversation-observer-notice"
        >
          이 미션의 대화방 참여자가 아니어서 읽기만 할 수 있습니다.
        </div>
      ) : live ? (
        <div style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
          <ChatMessageInput roomId={roomId} onSent={handleSent} isMobile={false} />
        </div>
      ) : (
        <div
          style={{
            padding: '8px 12px',
            fontSize: 11,
            color: tokens.colors.textMuted,
            borderTop: `1px solid ${tokens.colors.border}`,
          }}
          data-testid="mission-conversation-closed-notice"
        >
          종료된 미션이라 새 지시를 보낼 수 없습니다. 기록은 그대로 보존됩니다.
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
