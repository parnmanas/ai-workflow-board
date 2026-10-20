import React from 'react';
import type { OrchestrationMissionDetail } from '../../types';
import { tokens } from '../../tokens';
import { Button } from '../common';
import SessionHeaderMenu, { SessionMenuItem, SessionMenuSection } from '../sessions/SessionHeaderMenu';

export function MissionIdentity({ id, onCopy }: { id: string; onCopy: () => void }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      <span style={{ color: tokens.colors.textMuted, fontSize: 12 }}>Mission ID</span>
      <code style={{ fontSize: 12, overflowWrap: 'anywhere', userSelect: 'text' }}>{id}</code>
      <Button variant="ghost" size="sm" onClick={onCopy} aria-label="Copy mission ID">Copy</Button>
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
  const canEdit = mission.status === 'draft';
  const canDelete = ['draft', 'completed', 'failed', 'cancelled'].includes(mission.status);
  return (
    <SessionHeaderMenu label="Mission menu">
      {(close) => (
        <>
          <SessionMenuSection title="Mission information">
            <MissionIdentity id={mission.id} onCopy={onCopy} />
          </SessionMenuSection>
          <SessionMenuSection title="Actions">
            <SessionMenuItem
              icon="✎"
              label="Edit mission"
              title={canEdit ? 'Edit the mission brief' : 'The brief can only be edited before the mission starts'}
              disabled={busy || !canEdit}
              onSelect={() => { close(); onEdit(); }}
            />
            <SessionMenuItem
              icon="×"
              label="Delete mission"
              title={canDelete ? 'Delete this mission and its steps' : 'Cancel the mission before deleting it'}
              disabled={busy || !canDelete}
              onSelect={() => { close(); onDelete(); }}
            />
          </SessionMenuSection>
        </>
      )}
    </SessionHeaderMenu>
  );
}
