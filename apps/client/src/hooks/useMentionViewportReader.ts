import { useCallback, useEffect, useRef } from 'react';
import { api } from '../api';

/**
 * Clears @-mentions when the row that carries them is actually looked at.
 *
 * Why not "reading the thread clears its mentions": opening a ticket panel or
 * a chat room is not evidence the user saw a particular mention. A room opens
 * scrolled to the newest message, which says nothing about a mention 200
 * messages up, and a ticket panel opened and closed in two seconds would
 * silently swallow the mention that was the reason to open it. A mention is
 * how work gets routed to a human, so the bar for dropping one is "it was on
 * screen", not "you were nearby".
 *
 * Mechanics:
 *   - `GET /mentions/unread-by-source` returns the pending mentions in this
 *     one ticket / room, keyed by the comment / message they live in.
 *   - An IntersectionObserver rooted at the scroll container watches the rows
 *     carrying those ids. Both surfaces already stamp a stable anchor
 *     attribute on every row (`data-comment-id`, `data-message-id`), so this
 *     works with the virtualized comment list without composing refs — rows
 *     are re-observed whenever the rendered set changes.
 *   - A row must stay visible for `dwellMs` before it counts. Flinging past a
 *     mention while scrolling to the bottom is not reading it.
 *   - The tab must be visible. A row "on screen" in a hidden tab was not read.
 *
 * Reads are flushed as one batch request, and the badge is decremented by the
 * number the server actually cleared.
 */

export interface MentionViewportReaderOptions {
  /** Scroll container. Becomes the IntersectionObserver root. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** Exactly one of these — the source whose mentions we're clearing. */
  source: { ticketId?: string; roomId?: string };
  /** Row anchor attribute holding the comment / message id. */
  anchorAttribute: 'data-comment-id' | 'data-message-id';
  /**
   * Changes whenever the rendered row set changes (message/comment count,
   * virtual window, …). Used to re-run observation over the current DOM.
   */
  renderSignal: unknown;
  /** How long a row must remain visible to count as read. */
  dwellMs?: number;
  /** Fraction of the row that must be visible. */
  threshold?: number;
  /** Debounce before POSTing, so one screenful costs one request. */
  flushDelayMs?: number;
  /**
   * Called with the number of mentions the server actually cleared. Passed in
   * rather than pulled from NotificationContext so this hook stays a plain
   * unit — the observer/dwell rules are the part worth testing, and requiring
   * the full provider stack to exercise them would have meant not testing
   * them.
   */
  onCleared: (count: number) => void;
}

export function useMentionViewportReader({
  containerRef,
  source,
  anchorAttribute,
  renderSignal,
  dwellMs = 900,
  threshold = 0.5,
  flushDelayMs = 300,
  onCleared,
}: MentionViewportReaderOptions) {
  // Kept in a ref so a caller passing an inline arrow doesn't tear down the
  // observer (and every in-flight dwell timer) on each render.
  const onClearedRef = useRef(onCleared);
  onClearedRef.current = onCleared;
  const flushDelayRef = useRef(flushDelayMs);
  flushDelayRef.current = flushDelayMs;

  // sourceId → mentionId for everything still unread in this ticket / room.
  const pendingRef = useRef<Map<string, string>>(new Map());
  // Dwell timers keyed by sourceId, cancelled when the row leaves early.
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // Ids seen but not yet POSTed, plus the debounce that flushes them.
  const queuedRef = useRef<Set<string>>(new Set());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sourceKey = source.ticketId ? `t:${source.ticketId}` : source.roomId ? `r:${source.roomId}` : '';

  const flush = useCallback(async () => {
    flushTimerRef.current = null;
    const ids = Array.from(queuedRef.current);
    queuedRef.current.clear();
    if (ids.length === 0) return;
    try {
      const { updated } = await api.markMentionsRead(ids);
      // Decrement by what the server actually changed, not by what we sent —
      // another tab may have cleared some of these already, and double
      // counting would drive the badge below the true value.
      onClearedRef.current(updated);
    } catch {
      // Re-queue so a transient failure doesn't lose the read. The rows are
      // still on screen, so the next dwell will try again.
      for (const id of ids) queuedRef.current.add(id);
    }
  }, []);

  const queueRead = useCallback((sourceId: string) => {
    const mentionId = pendingRef.current.get(sourceId);
    if (!mentionId) return;
    // Drop it locally first so the same row can't be queued twice while the
    // request is in flight.
    pendingRef.current.delete(sourceId);
    queuedRef.current.add(mentionId);
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => void flush(), flushDelayRef.current);
  }, [flush]);

  // ── Load the pending set for this source ──────────────────────────────
  useEffect(() => {
    pendingRef.current = new Map();
    if (!sourceKey) return;
    let cancelled = false;
    api.getUnreadMentionsBySource(source)
      .then(({ items }) => {
        if (cancelled) return;
        const map = new Map<string, string>();
        for (const it of items) map.set(it.source_id, it.id);
        pendingRef.current = map;
      })
      .catch(() => { /* nothing pending we can act on */ });
    return () => {
      cancelled = true;
      for (const t of timersRef.current.values()) clearTimeout(t);
      timersRef.current.clear();
    };
    // `source` is rebuilt each render; sourceKey is its stable identity.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  // ── Observe the rows currently in the DOM ─────────────────────────────
  useEffect(() => {
    if (!sourceKey) return;
    const root = containerRef.current;
    if (!root || typeof IntersectionObserver === 'undefined') return;

    const timers = timersRef.current;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const el = entry.target as HTMLElement;
          const sourceId = el.getAttribute(anchorAttribute);
          if (!sourceId) continue;
          const visible = entry.isIntersecting && entry.intersectionRatio >= threshold;
          const existing = timers.get(sourceId);
          if (!visible) {
            // Left the viewport before the dwell elapsed — not read.
            if (existing) {
              clearTimeout(existing);
              timers.delete(sourceId);
            }
            continue;
          }
          if (existing) continue;
          if (!pendingRef.current.has(sourceId)) continue;
          timers.set(sourceId, setTimeout(() => {
            timers.delete(sourceId);
            // A tab that went hidden mid-dwell was not being read.
            if (typeof document !== 'undefined' && document.hidden) return;
            queueRead(sourceId);
          }, dwellMs));
        }
      },
      { root, threshold: [threshold] },
    );

    root.querySelectorAll(`[${anchorAttribute}]`).forEach((el) => observer.observe(el));
    return () => {
      observer.disconnect();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    };
  }, [sourceKey, containerRef, anchorAttribute, renderSignal, dwellMs, threshold, queueRead]);

  // Flush anything still queued when the surface goes away, so a read taken
  // right before closing the panel isn't lost.
  useEffect(() => () => {
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    void flush();
  }, [flush]);
}
