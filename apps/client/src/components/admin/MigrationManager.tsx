import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../api';
import { MigrationRun } from '../../types';
import { tokens } from '../../tokens';
import { Button, Input, Badge, Card } from '../common';
import { useConfirm } from '../../contexts/ConfirmContext';
import { useToast } from '../../contexts/ToastContext';

const ACTIVE_STATUSES = new Set(['pending', 'preflight', 'running']);

function statusVariant(status: MigrationRun['status']): 'success' | 'danger' | 'warning' | 'info' | 'neutral' {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running' || status === 'preflight') return 'info';
  return 'neutral';
}

function runProgressLabel(run: MigrationRun): string {
  const total = run.entity_order?.length || 0;
  const done = Object.values(run.progress || {}).filter((p) => p.done).length;
  const current = run.current_entity ? ` — ${run.current_entity}` : '';
  return total ? `${done}/${total} tables${current}` : '—';
}

export default function MigrationManager() {
  const confirm = useConfirm();
  const { showToast } = useToast();
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const [quiesce, setQuiesce] = useState<{ quiesced: boolean; reason: string } | null>(null);
  const [form, setForm] = useState({ source_url: '', source_token: '', skip_attachments: true, allow_merge: false });
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    const [runsData, quiesceData] = await Promise.all([
      api.listMigrationRuns(),
      api.getInstanceQuiesce(),
    ]);
    setRuns(runsData);
    setQuiesce(quiesceData);
  }, []);

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [load]);

  const hasActiveRun = runs.some((r) => ACTIVE_STATUSES.has(r.status));

  const handleStart = async () => {
    if (!form.source_url.trim() || !form.source_token.trim()) {
      showToast('Source URL and source token are both required', 'error');
      return;
    }
    setStarting(true);
    try {
      await api.startMigrationRun({
        source_url: form.source_url.trim(),
        source_token: form.source_token.trim(),
        skip_attachments: form.skip_attachments,
        allow_merge: form.allow_merge,
      });
      showToast('Migration import started', 'success');
      setForm({ source_url: '', source_token: '', skip_attachments: true, allow_merge: false });
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to start migration run', 'error');
    } finally {
      setStarting(false);
    }
  };

  const handlePullAttachments = async (id: string) => {
    try {
      await api.pullMigrationAttachments(id);
      showToast('Attachments/embeddings pull started', 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to start attachments pull', 'error');
    }
  };

  const handleResumeFleet = async () => {
    const ok = await confirm({
      title: 'Resume fleet dispatch',
      message:
        'This will let the instance start dispatching tickets/schedules/chat autostart to the agent fleet again. ' +
        'Only do this once you have verified the imported data (and, if the source server is still live, that it has been decommissioned or is no longer sharing the same agent fleet).',
      confirmLabel: 'Resume dispatch',
    });
    if (!ok) return;
    try {
      await api.resumeFleetDispatch();
      showToast('Fleet dispatch resumed', 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to resume fleet dispatch', 'error');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {quiesce?.quiesced && (
        <Card padding={14} style={{ border: `1px solid ${tokens.colors.warningLight}`, background: `${tokens.colors.warningBg}20` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.warningLight }}>
                ⏸ Fleet dispatch is quiesced
              </div>
              <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginTop: 4 }}>
                {quiesce.reason || 'No new ticket triggers, schedules, or agent autostart will fire until an operator resumes dispatch.'}
              </div>
            </div>
            <Button variant="danger" onClick={handleResumeFleet}>Resume fleet dispatch</Button>
          </div>
        </Card>
      )}

      <Card padding={16}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 12 }}>
          Start a new import
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 520 }}>
          <Input
            label="Source URL"
            value={form.source_url}
            onChange={(e) => setForm({ ...form, source_url: e.target.value })}
            placeholder="https://source-awb.example.com"
          />
          <Input
            label="Source token"
            type="password"
            value={form.source_token}
            onChange={(e) => setForm({ ...form, source_token: e.target.value })}
            placeholder="Short-TTL API key minted on the source (scope=migration_export)"
          />
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
            <input
              type="checkbox"
              checked={form.skip_attachments}
              onChange={(e) => setForm({ ...form, skip_attachments: e.target.checked })}
            />
            Skip attachments/embeddings for now (pull them in a separate step later)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: tokens.colors.textSecondary }}>
            <input
              type="checkbox"
              checked={form.allow_merge}
              onChange={(e) => setForm({ ...form, allow_merge: e.target.checked })}
            />
            Allow importing into a non-empty destination (existing rows are kept; only missing rows are added)
          </label>
          <div>
            <Button variant="primary" onClick={handleStart} disabled={starting || hasActiveRun}>
              {starting ? 'Starting…' : 'Start import'}
            </Button>
            {hasActiveRun && (
              <span style={{ marginLeft: 10, fontSize: 12, color: tokens.colors.textMuted }}>
                Another run is already in progress.
              </span>
            )}
          </div>
        </div>
      </Card>

      <Card padding={16}>
        <div style={{ fontSize: 13, fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 12 }}>
          Runs ({runs.length})
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: tokens.colors.surface, color: tokens.colors.textMuted, fontSize: 11, textTransform: 'uppercase' }}>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Source</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Status</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Progress</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Started</th>
                <th style={{ textAlign: 'left', padding: '8px 12px' }}>Error</th>
                <th style={{ textAlign: 'right', padding: '8px 12px' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr key={run.id} style={{ borderTop: `1px solid ${tokens.colors.border}` }}>
                  <td style={{ padding: '10px 12px', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={run.source_url}>
                    {run.source_url}
                  </td>
                  <td style={{ padding: '10px 12px' }}>
                    <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
                  </td>
                  <td style={{ padding: '10px 12px', color: tokens.colors.textSecondary }}>{runProgressLabel(run)}</td>
                  <td style={{ padding: '10px 12px', color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
                    {run.started_at ? new Date(run.started_at).toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '10px 12px', color: tokens.colors.dangerLight, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={run.error_message}>
                    {run.error_message || '—'}
                  </td>
                  <td style={{ padding: '10px 12px', textAlign: 'right' }}>
                    {run.status === 'completed' && run.phase === 'core' && !!run.skip_attachments && (
                      <Button variant="secondary" size="sm" onClick={() => handlePullAttachments(run.id)}>
                        Pull attachments
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr>
                  <td colSpan={6} style={{ textAlign: 'center', padding: '32px 24px', color: tokens.colors.textMuted }}>
                    No migration runs yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
