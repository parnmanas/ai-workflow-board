import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import type { WorkspaceSchedule } from '../types';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';
import { Button, Input, Select, Modal, Card, Badge, ConfirmDialog } from './common';
import { relativeTime } from '../utils/time';
import { formatAgentDisplayName } from '../utils/agentName';

/**
 * Workspace Schedule editor (ticket 1927ed4a). Mirrors the QA Schedules editor
 * (QaManager SchedulesSection / ScheduleRow / ScheduleEditor) but for the
 * general-purpose single-agent task scheduler: one `target_agent_id` + a
 * free-text `task_prompt`, no scenario scope. Lives in Workspace Settings and
 * drives the workspace-schedules REST surface. Each row shows the target agent,
 * cadence, enabled toggle, next/last run, and a deep-link to the last dispatched
 * chat room; the run-now button fires immediately and opens its room.
 */

type ScheduleAgent = { id: string; name: string; manager_name?: string };

/** Human-readable cadence string for a schedule (cron expr or interval). */
function formatCadence(s: Pick<WorkspaceSchedule, 'cron' | 'interval_ms'>): string {
  if (s.cron) return `cron: ${s.cron} (UTC)`;
  if (s.interval_ms && s.interval_ms > 0) {
    const ms = s.interval_ms;
    if (ms % 3_600_000 === 0) return `매 ${ms / 3_600_000}시간`;
    if (ms % 60_000 === 0) return `매 ${ms / 60_000}분`;
    if (ms % 1_000 === 0) return `매 ${ms / 1_000}초`;
    return `매 ${ms}ms`;
  }
  return '—';
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 600,
  color: tokens.colors.textSecondary, textTransform: 'uppercase', letterSpacing: 0.4,
  borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceSubtle,
  whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '8px 12px', fontSize: 13, borderBottom: `1px solid ${tokens.colors.border}`,
  verticalAlign: 'middle',
};

interface WorkspaceSchedulesEditorProps {
  workspaceId: string;
}

