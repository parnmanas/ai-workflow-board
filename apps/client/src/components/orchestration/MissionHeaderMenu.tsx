import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React from 'react';
import type { OrchestrationMissionDetail } from '../../types';
import { tokens } from '../../tokens';
import { Button } from '../common';
import SessionHeaderMenu, { SessionMenuItem, SessionMenuSection } from '../sessions/SessionHeaderMenu';

export function MissionIdentity({ id, onCopy }: { id: string; onCopy: () => void }) {
  useLocale();
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ color: tokens.colors.textMuted, fontSize: 12 }}>{translate('Mission ID')}</span>
      <code style={{ fontSize: 12, overflowWrap: 'anywhere', userSelect: 'text' }}>{id}</code>
      <Button variant="ghost" size="sm" onClick={onCopy} aria-label={translate('Copy mission ID')}>{translate('Copy')}</Button>
    </div>
  );
}

export default function MissionHeaderMenu({ mission, busy, onCopy, onEdit, onDelete }: {
  mission: Pick<OrchestrationMissionDetail, 'id' | 'status'>;
  busy: boolean;
  onCopy: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  useLocale();
  const canEdit = mission.status === 'draft';
  const canDelete = ['draft', 'completed', 'failed', 'cancelled'].includes(mission.status);
  return (
    <SessionHeaderMenu label={translate('Mission menu')}>
      {(close) => (
        <>
          <SessionMenuSection title={translate('Mission information')}>
            <MissionIdentity id={mission.id} onCopy={onCopy} />
          </SessionMenuSection>
          <SessionMenuSection title={translate('Actions')}>
            <SessionMenuItem
              icon="✎"
              label={translate('Edit mission')}
              title={canEdit ? translate('Edit the mission brief') : translate('The brief can only be edited before the mission starts')}
              disabled={busy || !canEdit}
              onSelect={() => { close(); onEdit(); }}
            />
            <SessionMenuItem
              icon="×"
              label={translate('Delete mission')}
              title={canDelete ? translate('Delete this mission and its steps') : translate('Cancel the mission before deleting it')}
              disabled={busy || !canDelete}
              onSelect={() => { close(); onDelete(); }}
            />
          </SessionMenuSection>
        </>
      )}
    </SessionHeaderMenu>
  );
}
