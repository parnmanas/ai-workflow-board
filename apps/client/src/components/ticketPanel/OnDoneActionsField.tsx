import React from 'react';
import { tokens } from '../../tokens';
import type { Action, RuntimeParticipant } from '../../types';
import { formatAgentDisplayName } from '../../utils/agentName';
import { moveItem } from './ticketDraft';

interface OnDoneActionsFieldProps {
  /** Bound action ids in dispatch order (draft). */
  value: string[];
  onChange(update: (prev: string[]) => string[]): void;
  /** Every Action in the workspace — also resolves names of already-bound ids. */
  actions: Action[];
  agents: RuntimeParticipant[];
  labelStyle: React.CSSProperties;
}

const iconBtnStyle = (disabled: boolean): React.CSSProperties => ({
  flexShrink: 0,
  background: 'transparent', border: 'none',
  color: disabled ? tokens.colors.border : tokens.colors.textMuted,
  fontSize: '12px', lineHeight: 1, padding: '0 3px',
  cursor: disabled ? 'not-allowed' : 'pointer',
});

/**
 * Run on Done — per-ticket on-done action binding (ticket 16a6339c; picker
 * reworked in 59afc55a). The bound actions are dispatched exactly ONCE when
 * THIS ticket enters `done`. The array order IS the dispatch order (↑/↓ to
 * reorder; saved verbatim as on_done_action_ids). A bound id whose Action was
 * deleted still renders so it can be unbound; disabled actions are skipped at
 * dispatch, so they are flagged.
 */
export default function OnDoneActionsField({ value, onChange, actions, agents, labelStyle }: OnDoneActionsFieldProps) {
  const actionById = new Map(actions.map(a => [a.id, a]));
  const candidates = actions.filter(a => !value.includes(a.id));

  const targetOf = (act: Action) => {
    const agent = agents.find(a => a.id === act.target_agent_id);
    return agent ? (
      <span style={{ fontSize: '10px', color: tokens.colors.textSecondary }}>→ {formatAgentDisplayName(agent)}</span>
    ) : null;
  };
  const enabledNote = (act: Action) => !act.enabled && (
    <span style={{ fontSize: '10px', color: tokens.colors.warningLight, marginLeft: 'auto' }}>disabled — won’t fire</span>
  );

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ ...labelStyle, marginBottom: 6 }}>
        Run on Done{value.length > 0 ? ` · ${value.length} bound` : ''}
      </label>
      <div style={{
        background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.lg,
        padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5,
      }}>
        {value.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {value.map((id, idx) => {
              const act = actionById.get(id);
              return (
                <div key={id} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '3px 5px', borderRadius: 4, background: `${tokens.colors.accent}15`,
                }}>
                  <span style={{ flexShrink: 0, fontSize: '10px', fontWeight: 700, color: tokens.colors.textMuted, minWidth: 14, textAlign: 'right' }}>
                    {idx + 1}.
                  </span>
                  {act ? (
                    <>
                      <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{act.name}</span>
                      {targetOf(act)}
                      {enabledNote(act) || <span style={{ marginLeft: 'auto' }} />}
                    </>
                  ) : (
                    <span style={{ fontSize: '12px', color: tokens.colors.textMuted, fontStyle: 'italic', marginRight: 'auto' }}>
                      {id.slice(0, 8)}… (removed action)
                    </span>
                  )}
                  <button type="button" title="Move up (earlier in dispatch order)" disabled={idx === 0}
                    onClick={() => onChange(prev => moveItem(prev, idx, idx - 1))} style={iconBtnStyle(idx === 0)}>↑</button>
                  <button type="button" title="Move down (later in dispatch order)" disabled={idx === value.length - 1}
                    onClick={() => onChange(prev => moveItem(prev, idx, idx + 1))} style={iconBtnStyle(idx === value.length - 1)}>↓</button>
                  <button type="button" title="Unbind this action"
                    onClick={() => onChange(prev => prev.filter(x => x !== id))} style={{ ...iconBtnStyle(false), fontSize: '14px' }}>×</button>
                </div>
              );
            })}
          </div>
        )}

        {candidates.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: value.length > 0 ? 6 : 0 }}>
            {value.length > 0 && (
              <div style={{ fontSize: '10px', color: tokens.colors.textMuted, fontWeight: 600, padding: '0 4px' }}>Add an action</div>
            )}
            {candidates.map(act => (
              <button
                key={act.id}
                type="button"
                onClick={() => onChange(prev => [...prev, act.id])}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer',
                  padding: '3px 5px', borderRadius: 4, textAlign: 'left',
                  background: 'transparent', border: 'none', width: '100%',
                }}
              >
                <span style={{ flexShrink: 0, fontSize: '12px', color: tokens.colors.textMuted, lineHeight: 1 }}>+</span>
                <span style={{ fontSize: '12px', color: tokens.colors.textStrong, fontWeight: 500 }}>{act.name}</span>
                {targetOf(act)}
                {enabledNote(act)}
              </button>
            ))}
          </div>
        )}

        {value.length === 0 && candidates.length === 0 && (
          <div style={{ fontSize: '11px', color: tokens.colors.textMuted, fontStyle: 'italic', padding: '2px 4px' }}>
            No actions in this workspace yet — create one from the Actions menu to bind it here.
          </div>
        )}
      </div>
    </div>
  );
}
