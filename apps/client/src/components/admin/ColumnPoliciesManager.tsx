import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Card } from '../common';

interface PolicyRow {
  id: string;
  board_id: string;
  column_id: string;
  role_slug: string;
  expected_action: 'move' | 'wait_until_label_removed' | 'terminal';
  target_column_id: string;
  gate_labels: string[];
  max_cycles_without_progress: number;
  on_violation: 'alert' | 'auto_move' | 'escalate_meta_ticket';
  enabled: boolean;
}

interface ColumnRow {
  id: string;
  name: string;
  position: number;
  kind: string;
  is_terminal: boolean;
  role_routing: string[];
  policies: PolicyRow[];
}

interface BoardBlock {
  board_id: string;
  board_name: string;
  workspace_id: string;
  columns: ColumnRow[];
}

type DirtyMap = Record<string, Partial<PolicyRow>>;

/**
 * Column Policies admin tab (ticket f886ada7).
 *
 * Lists every board, then every column with `role_routing` set, then a row
 * per (column × role) policy. Inline editors for the three knobs an
 * operator typically wants to tweak: `enabled`, `max_cycles_without_progress`,
 * and `on_violation`. `gate_labels` shown read-only as a comma-separated
 * pill list — admins can paste a new list to overwrite. `auto_move` is in
 * the dropdown so the wiring is testable, but until PR #4 lands the stuck
 * detector treats it the same as `alert` (a warning chip explains).
 */
