import React, { useEffect, useState } from 'react';
import { api } from '../../api';
import { tokens } from '../../tokens';
import RuntimeSpecEditor, { type RuntimeHostChoice } from '../runtime/RuntimeSpecEditor';
import { isRuntimeSpecComplete, specSummary, type RuntimeSpecDraft } from '../../runtime/runtimeSpec';
import { applyProjectFolder, type ProjectFolderSource } from '../../projects/projectFolders';
import { assigneeDisplayName } from '../../tickets/assignee';
import { toEditableSpec } from './ticketDraft';

interface AssigneeSectionProps {
  /** Effective assignee (buffered draft if any, else the saved one). */
  assignee: RuntimeSpecDraft | null;
  /** True when `assignee` is a buffered edit that is not saved yet. */
  unsaved: boolean;
  /** The ticket's (draft) project — its folder on the chosen host prefills working_dir. */
  project: ProjectFolderSource | null;
  accountId: string;
  disabled?: boolean;
  /** Puts the validated spec (or null = clear) into the Save draft. */
  onChange(next: RuntimeSpecDraft | null): void;
  /** Reason of the last "Run" that did not dispatch — shown under the summary. */
  runNote?: string | null;
  labelStyle: React.CSSProperties;
}

const btn = (variant: 'primary' | 'plain' | 'danger', disabled = false): React.CSSProperties => ({
  background: variant === 'primary' ? tokens.colors.accent : 'transparent',
  color: variant === 'primary' ? 'white' : variant === 'danger' ? tokens.colors.dangerLight : tokens.colors.textSecondary,
  border: variant === 'primary' ? 'none' : `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md, padding: '4px 10px', fontSize: '11px', fontWeight: 600,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
});

/**
 * The ticket's single assignee (docs/tickets.md → assignee: RuntimeSpec | null).
 * The editor is a local scratch copy; "적용" validates it server-side
 * (`POST /runtime-specs/validate`) and hands the normalized spec to the panel's
 * Save draft — nothing is written until the footer Save.
 */
export default function AssigneeSection({
  assignee, unsaved, project, accountId, disabled, onChange, runNote, labelStyle,
}: AssigneeSectionProps) {
  const [hosts, setHosts] = useState<RuntimeHostChoice[]>([]);
  const [hostsLoaded, setHostsLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editorDraft, setEditorDraft] = useState<RuntimeSpecDraft>(() => toEditableSpec(null));
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api.listTemplateHosts()
      .then(rows => {
        if (cancelled) return;
        setHosts((rows || []).map(h => ({ id: h.id, name: h.name || '(이름 없는 호스트)' })));
      })
      .catch(() => { if (!cancelled) setHosts([]); })
      .finally(() => { if (!cancelled) setHostsLoaded(true); });
    return () => { cancelled = true; };
  }, []);

  // Never show a raw host uuid as a name (agent-display-name runbook): an
  // unknown host renders the bare spec label / a placeholder, not its id.
  const hostNames = Object.fromEntries(hosts.map(h => [h.id, h.name]));
  const hostNameOf = (id: string | undefined) =>
    hosts.find(h => h.id === id)?.name || (hostsLoaded ? '알 수 없는 호스트' : '…');

  const openEditor = () => {
    setEditorDraft(applyProjectFolder(toEditableSpec(assignee), project));
    setError(null);
    setEditing(true);
  };

  // RuntimeSpecEditor clears working_dir when the host changes — refill it
  // from the project's main clone folder on the new host (never overwrite a
  // folder the operator typed; applyProjectFolder only fills an empty one).
  const handleEditorChange = (next: RuntimeSpecDraft) => {
    setEditorDraft(prev => (next.manager_agent_id !== prev.manager_agent_id ? applyProjectFolder(next, project) : next));
  };

  const handleApply = async () => {
    if (!isRuntimeSpecComplete(editorDraft)) {
      setError('Host·CLI·절대경로를 모두 입력하세요');
      return;
    }
    setValidating(true);
    setError(null);
    try {
      const result = await api.validateRuntimeSpec(accountId || null, editorDraft);
      if (!result.ok || !result.spec) throw new Error(result.error || 'Invalid runtime');
      onChange(toEditableSpec(result.spec));
      setEditing(false);
    } catch (err: any) {
      setError(err?.message || 'Runtime 검증에 실패했습니다');
    } finally {
      setValidating(false);
    }
  };

  const hostName = assignee ? hostNameOf(assignee.manager_agent_id) : '';

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={labelStyle}>
        Assignee
        {unsaved && <span style={{ marginLeft: 6, color: tokens.colors.warningLight, textTransform: 'none' }}>· 저장 전</span>}
      </label>
      <div style={{
        background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md, padding: '8px 10px',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            {assignee ? (
              <>
                <div style={{ fontSize: '12px', fontWeight: 600, color: tokens.colors.textStrong }}>
                  {assigneeDisplayName(assignee, hostNames)}
                </div>
                <div
                  title={assignee.working_dir}
                  style={{ fontSize: '11px', color: tokens.colors.textMuted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {specSummary(assignee, hostName)}
                </div>
              </>
            ) : (
              <span style={{ fontSize: '12px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                미지정 — 디스패치되지 않음
              </span>
            )}
          </div>
          {!editing && (
            <>
              <button type="button" disabled={disabled} onClick={openEditor} style={btn('plain', disabled)}>
                {assignee ? 'Edit' : '지정'}
              </button>
              {assignee && (
                <button type="button" disabled={disabled} onClick={() => onChange(null)} style={btn('danger', disabled)}>
                  Clear
                </button>
              )}
            </>
          )}
        </div>
        {runNote && (
          <div style={{ marginTop: 6, fontSize: '11px', color: tokens.colors.warningLight }}>
            마지막 실행 요청: {runNote}
          </div>
        )}
        {editing && (
          <div style={{ marginTop: 10, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
            <RuntimeSpecEditor
              value={editorDraft}
              onChange={handleEditorChange}
              hosts={hosts}
              accountId={accountId}
              disabled={validating || disabled}
            />
            {error && (
              <div role="alert" style={{ marginTop: 6, fontSize: '11px', color: tokens.colors.dangerLight }}>{error}</div>
            )}
            <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end', marginTop: 8 }}>
              <button type="button" onClick={() => { setEditing(false); setError(null); }} disabled={validating} style={btn('plain', validating)}>
                취소
              </button>
              <button type="button" onClick={handleApply} disabled={validating || disabled} style={btn('primary', validating || disabled)}>
                {validating ? '검증 중…' : '적용'}
              </button>
            </div>
            <div style={{ fontSize: '10px', color: tokens.colors.textMuted, marginTop: 4, textAlign: 'right' }}>
              적용한 담당자는 아래 Save 로 저장됩니다.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
