// Pure / dependency-injected helpers for ChatMessageInput's send flow.
//
// The send orchestration and its two race / accessibility decisions live here
// (rather than inline in the component) so they can be exercised without a DOM
// or a React render — the component only injects setters/refs. See
// apps/client/test/composer-send.test.mjs. Both `import type`s below are erased
// at runtime, so this module loads under tsx with no React/DOM dependency.
import type { ChatRoomMessageItem } from '../../../types';

export interface FocusRestoreContext {
  /** document.activeElement at the instant the send settled (may be null). */
  active: Element | null;
  /** The composer root element (rootRef.current). */
  composerRoot: Element | null;
  /** document.body — injected so this stays testable without a DOM global. */
  body: Element | null;
}

/**
 * Decide whether the composer should reclaim focus after an async send settles.
 *
 * Restore ONLY when focus is not deliberately parked on another control:
 *  - nothing is focused (active == null) → restore
 *  - focus fell back to <body> — e.g. the Send button disabled itself mid-send
 *    and the browser blurred it → restore. This is the mouse-click Send path
 *    that requirements 2 & 3 need ("click Send, keep typing without a click").
 *  - focus is still somewhere inside the composer → restore
 *
 * Otherwise the user Tab'd / clicked to a control OUTSIDE the composer while the
 * send was in flight; leave their focus where they put it so we don't fight
 * keyboard navigation / accessibility (requirement 4).
 */
export function shouldRestoreComposerFocus(ctx: FocusRestoreContext): boolean {
  const { active, composerRoot, body } = ctx;
  if (!active) return true;
  if (body && active === body) return true;
  if (composerRoot && composerRoot.contains(active)) return true;
  return false;
}

/**
 * Split the attachment strip at the moment a send SUCCEEDS into the entries the
 * send owns (safe to drop, preview URL revoked) and the entries that survive.
 *
 * `sentLocalIds` is the snapshot of localIds captured when the send STARTED.
 * Anything added afterwards — a file pasted or dropped during a slow send — is
 * not in that set, so it is kept. This closes the race where the success
 * callback wiped a freshly-added attachment, revoking its live preview URL and
 * orphaning the already-uploaded server row.
 */
export function partitionSettledAttachments<T extends { localId: string; previewUrl?: string }>(
  strip: T[],
  sentLocalIds: ReadonlySet<string>,
): { remaining: T[]; revokeUrls: string[] } {
  const remaining: T[] = [];
  const revokeUrls: string[] = [];
  for (const entry of strip) {
    if (sentLocalIds.has(entry.localId)) {
      if (entry.previewUrl) revokeUrls.push(entry.previewUrl);
    } else {
      remaining.push(entry);
    }
  }
  return { remaining, revokeUrls };
}

export interface CompleteSendDeps<A extends { localId: string; previewUrl?: string }> {
  /** Trimmed message text being sent. */
  content: string;
  /** Resolved server attachment ids to include (already filtered to 'done'). */
  attachmentIds: string[];
  /** Snapshot of the strip's localIds at send-start (ownership set). */
  sentLocalIds: ReadonlySet<string>;
  /** Fire the actual send; `attachmentIds` is undefined when there are none. */
  send: (content: string, attachmentIds: string[] | undefined) => Promise<ChatRoomMessageItem>;
  onSent: (msg: ChatRoomMessageItem) => void;
  setPendingAttachments: (updater: (prev: A[]) => A[]) => void;
  revokeObjectURL: (url: string) => void;
  setSendError: (msg: string | null) => void;
  setText: (updater: (cur: string) => string) => void;
  setSending: (value: boolean) => void;
  /** Read the live focus context at settle time (component wires document/ref). */
  readFocus: () => FocusRestoreContext;
  /** Move focus back to the composer textarea. */
  restoreFocus: () => void;
}

/**
 * Drive an in-flight send to completion: on success release only the attachments
 * this send owned (see partitionSettledAttachments) and notify the parent; on
 * failure surface the error and restore the draft only if the composer is still
 * empty; either way stop the spinner and reclaim focus only when it wasn't
 * deliberately moved elsewhere (see shouldRestoreComposerFocus).
 *
 * The caller performs the synchronous pre-send work (guards, snapshot, clearing
 * the draft, setSending(true)) before awaiting this.
 */
export async function completeComposerSend<A extends { localId: string; previewUrl?: string }>(
  deps: CompleteSendDeps<A>,
): Promise<void> {
  const {
    content,
    attachmentIds,
    sentLocalIds,
    send,
    onSent,
    setPendingAttachments,
    revokeObjectURL,
    setSendError,
    setText,
    setSending,
    readFocus,
    restoreFocus,
  } = deps;
  try {
    const msg = await send(content, attachmentIds.length > 0 ? attachmentIds : undefined);
    // Only release the strip after the server has bound the attachments to a
    // message id — and only the ones this send owned, so a file pasted/dropped
    // mid-send is preserved for the next message rather than silently wiped.
    setPendingAttachments((prev) => {
      const { remaining, revokeUrls } = partitionSettledAttachments(prev, sentLocalIds);
      revokeUrls.forEach(revokeObjectURL);
      return remaining;
    });
    onSent(msg);
  } catch (err: any) {
    setSendError(err?.message || 'Message not sent. Check your connection.');
    // Restore the failed draft — but only if the composer is still empty. With
    // the textarea kept editable during send, a fast typist may have already
    // started the next message; don't clobber it. Attachments are preserved.
    setText((cur) => (cur.length === 0 ? content : cur));
  } finally {
    setSending(false);
    if (shouldRestoreComposerFocus(readFocus())) restoreFocus();
  }
}
