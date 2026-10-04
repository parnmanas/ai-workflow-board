import React, { useId, useMemo, useState } from 'react';
import { tokens } from '../../tokens';
import { addTags, removeTag, suggestTags } from '../../tickets/tagInput';

interface TagInputProps {
  value: string[];
  onChange(next: string[]): void;
  /** Known tags for suggestions (plain names or `{tag, count}` facets). */
  suggestions?: ReadonlyArray<string | { tag: string; count?: number }>;
  label?: string;
  placeholder?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * Free-form tag editor: chips with ×, a text input that commits on Enter or a
 * comma (spaces stay inside a tag — "AWB Dev" is one tag), Backspace on an
 * empty input removes the last chip, and a suggestion list of known tags.
 * Logic lives in `tickets/tagInput.ts`.
 */
export function TagInput({ value, onChange, suggestions = [], label, placeholder = '태그 입력 후 Enter', disabled, id }: TagInputProps) {
  const generated = useId();
  const inputId = id || `tag-input-${generated}`;
  const [draft, setDraft] = useState('');
  const [focused, setFocused] = useState(false);
  const shown = useMemo(
    () => (focused ? suggestTags(suggestions, value, draft) : []),
    [focused, suggestions, value, draft],
  );

  const commit = (raw: string) => {
    const next = addTags(value, raw);
    if (next.length !== value.length) onChange(next);
    setDraft('');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {label && (
        <label
          htmlFor={inputId}
          style={{
            fontSize: tokens.typography.fontSizeXs,
            fontWeight: tokens.typography.fontWeightSemibold,
            color: tokens.colors.textMuted,
            textTransform: 'uppercase',
            display: 'block',
            marginBottom: tokens.spacing.xs,
          }}
        >
          {label}
        </label>
      )}
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center',
          background: tokens.colors.surface,
          border: `1px solid ${focused ? tokens.colors.accent : tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          padding: '4px 6px',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {value.map((tag) => (
          <span
            key={tag}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              fontSize: 12, padding: '2px 4px 2px 8px', borderRadius: 10,
              background: `${tokens.colors.accent}26`, color: tokens.colors.accentSubtle,
            }}
          >
            #{tag}
            <button
              type="button"
              aria-label={`태그 ${tag} 제거`}
              disabled={disabled}
              onClick={() => onChange(removeTag(value, tag))}
              style={{
                border: 'none', background: 'transparent', color: 'inherit',
                cursor: disabled ? 'default' : 'pointer', fontSize: 12, padding: '0 2px', lineHeight: 1,
              }}
            >×</button>
          </span>
        ))}
        <input
          id={inputId}
          value={draft}
          disabled={disabled}
          placeholder={value.length ? '' : placeholder}
          onChange={(e) => {
            const text = e.target.value;
            if (text.includes(',')) commit(text);
            else setDraft(text);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              if (draft.trim()) commit(draft);
            } else if (e.key === 'Backspace' && !draft && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onFocus={() => setFocused(true)}
          // Commit synchronously: a click on Save right after typing must see
          // the pending tag. Suggestion buttons cancel mousedown, so clicking
          // one never blurs the input in the first place.
          onBlur={() => {
            setFocused(false);
            if (draft.trim()) commit(draft);
          }}
          style={{
            flex: 1, minWidth: 90, border: 'none', outline: 'none', background: 'transparent',
            color: tokens.colors.textStrong, fontSize: tokens.typography.fontSizeMd,
            fontFamily: 'inherit', padding: '4px 2px',
          }}
        />
      </div>
      {shown.length > 0 && (
        <div
          role="listbox"
          aria-label="태그 제안"
          style={{
            position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 2, zIndex: 20,
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.md, boxShadow: tokens.shadows.card,
            maxHeight: 180, overflowY: 'auto',
          }}
        >
          {shown.map((tag) => (
            <button
              key={tag}
              type="button"
              role="option"
              aria-selected={false}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => commit(tag)}
              style={{
                display: 'block', width: '100%', textAlign: 'left', border: 'none',
                background: 'transparent', color: tokens.colors.textSecondary,
                padding: '6px 10px', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit',
              }}
            >#{tag}</button>
          ))}
        </div>
      )}
    </div>
  );
}

export default TagInput;
