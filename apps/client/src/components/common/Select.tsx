import React, { useState } from 'react';
import { tokens } from '../../tokens';

interface SelectOption {
  value: string;
  label: string;
}

interface SelectProps extends Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  label?: string;
  options: SelectOption[];
  error?: string;
  placeholder?: string;
}

// Chevron SVG encoded as data URL using tokens.colors.textSecondary (#94a3b8)
const CHEVRON_ICON = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='none' stroke='%2394a3b8' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round' d='M2 4l4 4 4-4'/%3E%3C/svg%3E")`;

export function Select({
  label,
  options,
  error,
  placeholder,
  disabled,
  value,
  onFocus,
  onBlur,
  ...rest
}: SelectProps) {
  const [isFocused, setIsFocused] = useState(false);

  const handleFocus = (e: React.FocusEvent<HTMLSelectElement>) => {
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLSelectElement>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  const borderColor = error
    ? tokens.colors.danger
    : isFocused
    ? tokens.colors.accent
    : tokens.colors.border;

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {label && (
        <label
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
      <select
        disabled={disabled}
        value={value}
        onFocus={handleFocus}
        onBlur={handleBlur}
        style={{
          background: tokens.colors.surface,
          border: `1px solid ${borderColor}`,
          borderRadius: tokens.radii.md,
          padding: '8px 10px',
          paddingRight: '28px',
          color: tokens.colors.textStrong,
          fontSize: tokens.typography.fontSizeMd,
          outline: 'none',
          width: '100%',
          boxSizing: 'border-box',
          fontFamily: 'inherit',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
          appearance: 'none',
          backgroundImage: CHEVRON_ICON,
          backgroundRepeat: 'no-repeat',
          backgroundPosition: 'right 10px center',
          backgroundSize: '12px',
          transition: 'border-color 0.15s ease',
        }}
        {...rest}
      >
        {placeholder && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      {error && (
        <span
          style={{
            fontSize: tokens.typography.fontSizeXs,
            color: tokens.colors.danger,
            marginTop: tokens.spacing.xs,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
