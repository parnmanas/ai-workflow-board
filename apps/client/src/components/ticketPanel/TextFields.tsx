import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React, { useLayoutEffect, useRef, useState } from 'react';
import { tokens } from '../../tokens';
import { renderMarkdown, handleMentionAwareCopy } from '../common/Markdown';
import { controlStyle, fieldLabel, panelButton, section, wrapText } from './panelStyles';

/** Grows with its content so nothing is cut off or hidden behind a scrollbar. */
function useAutoHeight(value: string, minHeight: number) {
  useLocale();
  const ref = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(minHeight, el.scrollHeight)}px`;
  }, [value, minHeight]);
  return ref;
}

/** The ticket title: wraps over as many lines as it needs. Enter commits (no newlines). */
export function TitleField({ value, onChange }: { value: string; onChange(next: string): void }) {
  useLocale();
  const ref = useAutoHeight(value, 28);
  return (
    <textarea
      ref={ref}
      aria-label={translate('제목')}
      rows={1}
      value={value}
      onChange={e => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }}
      style={{
        width: '100%', boxSizing: 'border-box', resize: 'none', overflow: 'hidden',
        background: 'transparent', border: '1px solid transparent', borderRadius: tokens.radii.md,
        color: tokens.colors.textPrimary, fontSize: '17px', fontWeight: 700, lineHeight: 1.35,
        padding: '2px 4px', margin: '0 -4px', fontFamily: 'inherit', outline: 'none', ...wrapText,
      }}
      onFocus={e => { e.currentTarget.style.borderColor = tokens.colors.border; }}
      onBlur={e => { e.currentTarget.style.borderColor = 'transparent'; }}
    />
  );
}

interface DescriptionFieldProps {
  value: string;
  /** True when `value` differs from the saved description (keeps the editor open). */
  dirty: boolean;
  onChange(next: string): void;
}

/** Rendered markdown to read; a growing textarea to edit. */
export function DescriptionField({ value, dirty, onChange }: DescriptionFieldProps) {
  useLocale();
  const [editing, setEditing] = useState(false);
  const open = editing || dirty;
  const ref = useAutoHeight(open ? value : '', 120);

  return (
    <div style={section}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 4 }}>
        <span style={{ ...fieldLabel, marginBottom: 0 }}>{translate('설명')}</span>
        {value && (
          <button type="button" onClick={() => setEditing(v => !v)} style={{ ...panelButton('plain'), padding: '2px 8px', fontSize: '11px' }}>
            {open ? translate('미리보기') : translate('편집')}
          </button>
        )}
      </div>
      {open || !value ? (
        <textarea
          ref={ref}
          value={value}
          onChange={e => onChange(e.target.value)}
          onFocus={() => setEditing(true)}
          placeholder={translate('무엇을, 왜 해야 하는지 적어 주세요 (마크다운)')}
          style={{
            ...controlStyle, fontSize: '13px', lineHeight: 1.6, padding: '8px 10px',
            resize: 'vertical', overflow: 'hidden', minHeight: value ? 120 : 64,
          }}
        />
      ) : (
        <div
          onCopy={handleMentionAwareCopy}
          onDoubleClick={() => setEditing(true)}
          title={translate('두 번 클릭해서 편집')}
          style={{
            background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
            borderRadius: tokens.radii.lg, padding: '8px 10px',
            fontSize: '13px', lineHeight: 1.6, color: tokens.colors.textStrong,
            whiteSpace: 'pre-wrap', ...wrapText,
          }}
        >{renderMarkdown(value)}</div>
      )}
    </div>
  );
}
