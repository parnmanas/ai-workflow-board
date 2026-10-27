import React from 'react';
import type { AgentSessionConfigOption } from '../../types';
import RuntimeModelSelect from './RuntimeModelSelect';
import { tokens } from '../../tokens';

/** Render a host-declared option once for creation, defaults and live sessions. */
export default function RuntimeOptionControl({ option, value, onChange, defaultLabel, ...props }: {
  option: AgentSessionConfigOption;
  value: string | boolean | null;
  onChange(value: string | boolean): void;
  defaultLabel?: string;
} & Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'value' | 'onChange'>) {
  const common = { 'aria-label': option.name, title: option.description || option.name,
    'data-config-id': option.config_id, 'data-config-category': option.category };
  if (option.type === 'boolean') return <input type="checkbox" {...common} disabled={props.disabled}
    checked={value === true} onChange={(e) => onChange(e.target.checked)} />;
  if (option.type !== 'select') return null;
  if (option.category === 'model') return <RuntimeModelSelect {...common} {...props}
    models={option.options.map((choice) => choice.value)}
    labels={Object.fromEntries(option.options.map((choice) => [choice.value, choice.name]))}
    value={typeof value === 'string' ? value : null} defaultDisabled={defaultLabel === undefined}
    onChange={onChange} />;
  const groups = new Map<string, typeof option.options>();
  for (const choice of option.options) {
    const group = choice.group || '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(choice);
  }
  const choices = (rows: typeof option.options) => rows.map((choice) =>
    <option key={choice.value} value={choice.value} title={choice.description}>{choice.name}</option>);
  const saved = typeof value === 'string' ? value : '';
  return <select {...common} {...props} value={saved} onChange={(e) => onChange(e.target.value)}
    style={{ maxWidth: '100%', minWidth: 0, padding: '8px 10px', borderRadius: tokens.radii.md,
      border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface,
      color: tokens.colors.textPrimary, fontSize: 12, ...props.style }}>
    {(defaultLabel !== undefined || !saved) && <option value="">{defaultLabel ?? `${option.name}…`}</option>}
    {saved && !option.options.some((choice) => choice.value === saved) && <option value={saved} disabled>{saved}</option>}
    {Array.from(groups, ([group, rows]) => group
      ? <optgroup key={group} label={group}>{choices(rows)}</optgroup> : choices(rows))}
  </select>;
}
