import React from 'react';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { modelChoices } from '../../cli/hostModels';
import { tokens } from '../../tokens';

/** All execution surfaces preserve the host's model IDs, labels and order. */
export default function RuntimeModelSelect({ models, labels, value, onChange, label, defaultDisabled = false, ...props }: {
  models: readonly string[];
  labels: Record<string, string>;
  value: string | null;
  onChange(value: string): void;
  label?: string;
  /** A live ACP session only accepts options reported by its adapter. */
  defaultDisabled?: boolean;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  useLocale();
  const choices = modelChoices(models, labels, value);
  const style: React.CSSProperties = { minWidth: 0, maxWidth: '100%', padding: '8px 10px', borderRadius: tokens.radii.md,
    border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
    color: tokens.colors.textPrimary, fontSize: 12, ...props.style };
  const control = !models.length && !defaultDisabled ? (
    <input {...Object.fromEntries(Object.entries(props).filter(([key]) => key.startsWith('data-')))} id={props.id} aria-label={props['aria-label'] || translate('Model')} data-config-category="model"
      disabled={props.disabled} title={props.title} style={style} value={value || ''}
      placeholder={translate('CLI default')} onChange={(e) => onChange(e.target.value)} />
  ) : (
    <select aria-label={translate('Model')} data-config-category="model" {...props}
      value={value || (models.includes('default') ? 'default' : '')} style={style}
      onChange={(e) => onChange(e.target.value)}>
      {choices.map((choice) => <option key={choice.value} value={choice.value}
        disabled={defaultDisabled && (!choice.value || !models.includes(choice.value))}>{choice.label}</option>)}
    </select>
  );
  return label ? <label style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, fontSize: 12 }}>{label}{control}</label> : control;
}