export default function ColumnPoliciesManager() {
  const { showToast } = useToast();
  const [boards, setBoards] = useState<BoardBlock[]>([]);
  const [loading, setLoading] = useState(true);
  const [dirty, setDirty] = useState<DirtyMap>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.listColumnPolicies();
      setBoards(res.boards || []);
      setDirty({});
    } catch (e: any) {
      showToast(e?.message || 'Failed to load column policies', 'error');
    } finally {
      setLoading(false);
    }
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const columnsById = useMemo(() => {
    const out = new Map<string, ColumnRow>();
    for (const b of boards) for (const c of b.columns) out.set(c.id, c);
    return out;
  }, [boards]);

  const patch = (policyId: string, field: keyof PolicyRow, value: any) => {
    setDirty(prev => ({ ...prev, [policyId]: { ...(prev[policyId] || {}), [field]: value } }));
  };

  const effectiveValue = <K extends keyof PolicyRow>(p: PolicyRow, field: K): PolicyRow[K] => {
    const d = dirty[p.id];
    if (d && Object.prototype.hasOwnProperty.call(d, field)) return d[field] as PolicyRow[K];
    return p[field];
  };

  const save = async (p: PolicyRow) => {
    const d = dirty[p.id];
    if (!d) return;
    setSavingId(p.id);
    try {
      const body: any = {};
      if (typeof d.enabled === 'boolean') body.enabled = d.enabled;
      if (Number.isFinite(d.max_cycles_without_progress)) body.max_cycles_without_progress = d.max_cycles_without_progress;
      if (typeof d.on_violation === 'string') body.on_violation = d.on_violation;
      if (typeof d.expected_action === 'string') body.expected_action = d.expected_action;
      if (typeof d.target_column_id === 'string') body.target_column_id = d.target_column_id;
      if (Array.isArray(d.gate_labels)) body.gate_labels = d.gate_labels;
      await api.updateColumnPolicy(p.id, body);
      showToast('Policy saved.', 'success');
      await load();
    } catch (e: any) {
      showToast(e?.message || 'Failed to save policy', 'error');
    } finally {
      setSavingId(null);
    }
  };

  if (loading) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>;
  }

  if (boards.length === 0) {
    return <div style={{ fontSize: '13px', color: tokens.colors.textSecondary, padding: 24 }}>
      No boards configured yet.
    </div>;
  }

  const labelStyle: React.CSSProperties = {
    fontSize: tokens.typography.fontSizeXs,
    fontWeight: tokens.typography.fontWeightSemibold,
    color: tokens.colors.textMuted,
    textTransform: 'uppercase',
    display: 'block',
    marginBottom: 4,
  };

  const inputStyle: React.CSSProperties = {
    background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
    padding: '6px 8px',
    color: tokens.colors.textStrong,
    fontSize: '13px',
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24, maxWidth: 980 }}>
      <div style={{ fontSize: '12px', color: tokens.colors.textSecondary, lineHeight: 1.5 }}>
        Declarative enforcement layer for the stuck-ticket detector. For every column whose role is
        listed in <code>role_routing</code>, the system expects the agent to call <code>move_ticket</code>
        within <em>max_cycles_without_progress</em> cycles unless one of the configured gate labels is
        attached. Violations surface as a structured chat alert (PR #2). Auto-promotion lands in PR #4
        — until then, <code>auto_move</code> behaves identically to <code>alert</code>.
      </div>

      {boards.map(board => (
        <Card key={board.board_id} padding="20px">
          <div style={{ fontSize: '15px', fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 16 }}>
            {board.board_name}
            <span style={{ marginLeft: 8, fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 400 }}>
              {board.board_id}
            </span>
          </div>

          {board.columns.filter(c => c.policies.length > 0).length === 0 ? (
            <div style={{ fontSize: '12px', color: tokens.colors.textMuted, fontStyle: 'italic' }}>
              No routed roles on this board — add a role to <code>role_routing</code> on a column to seed a policy.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {board.columns.map(col => col.policies.length === 0 ? null : (
                <div key={col.id} style={{
                  border: `1px solid ${tokens.colors.border}`,
                  borderRadius: tokens.radii.md,
                  padding: 12,
                  background: tokens.colors.surface,
                }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, color: tokens.colors.textStrong, marginBottom: 8 }}>
                    {col.name}
                    <span style={{ marginLeft: 8, fontSize: '11px', color: tokens.colors.textMuted, fontWeight: 400 }}>
                      {col.kind || 'active'}{col.is_terminal ? ' · terminal' : ''} · pos {col.position}
                    </span>
                  </div>

                  {col.policies.map(p => {
                    const expectedAction = effectiveValue(p, 'expected_action');
                    const targetCol = columnsById.get(effectiveValue(p, 'target_column_id') || '');
                    const isDirty = !!dirty[p.id];
                    const gateLabels = effectiveValue(p, 'gate_labels');
                    return (
                      <div key={p.id} style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 1fr 1fr 1fr 1fr auto',
                        gap: 8,
                        padding: '8px 0',
                        borderTop: `1px solid ${tokens.colors.border}`,
                        alignItems: 'end',
                      }}>
                        <div>
                          <div style={labelStyle}>Role</div>
                          <div style={{ fontSize: '13px', color: tokens.colors.textStrong }}>{p.role_slug}</div>
                        </div>

                        <div>
                          <div style={labelStyle}>Expected</div>
                          <select
                            value={expectedAction}
                            onChange={(e) => patch(p.id, 'expected_action', e.target.value)}
                            style={{ ...inputStyle, width: '100%' }}
                          >
                            <option value="move">move → {targetCol?.name || '(unset)'}</option>
                            <option value="wait_until_label_removed">wait_until_label_removed</option>
                            <option value="terminal">terminal</option>
                          </select>
                        </div>

                        <div>
                          <div style={labelStyle}>Gate labels (comma-separated)</div>
                          <input
                            type="text"
                            value={gateLabels.join(', ')}
                            onChange={(e) => {
                              const next = e.target.value.split(',').map(s => s.trim()).filter(s => s.length > 0);
                              patch(p.id, 'gate_labels', next);
                            }}
                            placeholder="BLOCKED-*"
                            style={{ ...inputStyle, width: '100%' }}
                          />
                        </div>

                        <div>
                          <div style={labelStyle}>Max cycles</div>
                          <input
                            type="number"
                            min={1}
                            max={100}
                            value={effectiveValue(p, 'max_cycles_without_progress')}
                            onChange={(e) => patch(p.id, 'max_cycles_without_progress', Number(e.target.value))}
                            style={{ ...inputStyle, width: '100%' }}
                          />
                        </div>

                        <div>
                          <div style={labelStyle}>On violation</div>
                          <select
                            value={effectiveValue(p, 'on_violation')}
                            onChange={(e) => patch(p.id, 'on_violation', e.target.value)}
                            style={{ ...inputStyle, width: '100%' }}
                          >
                            <option value="alert">alert</option>
                            <option value="auto_move">auto_move (PR #4)</option>
                            <option value="escalate_meta_ticket">escalate_meta_ticket</option>
                          </select>
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-end' }}>
                          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12px', color: tokens.colors.textSecondary }}>
                            <input
                              type="checkbox"
                              checked={effectiveValue(p, 'enabled')}
                              onChange={(e) => patch(p.id, 'enabled', e.target.checked)}
                            />
                            enabled
                          </label>
                          <Button
                            variant="primary"
                            disabled={!isDirty || savingId === p.id}
                            loading={savingId === p.id}
                            onClick={() => save({ ...p, ...(dirty[p.id] || {}) } as PolicyRow)}
                          >
                            Save
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}
