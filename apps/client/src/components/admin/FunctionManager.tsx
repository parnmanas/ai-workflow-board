import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import type { CatalogScope, WorkflowFunction, WorkflowFunctionExecutor, WorkflowFunctionRisk, WorkflowFunctionRun } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';

interface Props {
  workspaceId?: string;
  globalMode?: boolean;
  catalogMode?: boolean;
  createScope?: CatalogScope;
  boardId?: string;
  allScopes?: boolean;
}

type Draft = {
  key: string;
  name: string;
  description: string;
  executor_type: WorkflowFunctionExecutor;
  risk_level: WorkflowFunctionRisk;
  idempotency_mode: 'none' | 'key';
  approval_policy: 'none' | 'admin';
  timeout_ms: number;
  max_attempts: number;
  enabled: boolean;
  input_schema: string;
  output_schema: string;
  config: string;
};

const emptyDraft: Draft = {
  key: '',
  name: '',
  description: '',
  executor_type: 'pipeline',
  risk_level: 'read',
  idempotency_mode: 'none',
  approval_policy: 'none',
  timeout_ms: 300000,
  max_attempts: 1,
  enabled: true,
  input_schema: '{\n  "type": "object"\n}',
  output_schema: '{\n  "type": "object"\n}',
  config: '{\n  "steps": []\n}',
};

function draftFrom(row: WorkflowFunction): Draft {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    executor_type: row.executor_type,
    risk_level: row.risk_level,
    idempotency_mode: row.idempotency_mode,
    approval_policy: row.approval_policy,
    timeout_ms: row.timeout_ms,
    max_attempts: row.max_attempts,
    enabled: row.enabled,
    input_schema: JSON.stringify(row.input_schema, null, 2),
    output_schema: JSON.stringify(row.output_schema, null, 2),
    config: JSON.stringify(row.config, null, 2),
  };
}

const control: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  background: tokens.colors.surface,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: 6,
  color: tokens.colors.textPrimary,
  padding: '8px 10px',
  fontFamily: 'inherit',
  fontSize: 13,
};

const button = (primary = false): React.CSSProperties => ({
  border: `1px solid ${primary ? tokens.colors.accent : tokens.colors.borderStrong}`,
  background: primary ? tokens.colors.accent : tokens.colors.surfaceSubtle,
  color: tokens.colors.textPrimary,
  padding: '7px 12px',
  borderRadius: 6,
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: 600,
});