export default function WorkspaceSchedulesEditor({ workspaceId }: WorkspaceSchedulesEditorProps) {
  const { showToast } = useToast();
  const [schedules, setSchedules] = useState<WorkspaceSchedule[]>([]);
  const [agents, setAgents] = useState<ScheduleAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<WorkspaceSchedule | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<WorkspaceSchedule | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) { setSchedules([]); setLoading(false); return; }
    setLoading(true);
    try {
      const [scheduleList, agentList] = await Promise.all([
        api.listWorkspaceSchedules(workspaceId).catch(() => []),
        api.getAgents().catch(() => []),
      ]);
      setSchedules(scheduleList || []);
      setAgents((agentList || []).map((a: any) => ({ id: a.id, name: a.name, manager_name: a.manager_name })));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load workspace schedules', 'error');
    } finally {
      setLoading(false);
    }
  }, [workspaceId, showToast]);

  useEffect(() => { load(); }, [load]);

  // manager_name 을 포함한 full name(Manager/Agent)으로 표시. 목록에 없는
  // agent(삭제됨 등)는 id 앞 8자리 fallback.
  const agentName = useCallback((id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? formatAgentDisplayName(a) : id.slice(0, 8);
  }, [agents]);

  const handleToggle = async (s: WorkspaceSchedule) => {
    try {
      await api.updateWorkspaceSchedule(s.id, { workspace_id: workspaceId, enabled: !s.enabled });
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to toggle schedule', 'error');
    }
  };

  const handleRunNow = async (s: WorkspaceSchedule) => {
    try {
      const { dispatch } = await api.runWorkspaceScheduleNow(s.id, workspaceId);
      showToast(`실행됨 — 방 ${dispatch.room_id.slice(0, 8)} 열림`, 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to run schedule', 'error');
    }
  };

  const handleDelete = async (s: WorkspaceSchedule) => {
    try {
      await api.deleteWorkspaceSchedule(s.id, workspaceId);
      setConfirmDelete(null);
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete schedule', 'error');
    }
  };

  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700, color: tokens.colors.textStrong, marginBottom: 4 }}>
            Workspace Schedules — 예약된 에이전트 작업
          </div>
          <div style={{ color: tokens.colors.textSecondary, fontSize: 12, maxWidth: 720 }}>
            예약된 시각이 되면 지정 에이전트에게 새 채팅 방을 열고 작업 프롬프트를 보냅니다 (cron 또는 주기).
            QA/보안 스케줄러와 동일한 dispatch 경로를 재사용합니다 — 매 실행마다 새 방이 열립니다.
          </div>
        </div>
        <Button variant="primary" size="md" onClick={() => setEditing('new')}>+ 새 스케줄</Button>
      </div>

      {loading ? (
        <Card padding="16px">
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading…</div>
        </Card>
      ) : schedules.length === 0 ? (
        <Card padding="16px">
          <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
            스케줄이 없습니다. "+ 새 스케줄" 로 cron/주기 기반 자동 작업을 추가하세요.
          </div>
        </Card>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820 }}>
            <thead>
              <tr>
                <th style={TH}>Name</th>
                <th style={TH}>Agent</th>
                <th style={TH}>Cadence</th>
                <th style={TH}>Enabled</th>
                <th style={TH}>Next run (UTC)</th>
                <th style={TH}>Last run</th>
                <th style={{ ...TH, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <ScheduleRow
                  key={s.id}
                  s={s}
                  workspaceId={workspaceId}
                  agentLabel={agentName(s.target_agent_id)}
                  onEdit={() => setEditing(s)}
                  onToggle={() => handleToggle(s)}
                  onRunNow={() => handleRunNow(s)}
                  onDelete={() => setConfirmDelete(s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <ScheduleEditor
          schedule={editing === 'new' ? null : editing}
          workspaceId={workspaceId}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}

      {confirmDelete && (
        <ConfirmDialog
          isOpen={true}
          title="스케줄 삭제"
          message={`스케줄 "${confirmDelete.name}" 을 삭제할까요? 이미 열린 방/진행 중 작업은 영향받지 않습니다.`}
          confirmLabel="삭제"
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function ScheduleRow({ s, workspaceId, agentLabel, onEdit, onToggle, onRunNow, onDelete }: {
  s: WorkspaceSchedule;
  workspaceId: string;
  agentLabel: string;
  onEdit: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  // next_run_at as a compact UTC wall-clock (cron is interpreted in UTC).
  const nextUtc = s.next_run_at ? new Date(s.next_run_at).toISOString().replace('T', ' ').slice(0, 16) : '—';
  return (
    <tr
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ background: hover ? tokens.colors.surfaceHover : 'transparent' }}
    >
      <td style={TD}>
        <span style={{ fontWeight: 600, color: tokens.colors.textPrimary }}>{s.name}</span>
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>{agentLabel}</td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, fontFamily: 'monospace', fontSize: 12 }}>{formatCadence(s)}</td>
      <td style={TD}>
        <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', cursor: 'pointer' }}>
          <input type="checkbox" checked={s.enabled} onChange={onToggle} title="enable/disable" />
          {!s.enabled && <Badge variant="warning" size="sm">disabled</Badge>}
        </label>
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {s.enabled ? nextUtc : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
        {s.last_run_at ? (
          s.last_room_id ? (
            <Link
              to={`/ws/${workspaceId}/chat?room=${s.last_room_id}`}
              title="마지막으로 열린 방으로 이동"
              style={{ color: tokens.colors.accent, textDecoration: 'none' }}
            >
              {relativeTime(s.last_run_at)} ↗
            </Link>
          ) : (
            relativeTime(s.last_run_at)
          )
        ) : (
          <span style={{ color: tokens.colors.textMuted }}>never</span>
        )}
      </td>
      <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', gap: 6 }}>
          <Button variant="primary" size="sm" onClick={onRunNow} title="지금 즉시 실행 (enabled 무시, next_run_at 안 건드림)">▶ Run now</Button>
          <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
          <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
        </div>
      </td>
    </tr>
  );
}

interface ScheduleEditorProps {
  schedule: WorkspaceSchedule | null;
  workspaceId: string;
  agents: ScheduleAgent[];
  onClose: () => void;
  onSaved: () => void;
}

function ScheduleEditor({ schedule, workspaceId, agents, onClose, onSaved }: ScheduleEditorProps) {
  const { showToast } = useToast();
  const [name, setName] = useState(schedule?.name ?? '');
  const [targetAgentId, setTargetAgentId] = useState(schedule?.target_agent_id ?? '');
  const [taskPrompt, setTaskPrompt] = useState(schedule?.task_prompt ?? '');
  // Cadence: edit either as an interval (value + unit) or a cron expr.
  const [cadenceKind, setCadenceKind] = useState<'interval' | 'cron'>(schedule?.cron ? 'cron' : 'interval');
  const [cron, setCron] = useState(schedule?.cron ?? '0 3 * * *');
  const initInterval = (() => {
    const ms = schedule?.interval_ms ?? 3_600_000;
    if (ms % 3_600_000 === 0) return { value: String(ms / 3_600_000), unit: 'hours' as const };
    if (ms % 60_000 === 0) return { value: String(ms / 60_000), unit: 'minutes' as const };
    return { value: String(Math.max(1, Math.round(ms / 1_000))), unit: 'seconds' as const };
  })();
  const [intervalValue, setIntervalValue] = useState(initInterval.value);
  const [intervalUnit, setIntervalUnit] = useState<'seconds' | 'minutes' | 'hours'>(initInterval.unit);
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [saving, setSaving] = useState(false);

  const intervalMs = (() => {
    const n = parseInt(intervalValue, 10);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    const factor = intervalUnit === 'hours' ? 3_600_000 : intervalUnit === 'minutes' ? 60_000 : 1_000;
    return n * factor;
  })();

  const handleSave = async () => {
    if (!name.trim()) { showToast('이름을 입력하세요', 'error'); return; }
    if (!targetAgentId) { showToast('대상 에이전트를 선택하세요', 'error'); return; }
    if (!taskPrompt.trim()) { showToast('작업 프롬프트를 입력하세요', 'error'); return; }
    if (cadenceKind === 'cron') {
      if (cron.trim().split(/\s+/).length !== 5) { showToast('cron 은 5개 필드여야 합니다 (예: "0 3 * * *")', 'error'); return; }
    } else if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      showToast('주기는 1초 이상이어야 합니다', 'error'); return;
    }

    const base = {
      workspace_id: workspaceId,
      name: name.trim(),
      target_agent_id: targetAgentId,
      task_prompt: taskPrompt.trim(),
      enabled,
      // Send exactly one cadence; null the other so a kind-switch clears it.
      cron: cadenceKind === 'cron' ? cron.trim() : null,
      interval_ms: cadenceKind === 'interval' ? intervalMs : null,
    };

    setSaving(true);
    try {
      if (schedule) {
        await api.updateWorkspaceSchedule(schedule.id, base);
      } else {
        // Workspace-scoped schedule (board_id null); board pinning is reserved for
        // the MCP surface / future board-level editors.
        await api.createWorkspaceSchedule({ ...base, board_id: null });
      }
      showToast(`스케줄 ${schedule ? '수정' : '생성'}됨`, 'success');
      onSaved();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save schedule', 'error');
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block' };
  const textareaStyle: React.CSSProperties = {
    width: '100%', minHeight: 120, fontFamily: 'inherit', fontSize: 13, padding: 8, boxSizing: 'border-box',
    background: tokens.colors.surface, color: tokens.colors.textPrimary,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, resize: 'vertical',
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={schedule ? 'Workspace 스케줄 수정' : '새 Workspace 스케줄'}
      maxWidth={620}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <Input label="이름" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />

        <Select
          label="대상 에이전트"
          placeholder="— 에이전트 선택 —"
          value={targetAgentId}
          options={agents.map((a) => ({ value: a.id, label: formatAgentDisplayName(a) }))}
          onChange={(e) => setTargetAgentId((e.target as HTMLSelectElement).value)}
        />

        <div>
          <label style={fieldLabel}>작업 프롬프트 (실행 시 에이전트에게 보낼 메시지)</label>
          <textarea
            style={textareaStyle}
            value={taskPrompt}
            placeholder="예: 어제자 빌드 로그를 점검하고 실패 항목을 요약해 주세요."
            onChange={(e) => setTaskPrompt(e.target.value)}
          />
        </div>

        {/* Cadence: interval vs cron */}
        <div>
          <label style={fieldLabel}>실행 주기</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="ws-sched-cadence" checked={cadenceKind === 'interval'} onChange={() => setCadenceKind('interval')} />
              주기 (interval)
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="ws-sched-cadence" checked={cadenceKind === 'cron'} onChange={() => setCadenceKind('cron')} />
              cron
            </label>
          </div>
          {cadenceKind === 'interval' ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
              <div style={{ width: 120 }}>
                <Input label="값" type="number" value={intervalValue} onChange={(e) => setIntervalValue((e.target as HTMLInputElement).value)} />
              </div>
              <div style={{ flex: 1 }}>
                <Select
                  label="단위"
                  value={intervalUnit}
                  options={[
                    { value: 'seconds', label: '초' },
                    { value: 'minutes', label: '분' },
                    { value: 'hours', label: '시간' },
                  ]}
                  onChange={(e) => setIntervalUnit((e.target as HTMLSelectElement).value as 'seconds' | 'minutes' | 'hours')}
                />
              </div>
            </div>
          ) : (
            <Input label='cron (5필드, UTC — 예: "0 3 * * *" = 매일 03:00 UTC)' value={cron} onChange={(e) => setCron((e.target as HTMLInputElement).value)} />
          )}
        </div>

        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <div style={{ fontSize: 12, color: tokens.colors.textMuted, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
          ⚠️ 자동 실행은 <b>돌고 있는 서버</b>에서 발생합니다. main→prod auto-deploy 지연이 있으면 주기를 배포 지연보다 넉넉히 잡으세요. cron 은 모두 <b>UTC</b> 기준이며, 매 실행마다 <b>새 채팅 방</b>이 열립니다.
        </div>
      </div>
    </Modal>
  );
}
