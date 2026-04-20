import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useState,
} from 'react';

/**
 * BoardStreamContext — AppLayout-level single EventSource lifecycle.
 *
 * Phase 1 D-10 architectural intent: SSE-subscribing components must stay
 * mounted across route changes so that navigating Board → Stub → Board does
 * NOT close and reopen the `/api/events/stream` connection.
 *
 * Because React Router's <Outlet /> unmounts the active route element on
 * navigation, we cannot own the EventSource inside a sibling route component
 * (Board). The only correct place is the persistent shell — AppLayout — or a
 * Provider mounted above <Outlet />. This file owns that single authoritative
 * subscription. Any component that needs SSE events calls
 * useBoardStream() / useBoardStreamEvent() and receives them via an
 * internal subscriber map — no new EventSource is ever created downstream.
 *
 * Design notes:
 * - Opens ONE stream without a ?boardId= filter (app-level subscription), so
 *   workspace/board switches do NOT require reconnecting the EventSource.
 *   Consumers filter by `data.board_id` client-side.
 * - Uses EventTarget as an internal pub/sub to broadcast received events to
 *   all hook subscribers without re-rendering the provider itself.
 * - Auto-reconnect with 5s backoff mirrors the previous useBoard() behavior.
 */

type StreamNamedEventType =
  | 'board_update' | 'agent_typing' | 'agent_trigger'
  | 'chat_message' | 'agent_status'
  | 'chat_room_message' | 'chat_room_update' | 'chat_room_typing'  // Phase 7
  | 'server_meta'   // Phase 8 — protocol version handshake (CHAT-20)
  | 'user_mention'  // Mention feature — sidebar unread badge sync
  | 'comment_typing'   // Phase-9 typed comments — "user is composing" indicator
  | 'ticket_presence'; // Tier-1 E — viewer set for a ticket (panel-open indicator)

interface BoardStreamContextValue {
  /** Subscribe to a named SSE event (board_update/agent_typing/agent_trigger). */
  subscribe: (
    eventType: StreamNamedEventType,
    handler: (data: any) => void,
  ) => () => void;
  /** Current connection status — useful for diagnostics / UI hints. */
  isConnected: boolean;
}

const BoardStreamContext = createContext<BoardStreamContextValue | null>(null);

export function useBoardStream(): BoardStreamContextValue {
  const ctx = useContext(BoardStreamContext);
  if (!ctx) {
    throw new Error('useBoardStream must be used within <BoardStreamProvider>');
  }
  return ctx;
}

/**
 * Convenience hook: subscribe to a single named SSE event and auto-unsubscribe
 * on unmount. The handler is stored in a ref so callers can pass inline
 * closures without reconnecting.
 */
export function useBoardStreamEvent(
  eventType: StreamNamedEventType,
  handler: (data: any) => void,
) {
  const { subscribe } = useBoardStream();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    const unsubscribe = subscribe(eventType, (data) => {
      handlerRef.current(data);
    });
    return unsubscribe;
  }, [eventType, subscribe]);
}

interface ProviderProps {
  children: React.ReactNode;
}

export function BoardStreamProvider({ children }: ProviderProps) {
  const [isConnected, setIsConnected] = useState(false);

  // Internal pub/sub bus — using EventTarget avoids re-rendering the provider
  // whenever an event arrives (subscribers manage their own state).
  const busRef = useRef<EventTarget>(new EventTarget());

  const subscribe = useCallback(
    (eventType: StreamNamedEventType, handler: (data: any) => void) => {
      const bus = busRef.current;
      const listener = (evt: Event) => {
        const ce = evt as CustomEvent;
        handler(ce.detail);
      };
      bus.addEventListener(eventType, listener as EventListener);
      return () => {
        bus.removeEventListener(eventType, listener as EventListener);
      };
    },
    [],
  );

  // ─── The single authoritative EventSource ────────────────────────────
  useEffect(() => {
    const token = localStorage.getItem('auth_token');
    if (!token) return;

    const baseUrl =
      window.location.hostname === 'localhost'
        ? `${window.location.protocol}//${window.location.hostname}:7701`
        : '';
    // NOTE: no boardId query param — this is a workspace-agnostic subscription.
    // Consumers filter board_update events by data.board_id client-side.
    const url = `${baseUrl}/api/events/stream?token=${encodeURIComponent(token)}`;

    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const dispatch = (type: StreamNamedEventType, rawData: string) => {
      let parsed: any = null;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return;
      }
      busRef.current.dispatchEvent(
        new CustomEvent(type, { detail: parsed }),
      );
    };

    const connect = () => {
      if (closed) return;

      eventSource = new EventSource(url);

      eventSource.onopen = () => {
        setIsConnected(true);
      };

      eventSource.addEventListener('board_update', (event: MessageEvent) => {
        dispatch('board_update', event.data);
      });

      eventSource.addEventListener('agent_typing', (event: MessageEvent) => {
        dispatch('agent_typing', event.data);
      });

      eventSource.addEventListener('agent_trigger', (event: MessageEvent) => {
        dispatch('agent_trigger', event.data);
      });

      eventSource.addEventListener('chat_message', (event: MessageEvent) => {
        dispatch('chat_message', event.data);
      });

      eventSource.addEventListener('agent_status', (event: MessageEvent) => {
        dispatch('agent_status', event.data);
      });

      eventSource.addEventListener('chat_room_message', (event: MessageEvent) => {
        dispatch('chat_room_message', event.data);
      });

      eventSource.addEventListener('chat_room_update', (event: MessageEvent) => {
        dispatch('chat_room_update', event.data);
      });

      eventSource.addEventListener('chat_room_typing', (event: MessageEvent) => {
        dispatch('chat_room_typing', event.data);
      });

      // Phase 8 CHAT-20: protocol version handshake — dispatch to subscribers
      eventSource.addEventListener('server_meta', (event: MessageEvent) => {
        dispatch('server_meta', event.data);
      });

      eventSource.addEventListener('user_mention', (event: MessageEvent) => {
        dispatch('user_mention', event.data);
      });

      eventSource.addEventListener('comment_typing', (event: MessageEvent) => {
        dispatch('comment_typing', event.data);
      });

      eventSource.addEventListener('ticket_presence', (event: MessageEvent) => {
        dispatch('ticket_presence', event.data);
      });

      eventSource.onerror = () => {
        setIsConnected(false);
        // EventSource auto-reconnects, but if it keeps failing, back off.
        if (eventSource?.readyState === EventSource.CLOSED && !closed) {
          eventSource.close();
          reconnectTimer = setTimeout(connect, 5000);
        }
      };
    };

    connect();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (eventSource) {
        eventSource.close();
      }
      setIsConnected(false);
    };
  }, []);

  return (
    <BoardStreamContext.Provider value={{ subscribe, isConnected }}>
      {children}
    </BoardStreamContext.Provider>
  );
}
