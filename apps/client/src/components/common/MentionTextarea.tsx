import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { tokens } from '../../tokens';

export interface MentionCandidate {
  type: 'user' | 'agent' | 'role';
  id: string;       // uuid for user/agent, role keyword ('assignee' etc) for role
  name: string;     // display name
  sublabel?: string; // secondary line (e.g. "Assignee (Alice)")
}

// Parse any raw `@[type:id|name]` tokens out of the stored value into an
// ordered log of the mentions that appear in the text, and return the
// display-form string (the raw tokens replaced by a human-readable `@name`).
// Order matters for the reverse mapping — each mention is found by its
// first unconsumed `@name` occurrence after the previous one in the string.
const RAW_TOKEN_RE = /@\[(user|agent|role):([\w-]+)(?:\|([^\]]*))?\]/g;
function parseRawToDisplay(raw: string): { display: string; log: MentionCandidate[] } {
  const log: MentionCandidate[] = [];
  if (!raw) return { display: '', log };
  const display = raw.replace(RAW_TOKEN_RE, (_match, type, id, name) => {
    const displayName = name || id;
    log.push({ type: type as MentionCandidate['type'], id, name: displayName });
    return `@${displayName}`;
  });
  return { display, log };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Given the current textarea text (display form) and the ordered log of
// mentions we believe are in it, rebuild the raw value by replacing the
// first `@name` occurrence (word-boundary-terminated) for each log entry
// with its full `@[type:id|name]` token. Log entries whose name no longer
// appears are skipped — corresponds to the user having deleted that
// mention.
function displayToRaw(display: string, log: MentionCandidate[]): string {
  if (log.length === 0) return display;
  let out = '';
  let cursor = 0;
  for (const entry of log) {
    const re = new RegExp('@' + escapeRegex(entry.name) + '(?![\\w-])');
    const slice = display.slice(cursor);
    const m = re.exec(slice);
    if (!m) continue; // mention deleted by user
    const absIdx = cursor + m.index;
    out += display.slice(cursor, absIdx);
    out += `@[${entry.type}:${entry.id}|${entry.name}]`;
    cursor = absIdx + m[0].length;
  }
  out += display.slice(cursor);
  return out;
}

interface MentionTextareaProps {
  value: string;
  onChange: (text: string) => void;
  candidates: MentionCandidate[];
  onSubmit?: () => void;           // called on Enter when no dropdown is open
  submitOnEnter?: boolean;         // default true — Enter submits (shift+Enter newline)
  placeholder?: string;
  rows?: number;
  disabled?: boolean;
  ariaLabel?: string;
  style?: React.CSSProperties;
}

/**
 * Imperative handle a parent can hold via ref to focus the underlying textarea.
 * Used by the chat composer to keep the input focused across room switches and
 * after a send without reaching into the DOM. `preventScroll` (default true)
 * avoids the focus-into-view scroll jump when focusing programmatically.
 */
export interface MentionTextareaHandle {
  focus: (opts?: { preventScroll?: boolean }) => void;
}

/**
 * Textarea (or single-line input) with an @-mention autocomplete dropdown.
 *
 * When the user types `@` the dropdown opens anchored to the bottom-left of
 * the input; arrow keys + Enter pick, Esc closes. Selecting a candidate
 * replaces the in-progress `@query` with the structured token
 * `@[type:id|name] ` which is what the backend parses for dispatch.
 */
export const MentionTextarea = forwardRef<MentionTextareaHandle, MentionTextareaProps>(function MentionTextarea({
  value,
  onChange,
  candidates,
  onSubmit,
  submitOnEnter = true,
  placeholder,
  rows = 3,
  disabled = false,
  ariaLabel,
  style,
}: MentionTextareaProps, ref) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Expose focus() to the parent (see MentionTextareaHandle). preventScroll
  // defaults to true so focusing the composer never yanks the message list.
  useImperativeHandle(ref, () => ({
    focus: (opts?: { preventScroll?: boolean }) =>
      inputRef.current?.focus({ preventScroll: opts?.preventScroll ?? true }),
  }), []);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [triggerIdx, setTriggerIdx] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);
  // Dropdown gets portaled to <body> and pinned via position: fixed so ancestor
  // overflow containers (ticket detail comment scroll area, right panel) can't
  // clip it. Coordinates are recomputed on open, scroll, and resize.
  const [anchorRect, setAnchorRect] = useState<{ top: number; left: number; width: number } | null>(null);

  // Parse the raw `value` coming in from the parent into (a) the display
  // string the textarea actually shows, and (b) the ordered mention log
  // we'll use to reverse-map edits back to raw. The log is refreshed on
  // every value change so it stays authoritative against whatever the
  // parent most recently stored. We keep a ref copy because event handlers
  // fired between renders need the latest log synchronously.
  const { display: displayValue, log: derivedLog } = useMemo(
    () => parseRawToDisplay(value || ''),
    [value],
  );
  const mentionLogRef = useRef<MentionCandidate[]>(derivedLog);
  mentionLogRef.current = derivedLog;

  const filtered = useMemo(() => {
    if (!open) return [];
    const q = query.toLowerCase();
    return candidates
      .filter(c => !q || c.name.toLowerCase().includes(q) || (c.sublabel || '').toLowerCase().includes(q))
      .slice(0, 8);
  }, [candidates, query, open]);

  // Keep activeIdx in bounds whenever filtered changes.
  useEffect(() => {
    if (activeIdx >= filtered.length) setActiveIdx(0);
  }, [filtered, activeIdx]);

  // Recompute the anchor rect whenever the dropdown is open so the portal
  // tracks the input across scroll and resize. useLayoutEffect avoids a flicker
  // on open because the portal renders with a valid rect in the first paint.
  useLayoutEffect(() => {
    if (!open) {
      setAnchorRect(null);
      return;
    }
    const syncAnchorRect = () => {
      const el = inputRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchorRect({ top: r.top, left: r.left, width: r.width });
    };
    syncAnchorRect();
    window.addEventListener('scroll', syncAnchorRect, true); // capture scroll from ancestors too
    window.addEventListener('resize', syncAnchorRect);
    return () => {
      window.removeEventListener('scroll', syncAnchorRect, true);
      window.removeEventListener('resize', syncAnchorRect);
    };
  }, [open]);

  const updateTriggerFromCaret = useCallback((text: string, caret: number) => {
    // Walk back from caret to either `@` (open dropdown) or whitespace/start (close).
    let i = caret - 1;
    let q = '';
    while (i >= 0) {
      const ch = text[i];
      if (ch === '@') {
        // Require preceding whitespace or start-of-string for a fresh mention.
        if (i === 0 || /\s/.test(text[i - 1])) {
          setTriggerIdx(i);
          setQuery(q);
          setOpen(true);
          setActiveIdx(0);
          return;
        }
        break;
      }
      if (/\s/.test(ch)) break;
      q = ch + q;
      i--;
    }
    setOpen(false);
    setTriggerIdx(null);
    setQuery('');
  }, []);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    // textarea holds display form (`@name`); convert back to raw tokens using
    // the log so the parent keeps dispatchable `@[type:id|name]` in its state.
    const nextDisplay = e.target.value;
    const rawValue = displayToRaw(nextDisplay, mentionLogRef.current);
    onChange(rawValue);
    const caret = e.target.selectionStart ?? nextDisplay.length;
    updateTriggerFromCaret(nextDisplay, caret);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (open && filtered.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => (i + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertSelection(filtered[activeIdx]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
    }

    // Normal submit on Enter (not during dropdown).
    if (submitOnEnter && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit?.();
    }
  };

  const insertSelection = useCallback((c: MentionCandidate) => {
    if (triggerIdx == null) return;
    const el = inputRef.current;
    const caret = el?.selectionStart ?? displayValue.length;
    // Operate in display coordinates so triggerIdx/caret line up with what
    // the user actually sees in the textarea.
    const before = displayValue.slice(0, triggerIdx);
    const after = displayValue.slice(caret);
    const displayInsert = `@${c.name} `;
    const nextDisplay = before + displayInsert + after;

    // Figure out where in the existing log the new mention lands, so
    // displayToRaw can find it at the right position. Scan existing log
    // entries against the CURRENT display, stopping at the first one whose
    // `@name` occurrence is at or past triggerIdx.
    const oldLog = mentionLogRef.current;
    let insertLogIdx = oldLog.length;
    let scanCursor = 0;
    for (let i = 0; i < oldLog.length; i++) {
      const re = new RegExp('@' + escapeRegex(oldLog[i].name) + '(?![\\w-])');
      const slice = displayValue.slice(scanCursor);
      const m = re.exec(slice);
      if (!m) continue;
      const abs = scanCursor + m.index;
      if (abs >= triggerIdx) { insertLogIdx = i; break; }
      scanCursor = abs + m[0].length;
    }
    const newLog = [...oldLog.slice(0, insertLogIdx), c, ...oldLog.slice(insertLogIdx)];
    const rawValue = displayToRaw(nextDisplay, newLog);
    onChange(rawValue);

    setOpen(false);
    setTriggerIdx(null);
    setQuery('');
    // Restore caret to end of inserted display text (not raw length).
    requestAnimationFrame(() => {
      const newCaret = (before + displayInsert).length;
      el?.focus();
      el?.setSelectionRange(newCaret, newCaret);
    });
  }, [triggerIdx, displayValue, onChange]);

  const handleClickCandidate = (c: MentionCandidate) => {
    insertSelection(c);
  };


  // Keep the portal alive while open so the user always gets feedback that
  // `@` was detected — even if the candidate list is still loading or empty.
  // The "no matches" row below replaces the old silent-drop behavior that
  // made the feature look broken in the ticket comment flow.
  const shouldRenderDropdown = open && anchorRect;
  // Height budget for the dropdown, then decide above/below based on viewport.
  const DROPDOWN_MAX_HEIGHT = 240;
  const spaceAbove = anchorRect ? anchorRect.top - 8 : 0;
  const openAbove = anchorRect ? spaceAbove >= DROPDOWN_MAX_HEIGHT || spaceAbove > (window.innerHeight - anchorRect.top - 40) : true;
  const dropdownTop = anchorRect
    ? (openAbove
        ? Math.max(8, anchorRect.top - DROPDOWN_MAX_HEIGHT - 4)
        : anchorRect.top + /* input height approx */ 32 + 4)
    : 0;

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <textarea
        ref={inputRef}
        rows={rows}
        value={displayValue}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        aria-label={ariaLabel}
        placeholder={placeholder}
        disabled={disabled}
        style={style}
      />

      {shouldRenderDropdown && createPortal(
        <div
          role="listbox"
          aria-label="Mention suggestions"
          style={{
            position: 'fixed',
            top: dropdownTop,
            left: anchorRect!.left,
            zIndex: 9999,
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            boxShadow: tokens.shadows.panel,
            minWidth: Math.max(240, anchorRect!.width),
            maxHeight: DROPDOWN_MAX_HEIGHT,
            overflowY: 'auto',
            padding: 4,
          }}
        >
          {filtered.length === 0 && (
            <div style={{ padding: '8px 10px', fontSize: 12, color: tokens.colors.textMuted }}>
              {candidates.length === 0 ? 'Loading candidates…' : 'No matches'}
            </div>
          )}
          {filtered.map((c, i) => {
            const isActive = i === activeIdx;
            return (
              <div
                key={`${c.type}:${c.id}`}
                role="option"
                aria-selected={isActive}
                onMouseDown={(e) => { e.preventDefault(); handleClickCandidate(c); }}
                onMouseEnter={() => setActiveIdx(i)}
                style={{
                  padding: '6px 10px',
                  borderRadius: tokens.radii.sm,
                  cursor: 'pointer',
                  background: isActive ? tokens.colors.surface : 'transparent',
                  color: tokens.colors.textStrong,
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                  fontSize: 13,
                }}
              >
                <span style={{
                  fontSize: 10,
                  textTransform: 'uppercase',
                  color: tokens.colors.textMuted,
                  letterSpacing: 0.5,
                  minWidth: 36,
                }}>
                  {c.type}
                </span>
                <span style={{ fontWeight: 500 }}>{c.name}</span>
                {c.sublabel && (
                  <span style={{ color: tokens.colors.textSecondary, fontSize: 11 }}>{c.sublabel}</span>
                )}
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </div>
  );
});
