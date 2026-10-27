import React, { useEffect, useState } from 'react';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { isAbsoluteHostPath } from '../../runtime/runtimeSpec';
import { tokens } from '../../tokens';
import { Button, Input } from '../common';
import DirectoryPicker from '../admin/DirectoryPicker';

/** Host paths always use this input, validation and remote directory browser. */
export default function WorkingDirectoryField({ hostId, value, onChange, disabled = false, optionalHint }: {
  hostId: string;
  value: string;
  onChange(path: string): void;
  disabled?: boolean;
  optionalHint?: string | null;
}) {
  useLocale();
  // Bind an open picker to its host. Switching hosts cannot apply an old listing.
  const [pickerHost, setPickerHost] = useState<string | null>(null);
  useEffect(() => { setPickerHost(null); }, [hostId]);
  const label = translate('Working directory (on the Runtime Host)');
  const error = value.trim() && !isAbsoluteHostPath(value.trim())
    ? translate('Host 절대 경로여야 합니다 (예: /home/user/work)') : undefined;
  return <div data-runtime-field="working-directory" style={{ minWidth: 0 }}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flexWrap: 'wrap' }}>
      <div style={{ flex: '1 1 180px', minWidth: 0 }}>
        <Input label={label} aria-label={label} value={value} disabled={disabled}
          placeholder="/path/to/repo" error={error} aria-invalid={!!error}
          onChange={(e) => onChange(e.target.value)} />
      </div>
      <Button variant="secondary" size="sm" disabled={disabled || !hostId}
        style={{ marginTop: 22, whiteSpace: 'nowrap' }} onClick={() => setPickerHost(hostId)}>{translate('Browse…')}</Button>
    </div>
    {optionalHint && !value.trim() && <div data-testid="runtime-folder-optional-hint"
      style={{ fontSize: 11, color: tokens.colors.textSecondary, marginTop: 4, lineHeight: 1.5 }}>{optionalHint}</div>}
    {!!hostId && pickerHost === hostId && !disabled && <DirectoryPicker key={hostId} isOpen
      managerAgentId={hostId} initialPath={value.trim() || undefined} onClose={() => setPickerHost(null)}
      onPick={(path) => { onChange(path); setPickerHost(null); }} />}
  </div>;
}
