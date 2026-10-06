import React from 'react';
import { sessionModelChoices } from '../../cli/hostModels';
import { tokens } from '../../tokens';

/** The creation form and live header render the same model values, names and order. */
export default function SessionModelSelect({ models, labels, value, onChange, label, defaultDisabled = false, ...props }: {
  models: readonly string[];
  labels: Record<string, string>;
  value: string | null;
  onChange(value: string): void;
  label?: string;
  defaultDisabled?: boolean;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const choices = sessionModelChoices(models, labels);
  const selected = value || (models.includes('default') ? 'default' : '');
  const select = (
    <select aria-label="Model" data-config-category="model" {...props}
      value={selected} onChange={(e) => onChange(e.target.value)}
      style={{ padding: '4px 8px', borderRadius: tokens.radii.md, border: `1px solid ${tokens.colors.border}`,
        background: tokens.colors.surface, color: tokens.colors.textPrimary, fontSize: 12, ...props.style }}>
      {choices.map((choice) => (
        <option key={choice.value} value={choice.value} disabled={defaultDisabled && choice.value === ''}>{choice.label}</option>
      ))}
    </select>
  );
  return label ? <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>{label}{select}</label> : select;
}