export default function FunctionManager({
  workspaceId,
  globalMode = false,
  catalogMode = false,
  createScope = 'workspace',
  boardId,
  allScopes = false,
}: Props) {
  const { showToast } = useToast();
  const [rows, setRows] = useState<WorkflowFunction[]>([]);
  const [runs, setRuns] = useState<WorkflowFunctionRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WorkflowFunction | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [saving, setSaving] = useState(false);
  const [runningId, setRunningId] = useState('');
  const [ticketId, setTicketId] = useState('');
  const [runInputs, setRunInputs] = useState('{}');
  const [idempotencyKey, setIdempotencyKey] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [functions, history] = await Promise.all([
        api.listFunctions(globalMode ? null : workspaceId, catalogMode, allScopes ? undefined : boardId),
        !globalMode && workspaceId ? api.listFunctionRuns(workspaceId, { limit: 30 }) : Promise.resolve([]),
      ]);
      setRows(functions);
      setRuns(history);
    } catch (error: any) {
      showToast(error?.message || 'Failed to load Functions', 'error');
    } finally {
      setLoading(false);
    }
  }, [globalMode, catalogMode, workspaceId, boardId, allScopes, showToast]);

  useEffect(() => { load(); }, [load]);

  const startCreate = (source?: WorkflowFunction) => {
    setEditing(null);
    setCreating(true);
    if (source) {
      setDraft({ ...draftFrom(source), key: source.key, name: `${source.name} (workspace override)` });
    } else {
      setDraft({ ...emptyDraft });
    }
  };

  const startEdit = (row: WorkflowFunction) => {
    setEditing(row);
    setCreating(false);
    setDraft(draftFrom(row));
  };

  const closeEditor = () => {
    setEditing(null);
    setCreating(false);
  };

  const save = async () => {
    if (!draft.key.trim() || !draft.name.trim()) {
      showToast('Key and name are required', 'error');
      return;
    }
    let inputSchema: any;
    let outputSchema: any;
    let config: any;
    try {
      inputSchema = JSON.parse(draft.input_schema);
      outputSchema = JSON.parse(draft.output_schema);
      config = JSON.parse(draft.config);
    } catch {
      showToast('Schema and config fields must contain valid JSON', 'error');
      return;
    }
    setSaving(true);
    const effectiveScope = editing?.scope || (globalMode ? 'global' : createScope);
    const payload = {
      scope: effectiveScope,
      workspace_id: effectiveScope === 'global' ? null : workspaceId,
      board_id: effectiveScope === 'board' ? (editing?.board_id || boardId || null) : null,
      ...draft,
      input_schema: inputSchema,
      output_schema: outputSchema,
      config,
    };
    try {
      if (editing) await api.updateFunction(editing.id, payload as any);
      else await api.createFunction(payload as any);
      showToast(editing ? 'Function updated' : 'Function created', 'success');
      closeEditor();
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Failed to save Function', 'error');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row: WorkflowFunction) => {
    if (!window.confirm(`Delete Function "${row.key}"? Run history is retained for audit.`)) return;
    try {
      await api.deleteFunction(row.id);
      showToast('Function deleted', 'success');
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Failed to delete Function', 'error');
    }
  };

  const run = async (row: WorkflowFunction) => {
    if (!workspaceId) return;
    let inputs: Record<string, any>;
    try {
      inputs = JSON.parse(runInputs || '{}');
    } catch {
      showToast('Run inputs must contain valid JSON', 'error');
      return;
    }
    setRunningId(row.id);
    try {
      const result = await api.runFunction(row.id, {
        workspace_id: workspaceId,
        board_id: boardId || undefined,
        ticket_id: ticketId || undefined,
        inputs,
        idempotency_key: idempotencyKey || undefined,
      });
      showToast(`Function ${result.status}${result.deduplicated ? ' (deduplicated)' : ''}`, result.status === 'succeeded' ? 'success' : 'error');
      await load();
    } catch (error: any) {
      showToast(error?.message || 'Function execution failed', 'error');
      await load();
    } finally {
      setRunningId('');
    }
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
          {globalMode
            ? 'Global definitions have workspace_id = NULL and are inherited by every workspace.'
            : 'Workspace definitions override inherited Global Functions when their key is the same.'}
        </div>
        <button style={button(true)} onClick={() => startCreate()}>New Function</button>
      </div>

      {!globalMode && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 2fr', gap: 10, background: tokens.colors.surfaceCard, padding: 14, borderRadius: 8 }}>
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Ticket ID (optional)
            <input style={{ ...control, marginTop: 5 }} value={ticketId} onChange={event => setTicketId(event.target.value)} />
          </label>
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Idempotency key (when required)
            <input style={{ ...control, marginTop: 5 }} value={idempotencyKey} onChange={event => setIdempotencyKey(event.target.value)} />
          </label>
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Run inputs (JSON)
            <input style={{ ...control, marginTop: 5, fontFamily: 'monospace' }} value={runInputs} onChange={event => setRunInputs(event.target.value)} />
          </label>
        </div>
      )}

      {(creating || editing) && (
        <div style={{ background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.borderStrong}`, borderRadius: 10, padding: 18, display: 'grid', gap: 12 }}>
          <div style={{ fontWeight: 700, color: tokens.colors.textPrimary }}>{editing ? `Edit ${editing.key}` : 'Create Function'}</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Key<input style={{ ...control, marginTop: 5 }} value={draft.key} onChange={e => setDraft({ ...draft, key: e.target.value })} /></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Name<input style={{ ...control, marginTop: 5 }} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
          </div>
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Description<input style={{ ...control, marginTop: 5 }} value={draft.description} onChange={e => setDraft({ ...draft, description: e.target.value })} /></label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Executor<select style={{ ...control, marginTop: 5 }} value={draft.executor_type} onChange={e => setDraft({ ...draft, executor_type: e.target.value as WorkflowFunctionExecutor })}><option>builtin</option><option>pipeline</option><option>http</option><option>agent_action</option></select></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Risk<select style={{ ...control, marginTop: 5 }} value={draft.risk_level} onChange={e => setDraft({ ...draft, risk_level: e.target.value as WorkflowFunctionRisk })}><option>read</option><option>write</option><option>destructive</option><option>high_impact</option></select></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Idempotency<select style={{ ...control, marginTop: 5 }} value={draft.idempotency_mode} onChange={e => setDraft({ ...draft, idempotency_mode: e.target.value as any })}><option>none</option><option>key</option></select></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Approval<select style={{ ...control, marginTop: 5 }} value={draft.approval_policy} onChange={e => setDraft({ ...draft, approval_policy: e.target.value as any })}><option>none</option><option>admin</option></select></label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 10, alignItems: 'end' }}>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Timeout (ms)<input type="number" style={{ ...control, marginTop: 5 }} value={draft.timeout_ms} onChange={e => setDraft({ ...draft, timeout_ms: Number(e.target.value) })} /></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>Max attempts<input type="number" style={{ ...control, marginTop: 5 }} value={draft.max_attempts} onChange={e => setDraft({ ...draft, max_attempts: Number(e.target.value) })} /></label>
            <label style={{ color: tokens.colors.textSecondary, fontSize: 12, paddingBottom: 9 }}><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> Enabled</label>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 10 }}>
            {(['input_schema', 'output_schema', 'config'] as const).map(field => (
              <label key={field} style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
                {field}
                <textarea rows={10} style={{ ...control, marginTop: 5, fontFamily: 'monospace', resize: 'vertical' }} value={draft[field]} onChange={e => setDraft({ ...draft, [field]: e.target.value })} />
              </label>
            ))}
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <button style={button()} onClick={closeEditor}>Cancel</button>
            <button style={button(true)} disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 8 }}>
        {loading ? (
          <div style={{ color: tokens.colors.textMuted }}>Loading…</div>
        ) : rows.length === 0 ? (
          <div style={{ color: tokens.colors.textMuted }}>No Functions defined.</div>
        ) : rows.map(row => {
          const inherited = !globalMode && !catalogMode && row.workspace_id === null;
          return (
            <div key={row.id} style={{ background: tokens.colors.surfaceCard, border: `1px solid ${tokens.colors.border}`, borderRadius: 8, padding: 14, display: 'grid', gridTemplateColumns: 'minmax(240px, 1fr) auto', gap: 14 }}>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: tokens.colors.textPrimary, fontWeight: 700 }}>
                  <code>{row.key}</code>
                  <span style={{ color: inherited ? tokens.colors.info : tokens.colors.accentLight, fontSize: 11 }}>{inherited ? 'GLOBAL' : row.scope.toUpperCase()}</span>
                  <span style={{ color: tokens.colors.textMuted, fontSize: 11 }}>v{row.version}</span>
                  {!row.enabled && <span style={{ color: tokens.colors.warning, fontSize: 11 }}>DISABLED</span>}
                </div>
                <div style={{ color: tokens.colors.textStrong, marginTop: 5 }}>{row.name}</div>
                <div style={{ color: tokens.colors.textMuted, fontSize: 12, marginTop: 4 }}>{row.description || 'No description'}</div>
                <div style={{ color: tokens.colors.textSecondary, fontSize: 11, marginTop: 7 }}>
                  {row.executor_type} · {row.risk_level} · idempotency: {row.idempotency_mode} · approval: {row.approval_policy}
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                {!globalMode && <button style={button(true)} disabled={!!runningId} onClick={() => run(row)}>{runningId === row.id ? 'Running…' : 'Run'}</button>}
                {inherited ? (
                  <button style={button()} onClick={() => startCreate(row)}>Override</button>
                ) : (
                  <>
                    <button style={button()} onClick={() => startEdit(row)}>Edit</button>
                    {!row.builtin && <button style={button()} onClick={() => remove(row)}>Delete</button>}
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {!globalMode && (
        <div>
          <div style={{ color: tokens.colors.textPrimary, fontWeight: 700, marginBottom: 8 }}>Recent runs</div>
          <div style={{ display: 'grid', gap: 5 }}>
            {runs.length === 0 ? <div style={{ color: tokens.colors.textMuted, fontSize: 12 }}>No Function runs yet.</div> : runs.map(runRow => (
              <div key={runRow.id} style={{ display: 'grid', gridTemplateColumns: '1fr 110px 180px', gap: 10, padding: '8px 10px', background: tokens.colors.surfaceSubtle, borderRadius: 6, fontSize: 12 }}>
                <code style={{ color: tokens.colors.textStrong }}>{runRow.function_key}</code>
                <span style={{ color: runRow.status === 'succeeded' ? tokens.colors.successLight : runRow.status === 'failed' ? tokens.colors.dangerLight : tokens.colors.warningLight }}>{runRow.status}</span>
                <span style={{ color: tokens.colors.textMuted }}>{new Date(runRow.created_at).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
