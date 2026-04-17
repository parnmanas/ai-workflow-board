import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { tokens } from '../../tokens';

export interface MentionCandidate {
  type: 'user' | 'agent' | 'role';
  id: string;       // uuid for user/agent, role keyword ('assignee' etc) for role
  name: string;     // display name
  sublabel?: string; // secondary line (e.g. "Assignee (Alice)")
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
  /** Render as a single-line <input> instead of multi-line <textarea>. */
  asInput?: boolean;
}

const TOKEN_INSERT = (c: MentionCandidate) => `@[${c.type}:${c.id}|${c.name}] `;

/**
 * Textarea (or single-line input) with an @-mention autocomplete dropdown.
 *
 * When the user types `@` the dropdown opens anchored to the bottom-left of
 * the input; arrow keys + Enter pick, Esc closes. Selecting a candidate
 * replaces the in-progress `@query` with the structured token
 * `@[type:id|name] ` which is what the backend parses for dispatch.
 */
export function MentionTextarea({
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
  asInput = false,
}: MentionTextareaProps) {
  const inputRef = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [triggerIdx, setTriggerIdx] = useState<number | null>(null);
  const [activeIdx, setActiveIdx] = useState(0);

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

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement | HTMLInputElement>) => {
    const next = e.target.value;
    onChange(next);
    const caret = e.target.selectionStart ?? next.length;
    updateTriggerFromCaret(next, caret);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
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
    const caret = el?.selectionStart ?? value.length;
    const before = value.slice(0, triggerIdx);
    const after = value.slice(caret);
    const token = TOKEN_INSERT(c);
    const next = before + token + after;
    onChange(next);
    setOpen(false);
    setTriggerIdx(null);
    setQuery('');
    // Restore caret to the end of the inserted token. Needs a frame so the
    // textarea applies the new value before we set selection.
    requestAnimationFrame(() => {
      const newCaret = (before + token).length;
      el?.focus();
      el?.setSelectionRange(newCaret, newCaret);
    });
  }, [triggerIdx, value, onChange]);

  const handleClickCandidate = (c: MentionCandidate) => {
    insertSelection(c);
  };

  const commonProps = {
    ref: inputRef as any,
    value,
    onChange: handleChange,
    onKeyDown: handleKeyDown,
    onBlur: () => {
      // Delay close so clicks on the dropdown register.
      setTimeout(() => setOpen(false), 150);
    },
    'aria-label': ariaLabel,
    placeholder,
    disabled,
    style,
  };

  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      {asInput
        ? <input type="text" {...commonProps} />
        : <textarea rows={rows} {...commonProps} />}

      {open && filtered.length > 0 && (
        <div
          role="listbox"
          aria-label="Mention suggestions"
          style={{
            position: 'absolute',
            left: 0,
            bottom: 'calc(100% + 4px)',
            zIndex: 1200,
            background: tokens.colors.surfaceCard,
            border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md,
            boxShadow: tokens.shadows.panel,
            minWidth: 240,
            maxHeight: 240,
            overflowY: 'auto',
            padding: 4,
          }}
        >
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
        </div>
      )}
    </div>
  );
}
