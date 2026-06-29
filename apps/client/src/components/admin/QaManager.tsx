import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId, rawResourceUrl } from '../../api';
import type { QaScenario, QaScenarioListItem, QaRun, QaStepResult, QaOnFailureTicketConfig, QaRunBatch, QaSchedule, QaScheduleScope, QaPhase, QaPhasesConfig, Deployment } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Select, Modal, Card, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { QaPhaseRowsEditor, parseQaPhasesValue, qaPhasesError, formatDuration } from '../QaPhasesEditor';
import { formatAgentDisplayName } from '../../utils/agentName';
import {
  WorkspaceFolderOptions,
  initWorkspaceFolderState,
  buildWorkspaceFolderPayload,
  type WorkspaceFolderFormState,
} from './WorkspaceFolderOptions';

// QaManager 내부에서 다루는 agent 표시용 최소 형태. 서버 GET /api/agents 가
// _enrichManagerNames 로 채워주는 manager_name 을 보존해 full name 렌더에 사용한다.
type QaAgent = { id: string; name: string; manager_name?: string };

interface QaManagerProps {
  workspaceId?: string;
  boardId?: string;
}

const RUN_STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral'> = {
  passed: 'success',
  failed: 'danger',
  error: 'danger',
  running: 'info',
  pending: 'neutral',
  skipped: 'neutral',
};

function statusVariant(s: string) {
  return RUN_STATUS_VARIANT[s] ?? 'neutral';
}

/**
 * Board QA panel — isomorphic to the Actions panel (ActionManager). Lists QA
 * scenarios, runs them, and visualizes each scenario as an ordered step flow
 * with per-step pass/fail badges + screenshot thumbnails, plus run history.
 */
export default function QaManager({ workspaceId, boardId }: QaManagerProps) {
  const { showToast } = useToast();
  const effectiveWorkspaceId = workspaceId || (getActiveWorkspaceId() || '');

  const [scenarios, setScenarios] = useState<QaScenarioListItem[]>([]);
  const [agents, setAgents] = useState<QaAgent[]>([]);
  const [selected, setSelected] = useState<QaScenario | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<QaScenario | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<QaScenario | null>(null);
  // Sequential-batch state: which scenarios are checked for "선택 순차 실행",
  // the active batch being polled, and a starting guard.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [activeBatch, setActiveBatch] = useState<QaRunBatch | null>(null);
  const [batchStarting, setBatchStarting] = useState(false);
  // Schedule (자동 트리거 레이어 — ticket b6bb7efd) state.
  const [schedules, setSchedules] = useState<QaSchedule[]>([]);
  const [editingSchedule, setEditingSchedule] = useState<QaSchedule | 'new' | null>(null);
  const [confirmDeleteSchedule, setConfirmDeleteSchedule] = useState<QaSchedule | null>(null);
  // Deployment-awareness live-commit badges (ticket 8ce72b18): current live commit
  // per environment this workspace sees (its own + global). Best-effort read.
  const [deployments, setDeployments] = useState<Deployment[]>([]);

  const load = useCallback(async () => {
    if (!effectiveWorkspaceId) { setScenarios([]); setSchedules([]); setDeployments([]); return; }
    try {
      const [list, agentList, scheduleList, deploymentList] = await Promise.all([
        api.listQaScenarios(effectiveWorkspaceId, boardId !== undefined ? (boardId || '') : undefined),
        api.getAgents().catch(() => []),
        api.listQaSchedules(effectiveWorkspaceId, boardId !== undefined ? (boardId || '') : undefined).catch(() => []),
        api.listDeployments(effectiveWorkspaceId).catch(() => []),
      ]);
      setScenarios(list);
      setAgents((agentList || []).map((a: any) => ({ id: a.id, name: a.name, manager_name: a.manager_name })));
      setSchedules(scheduleList || []);
      setDeployments(deploymentList || []);
    } catch (err: any) {
      showToast(err?.message || 'Failed to load QA scenarios', 'error');
    }
  }, [effectiveWorkspaceId, boardId, showToast]);

  useEffect(() => { load(); }, [load]);

  // Live refresh: while any scenario has an in-flight run, re-poll the list so
  // the Last-run / Result / Pass columns update without a manual refresh. QA
  // has no SSE channel, so the list view polls; it idles when nothing is running.
  const anyScenarioRunning = scenarios.some((s) => s.last_run_status === 'running');
  useEffect(() => {
    if (!anyScenarioRunning) return;
    const t = setInterval(() => { load(); }, 3000);
    return () => clearInterval(t);
  }, [anyScenarioRunning, load]);

  // manager_name 을 포함한 full name(Manager/Agent)으로 표시. 목록에 없는
  // agent(삭제됨 등)는 id 앞 8자리 fallback 으로 둔다.
  const agentName = useCallback((id: string) => {
    const a = agents.find((x) => x.id === id);
    return a ? formatAgentDisplayName(a) : id.slice(0, 8);
  }, [agents]);

  const handleRun = async (s: QaScenario) => {
    setRunning(s.id);
    try {
      const result = await api.runQaScenario(s.id);
      showToast(`QA run started (room ${result.room_id.slice(0, 8)})`, 'success');
      // Keep the selected scenario in sync so the detail view can refresh runs.
      setSelected(s);
    } catch (err: any) {
      showToast(err?.message || 'Failed to start QA run', 'error');
    } finally {
      setRunning(null);
    }
  };

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  // Scenarios in display order whose id is checked — preserves the table order
  // so the sequential batch runs top-to-bottom.
  const orderedSelected = scenarios.filter((s) => selectedIds.has(s.id));

  const startBatch = useCallback(async (payload: { all?: boolean; scenario_ids?: string[] }) => {
    setBatchStarting(true);
    try {
      const batch = await api.startQaBatch({
        workspace_id: effectiveWorkspaceId,
        board_id: boardId !== undefined ? (boardId || '') : undefined,
        ...payload,
      });
      setActiveBatch(batch);
      showToast(`QA batch started — ${batch.total} scenario(s) in sequence`, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Failed to start QA batch', 'error');
    } finally {
      setBatchStarting(false);
    }
  }, [effectiveWorkspaceId, boardId, showToast]);

  // Poll the active batch while it's running so the progress banner advances as
  // each scenario finalizes (dispatch is server-driven, one run at a time).
  useEffect(() => {
    if (!activeBatch || activeBatch.status !== 'running') return;
    let cancelled = false;
    const tick = async () => {
      try {
        const fresh = await api.getQaBatch(activeBatch.id, effectiveWorkspaceId);
        if (cancelled) return;
        setActiveBatch(fresh);
        if (fresh.status !== 'running') load(); // refresh last-run rollups when done
      } catch { /* transient — keep polling */ }
    };
    const h = setInterval(tick, 4000);
    return () => { cancelled = true; clearInterval(h); };
  }, [activeBatch, effectiveWorkspaceId, load]);

  const handleDelete = async (s: QaScenario) => {
    try {
      await api.deleteQaScenario(s.id, effectiveWorkspaceId);
      showToast('QA scenario deleted', 'success');
      setConfirmDelete(null);
      if (selected?.id === s.id) setSelected(null);
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete scenario', 'error');
    }
  };

  const handleScheduleRunNow = async (s: QaSchedule) => {
    try {
      const { batch } = await api.runQaScheduleNow(s.id, effectiveWorkspaceId);
      setActiveBatch(batch);
      showToast(`스케줄 "${s.name}" 즉시 실행 — ${batch.total} 시나리오`, 'success');
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to run schedule', 'error');
    }
  };

  const handleScheduleToggle = async (s: QaSchedule) => {
    try {
      await api.updateQaSchedule(s.id, { workspace_id: effectiveWorkspaceId, enabled: !s.enabled });
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to toggle schedule', 'error');
    }
  };

  const handleScheduleDelete = async (s: QaSchedule) => {
    try {
      await api.deleteQaSchedule(s.id, effectiveWorkspaceId);
      showToast('스케줄 삭제됨', 'success');
      setConfirmDeleteSchedule(null);
      await load();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete schedule', 'error');
    }
  };

  if (!effectiveWorkspaceId) {
    return <div style={{ color: tokens.colors.textSecondary }}>No workspace selected.</div>;
  }

  // Editor + delete-confirm modals are rendered once at the end so they are
  // reachable from BOTH the list view and the scenario detail view.
  const modals = (
    <>
      {editing && (
        <ScenarioEditor
          scenario={editing === 'new' ? null : editing}
          workspaceId={effectiveWorkspaceId}
          boardId={boardId}
          agents={agents}
          onClose={() => setEditing(null)}
          onSaved={async (saved) => {
            setEditing(null);
            await load();
            setSelected((cur) => (cur && cur.id === saved.id ? saved : cur));
          }}
        />
      )}
      {confirmDelete && (
        <ConfirmDialog
          isOpen={true}
          title="Delete QA scenario"
          message={`Delete "${confirmDelete.name}" and all its runs? This cannot be undone.`}
          confirmLabel="Delete"
          onConfirm={() => handleDelete(confirmDelete)}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
      {editingSchedule && (
        <ScheduleEditor
          schedule={editingSchedule === 'new' ? null : editingSchedule}
          workspaceId={effectiveWorkspaceId}
          boardId={boardId}
          scenarios={scenarios}
          onClose={() => setEditingSchedule(null)}
          onSaved={async () => { setEditingSchedule(null); await load(); }}
        />
      )}
      {confirmDeleteSchedule && (
        <ConfirmDialog
          isOpen={true}
          title="스케줄 삭제"
          message={`스케줄 "${confirmDeleteSchedule.name}" 을 삭제할까요? 이미 시작된 batch 는 영향받지 않습니다.`}
          confirmLabel="Delete"
          onConfirm={() => handleScheduleDelete(confirmDeleteSchedule)}
          onCancel={() => setConfirmDeleteSchedule(null)}
        />
      )}
    </>
  );

  if (selected) {
    return (
      <>
        <ScenarioDetail
          scenario={selected}
          workspaceId={effectiveWorkspaceId}
          agentName={agentName}
          onBack={() => { setSelected(null); load(); }}
          onRun={() => handleRun(selected)}
          running={running === selected.id}
          onEdit={() => setEditing(selected)}
        />
        {modals}
      </>
    );
  }

  const batchRunning = activeBatch?.status === 'running';

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md, gap: 12, flexWrap: 'wrap' }}>
        <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
          Scenario-based QA — run a scenario, accumulate step pass/fail + screenshots, re-run to compare.
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {/* 순차 batch 실행: 한 번에 하나씩, 끝나야 다음. */}
          <Button
            variant="secondary"
            size="md"
            disabled={scenarios.length === 0 || batchStarting || batchRunning}
            onClick={() => startBatch({ all: true })}
            title="현재 scope 의 enabled 시나리오를 이름순으로 순차 실행"
          >
            ▶ 전체 순차 실행
          </Button>
          <Button
            variant="secondary"
            size="md"
            disabled={orderedSelected.length === 0 || batchStarting || batchRunning}
            onClick={() => startBatch({ scenario_ids: orderedSelected.map((s) => s.id) })}
            title="체크한 시나리오를 위→아래 순서대로 순차 실행"
          >
            ▶ 선택 순차 실행{orderedSelected.length ? ` (${orderedSelected.length})` : ''}
          </Button>
          <Button variant="primary" size="md" onClick={() => setEditing('new')}>+ New Scenario</Button>
        </div>
      </div>

      {/* 환경별 live commit 배지 (배포 인지 — ticket 8ce72b18) */}
      <DeploymentBadges deployments={deployments} />

      {activeBatch && (
        <BatchProgressBanner
          batch={activeBatch}
          scenarioName={(id) => scenarios.find((s) => s.id === id)?.name ?? id.slice(0, 8)}
          onDismiss={() => setActiveBatch(null)}
        />
      )}

      {scenarios.length === 0 ? (
        <Card padding="20px">
          <div style={{ color: tokens.colors.textSecondary }}>
            No QA scenarios yet. Create one and point it at a QA driver (browser / game-client / http-api).
            See <code>docs/qa-driver-guide.md</code>.
          </div>
        </Card>
      ) : (
        <ScenarioTable
          scenarios={scenarios}
          agentName={agentName}
          running={running}
          selectedIds={selectedIds}
          onToggleSelect={toggleSelect}
          onOpen={(s) => setSelected(s)}
          onRun={handleRun}
          onEdit={(s) => setEditing(s)}
          onDelete={(s) => setConfirmDelete(s)}
        />
      )}

      <SchedulesSection
        schedules={schedules}
        scenarios={scenarios}
        disabled={scenarios.length === 0}
        onNew={() => setEditingSchedule('new')}
        onEdit={(s) => setEditingSchedule(s)}
        onToggle={handleScheduleToggle}
        onRunNow={handleScheduleRunNow}
        onDelete={(s) => setConfirmDeleteSchedule(s)}
      />

      {modals}
    </div>
  );
}

// ── Sequential batch progress banner ─────────────────────────────────────────

const BATCH_STATUS_VARIANT: Record<string, 'success' | 'danger' | 'info'> = {
  running: 'info',
  done: 'success',
  aborted: 'danger',
};

function BatchProgressBanner({ batch, scenarioName, onDismiss }: {
  batch: QaRunBatch;
  scenarioName: (id: string) => string;
  onDismiss: () => void;
}) {
  const done = batch.status !== 'running';
  // While running, current_index points at the in-flight scenario; once done it
  // points at the last one touched, so the "N / total" reads as completed count.
  const position = done ? batch.total : Math.min(batch.current_index + 1, batch.total);
  const currentId = batch.scenario_ids[batch.current_index];
  return (
    <Card padding="14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Badge variant={BATCH_STATUS_VARIANT[batch.status] ?? 'neutral'} size="md">batch {batch.status}</Badge>
        <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary, fontVariantNumeric: 'tabular-nums' }}>
          {position} / {batch.total}
        </span>
        {!done && currentId && (
          <span style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
            현재: <strong style={{ color: tokens.colors.textPrimary }}>{scenarioName(currentId)}</strong>
          </span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <Badge variant="success" size="sm">pass {batch.passed}</Badge>
          <Badge variant="danger" size="sm">fail {batch.failed}</Badge>
          {batch.errored > 0 && <Badge variant="warning" size="sm">err {batch.errored}</Badge>}
        </span>
        {done && (
          <button
            onClick={onDismiss}
            style={{ background: 'none', border: 'none', color: tokens.colors.textMuted, cursor: 'pointer', fontSize: 13, padding: '2px 6px' }}
            title="배너 닫기"
          >
            ✕
          </button>
        )}
      </div>
      {/* progress bar */}
      <div style={{ height: 6, borderRadius: 3, background: tokens.colors.surfaceHover, overflow: 'hidden' }}>
        <div style={{
          width: `${batch.total ? Math.round((position / batch.total) * 100) : 0}%`,
          height: '100%',
          background: batch.status === 'aborted' ? tokens.colors.danger : tokens.colors.success,
          transition: 'width 0.4s ease',
        }} />
      </div>
      {!done && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
          한 시나리오가 끝나야(passed/failed/error) 다음이 시작됩니다 — 동시에 뜨지 않습니다.
        </div>
      )}
    </Card>
  );
}

// ── QA schedules (자동 트리거 레이어 — ticket b6bb7efd) ───────────────────────

/** Human-readable cadence string for a schedule (cron expr or interval). */
function formatCadence(s: Pick<QaSchedule, 'cron' | 'interval_ms'>): string {
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

interface SchedulesSectionProps {
  schedules: QaSchedule[];
  scenarios: QaScenarioListItem[];
  disabled: boolean;
  onNew: () => void;
  onEdit: (s: QaSchedule) => void;
  onToggle: (s: QaSchedule) => void;
  onRunNow: (s: QaSchedule) => void;
  onDelete: (s: QaSchedule) => void;
}

/**
 * Schedule list — visually unified with the scenario table above. Each row shows
 * scope (전체/선택 N), cadence, enabled toggle, next/last run, and the last
 * batch result, plus run-now / edit / delete. Scheduling reuses the sequential
 * batch orchestrator, so a fired schedule surfaces in the same progress banner.
 */
function SchedulesSection({ schedules, scenarios, disabled, onNew, onEdit, onToggle, onRunNow, onDelete }: SchedulesSectionProps) {
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md, gap: 12, flexWrap: 'wrap' }}>
        <div>
          <SectionLabel>스케줄 — 자동 순차 실행</SectionLabel>
          <div style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            예약된 시각이 되면 순차 batch 를 자동으로 시작합니다 (전체 또는 선택 시나리오). 순차-batch 와 같은 오케스트레이터를 재사용 — 진행 상황은 위 배너에 표시됩니다.
          </div>
        </div>
        <Button variant="primary" size="md" disabled={disabled} onClick={onNew} title={disabled ? '먼저 시나리오를 만드세요' : undefined}>
          + 새 스케줄
        </Button>
      </div>

      {schedules.length === 0 ? (
        <Card padding="16px">
          <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
            스케줄이 없습니다. "+ 새 스케줄" 로 cron/주기 기반 자동 실행을 추가하세요.
          </div>
        </Card>
      ) : (
        <div style={{ overflowX: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
            <thead>
              <tr>
                <th style={TH}>Name</th>
                <th style={TH}>Scope</th>
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
                  scenarioCount={scenarios.length}
                  onEdit={() => onEdit(s)}
                  onToggle={() => onToggle(s)}
                  onRunNow={() => onRunNow(s)}
                  onDelete={() => onDelete(s)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({ s, scenarioCount, onEdit, onToggle, onRunNow, onDelete }: {
  s: QaSchedule;
  scenarioCount: number;
  onEdit: () => void;
  onToggle: () => void;
  onRunNow: () => void;
  onDelete: () => void;
}) {
  const [hover, setHover] = useState(false);
  const scopeLabel = s.scope === 'all' ? `전체 (${scenarioCount})` : `선택 ${s.scenario_ids.length}`;
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
      <td style={TD}>
        <Badge variant={s.scope === 'all' ? 'info' : 'neutral'} size="sm">{scopeLabel}</Badge>
      </td>
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
        {s.last_run_at ? relativeTime(s.last_run_at) : <span style={{ color: tokens.colors.textMuted }}>never</span>}
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

// ── Scenario list table (status-dashboard view) ──────────────────────────────

interface ScenarioTableProps {
  scenarios: QaScenarioListItem[];
  agentName: (id: string) => string;
  running: string | null;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onOpen: (s: QaScenarioListItem) => void;
  onRun: (s: QaScenarioListItem) => void;
  onEdit: (s: QaScenarioListItem) => void;
  onDelete: (s: QaScenarioListItem) => void;
}

const TH: React.CSSProperties = {
  textAlign: 'left', padding: '8px 12px', fontSize: 11, fontWeight: 700,
  textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted,
  borderBottom: `1px solid ${tokens.colors.border}`, whiteSpace: 'nowrap',
};
const TD: React.CSSProperties = {
  padding: '10px 12px', fontSize: 13, color: tokens.colors.textPrimary,
  borderBottom: `1px solid ${tokens.colors.border}`, verticalAlign: 'middle',
};

/**
 * QA scenarios rendered as a CI/test-runner-style status table — one row per
 * scenario, last-run time + result scannable down a column. Replaces the old
 * card grid (prompt/description bodies live in the detail view, not here).
 */
function ScenarioTable({ scenarios, agentName, running, selectedIds, onToggleSelect, onOpen, onRun, onEdit, onDelete }: ScenarioTableProps) {
  // Header checkbox = select/clear all currently listed scenarios.
  const allSelected = scenarios.length > 0 && scenarios.every((s) => selectedIds.has(s.id));
  const toggleAll = () => {
    const target = !allSelected;
    scenarios.forEach((s) => {
      if (selectedIds.has(s.id) !== target) onToggleSelect(s.id);
    });
  };
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
        <thead>
          <tr>
            <th style={{ ...TH, width: 36, textAlign: 'center' }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} title="전체 선택/해제" />
            </th>
            <th style={TH}>Name</th>
            <th style={TH}>Driver</th>
            <th style={TH}>Agent</th>
            <th style={TH}>Last run</th>
            <th style={TH}>Result</th>
            <th style={{ ...TH, textAlign: 'right' }}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {scenarios.map((s) => (
            <ScenarioRow
              key={s.id}
              s={s}
              agentName={agentName}
              running={running === s.id}
              selected={selectedIds.has(s.id)}
              onToggleSelect={() => onToggleSelect(s.id)}
              onOpen={() => onOpen(s)}
              onRun={() => onRun(s)}
              onEdit={() => onEdit(s)}
              onDelete={() => onDelete(s)}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ScenarioRowProps {
  s: QaScenarioListItem;
  agentName: (id: string) => string;
  running: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onOpen: () => void;
  onRun: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function ScenarioRow({ s, agentName, running, selected, onToggleSelect, onOpen, onRun, onEdit, onDelete }: ScenarioRowProps) {
  const [hover, setHover] = useState(false);
  // Buttons must not bubble to the row's open handler.
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };

  return (
    <tr
      onClick={onOpen}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{ cursor: 'pointer', background: hover ? tokens.colors.surfaceHover : 'transparent' }}
    >
      <td style={{ ...TD, textAlign: 'center' }} onClick={(e) => e.stopPropagation()}>
        <input type="checkbox" checked={selected} onChange={onToggleSelect} title="순차 실행에 포함" />
      </td>
      <td style={TD}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 600, color: tokens.colors.textPrimary }}>{s.name}</span>
          {!s.enabled && <Badge variant="warning" size="sm">disabled</Badge>}
        </div>
      </td>
      <td style={TD}>
        {s.qa_driver ? <Badge variant="info" size="sm">{s.qa_driver}</Badge> : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>{agentName(s.target_agent_id)}</td>
      <td style={{ ...TD, color: tokens.colors.textSecondary, whiteSpace: 'nowrap' }}>
        {s.last_run_at ? relativeTime(s.last_run_at) : <span style={{ color: tokens.colors.textMuted }}>never run</span>}
      </td>
      <td style={TD}>
        {s.last_run_status
          ? <Badge variant={statusVariant(s.last_run_status)} size="sm">{s.last_run_status}</Badge>
          : <span style={{ color: tokens.colors.textMuted }}>—</span>}
      </td>
      <td style={{ ...TD, textAlign: 'right', whiteSpace: 'nowrap' }}>
        <div style={{ display: 'inline-flex', gap: 6 }} onClick={(e) => e.stopPropagation()}>
          <Button variant="primary" size="sm" onClick={stop(onRun)} disabled={running}>
            {running ? 'Starting…' : '▶ Run'}
          </Button>
          <Button variant="ghost" size="sm" onClick={stop(onEdit)}>Edit</Button>
          <Button variant="danger" size="sm" onClick={stop(onDelete)}>Delete</Button>
        </div>
      </td>
    </tr>
  );
}

// ── Scenario detail: step visualizer + run history + run detail ──────────────

interface ScenarioDetailProps {
  scenario: QaScenario;
  workspaceId: string;
  agentName: (id: string) => string;
  onBack: () => void;
  onRun: () => void;
  running: boolean;
  onEdit: () => void;
}

function ScenarioDetail({ scenario, workspaceId, agentName, onBack, onRun, running, onEdit }: ScenarioDetailProps) {
  const { showToast } = useToast();
  const [runs, setRuns] = useState<QaRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<{ src: string; kind: 'image' | 'video' } | null>(null);

  // Resolve the effective phase config for the run timeline: scenario override
  // wins over the board default (mirrors the server resolveQaPhases precedence).
  // The board default is fetched lazily; the timeline degrades gracefully (no
  // progress bar) when a phase has no matching timeout in the resolved config.
  const scenarioPhases = parseQaPhasesValue(scenario.qa_phases);
  const [boardPhases, setBoardPhases] = useState<QaPhasesConfig | null>(null);
  useEffect(() => {
    if (scenarioPhases || !scenario.board_id) { setBoardPhases(null); return; }
    let cancelled = false;
    api.getBoard(scenario.board_id)
      .then((b) => { if (!cancelled) setBoardPhases(parseQaPhasesValue((b as any)?.qa_phases)); })
      .catch(() => { if (!cancelled) setBoardPhases(null); });
    return () => { cancelled = true; };
  }, [scenario.board_id, !!scenarioPhases]);
  const resolvedPhases = scenarioPhases ?? boardPhases;

  const loadRuns = useCallback(async () => {
    try {
      const list = await api.listQaRuns(scenario.id, workspaceId, 30);
      setRuns(list);
      setActiveRunId((cur) => cur ?? (list[0]?.id ?? null));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load runs', 'error');
    }
  }, [scenario.id, workspaceId, showToast]);

  useEffect(() => { loadRuns(); }, [loadRuns]);

  // Live refresh: poll while a run is still in flight so step badges,
  // screenshots and run status fill in without leaving/re-entering the view.
  // `running` (the Run button just clicked) covers the brief window before the
  // freshly-started run shows up in the list; once it lands as `running`/`pending`
  // the run-status check keeps polling. Idles the moment everything is terminal.
  const anyRunActive = running || runs.some((r) => r.status === 'running' || r.status === 'pending');
  useEffect(() => {
    if (!anyRunActive) return;
    const t = setInterval(() => { loadRuns(); }, 2500);
    return () => clearInterval(t);
  }, [anyRunActive, loadRuns]);

  const activeRun = runs.find((r) => r.id === activeRunId) || null;
  // Latest run drives the per-step badges in the visualizer.
  const latestRun = runs[0] || null;
  const stepResultFor = (run: QaRun | null, idx: number): QaStepResult | undefined =>
    run?.step_results?.find((sr) => sr.idx === idx);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.textPrimary }}>{scenario.name}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {scenario.qa_driver && <Badge variant="info" size="sm">{scenario.qa_driver}</Badge>}
            <Badge variant="neutral" size="sm">agent: {agentName(scenario.target_agent_id)}</Badge>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={onEdit}>Edit</Button>
        <Button variant="primary" size="md" onClick={() => { onRun(); setTimeout(loadRuns, 800); }} disabled={running}>
          {running ? 'Starting…' : '▶ Run / Re-run'}
        </Button>
      </div>

      {/* Step visualizer */}
      <div style={{ marginBottom: 24 }}>
        <SectionLabel>Scenario steps {latestRun ? '(badges = latest run)' : ''}</SectionLabel>
        <div style={{ display: 'flex', gap: 12, overflowX: 'auto', paddingBottom: 8 }}>
          {(scenario.steps ?? []).length === 0 && (
            <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>No steps defined. Edit the scenario to add steps.</div>
          )}
          {(scenario.steps ?? []).map((step) => {
            const sr = stepResultFor(latestRun, step.idx);
            const thumbId = sr?.artifact_resource_ids?.[0];
            return (
              <div key={step.idx} style={{
                minWidth: 220, maxWidth: 260, flexShrink: 0,
                border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
                background: tokens.colors.surfaceCard, padding: 12,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.textMuted }}>STEP {step.idx}</span>
                  {sr && <Badge variant={statusVariant(sr.status)} size="sm">{sr.status}</Badge>}
                </div>
                <div style={{ fontSize: 13, color: tokens.colors.textPrimary, marginBottom: 4 }}>{step.action}</div>
                {step.expect && (
                  <div style={{ fontSize: 11, color: tokens.colors.textSecondary }}>expect: {step.expect}</div>
                )}
                {step.mcp_tool && (
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, fontFamily: 'monospace' }}>{step.mcp_tool}</div>
                )}
                {thumbId && (
                  <img
                    src={rawResourceUrl(thumbId)}
                    alt={`step ${step.idx}`}
                    onClick={() => setLightbox({ src: rawResourceUrl(thumbId), kind: 'image' })}
                    style={{ marginTop: 8, width: '100%', height: 90, objectFit: 'cover', borderRadius: tokens.radii.sm, cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Run history + detail */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
        <div style={{ width: 230, flexShrink: 0 }}>
          <SectionLabel>Run history</SectionLabel>
          {runs.length === 0 && <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>No runs yet.</div>}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {runs.map((r) => (
              <button
                key={r.id}
                onClick={() => setActiveRunId(r.id)}
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8,
                  padding: '8px 10px', borderRadius: tokens.radii.sm, cursor: 'pointer', textAlign: 'left',
                  background: r.id === activeRunId ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
                  border: `1px solid ${r.id === activeRunId ? tokens.colors.borderStrong : tokens.colors.border}`,
                  color: tokens.colors.textPrimary,
                }}
              >
                <span style={{ fontSize: 12 }}>{relativeTime(r.created_at)}</span>
                <Badge variant={statusVariant(r.status)} size="sm">{r.status}</Badge>
              </button>
            ))}
          </div>
        </div>

        <div style={{ flex: 1, minWidth: 0 }}>
          <SectionLabel>Run detail</SectionLabel>
          {!activeRun ? (
            <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>Select a run.</div>
          ) : (
            <RunDetail run={activeRun} phases={resolvedPhases} onPreview={(src, kind) => setLightbox({ src, kind })} />
          )}
        </div>
      </div>

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function RunDetail({ run, phases, onPreview }: { run: QaRun; phases: QaPhasesConfig | null; onPreview: (src: string, kind: 'image' | 'video') => void }) {
  // Run-level artifacts (attach_qa_artifact) that aren't already shown in a
  // per-step gallery. recordStep folds step artifacts into artifact_resource_ids,
  // so subtract them here to render only the run-level extras (and avoid dupes).
  const stepArtifactIds = new Set(
    (run.step_results ?? []).flatMap((sr) => sr.artifact_resource_ids ?? []),
  );
  const runLevelArtifactIds = (run.artifact_resource_ids ?? []).filter((id) => !stepArtifactIds.has(id));

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Badge variant={statusVariant(run.status)} size="md">{run.status}</Badge>
        {run.current_phase && (
          <span title="현재 진행 중인 QA phase" style={{ display: 'inline-flex' }}>
            <Badge variant={run.status === 'running' || run.status === 'pending' ? 'warning' : 'info'} size="md">
              phase: {phases?.phases.find((p) => p.id === run.current_phase)?.label || run.current_phase}
            </Badge>
          </span>
        )}
        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          {(run.step_results?.length ?? 0)} step results · {(run.artifact_resource_ids?.length ?? 0)} artifacts
        </span>
        {run.rerun_generation > 0 && (
          <span title="QA→fix→QA 자동 재실행 세대 (수정 티켓 Done 시 트리거)" style={{ display: 'inline-flex' }}>
            <Badge variant="info" size="md">🔁 재실행 #{run.rerun_generation}</Badge>
          </span>
        )}
        {run.tested_commit && (
          <span
            title={`서버권위 — dispatch 시점 ${run.tested_environment || 'env'} 의 live 배포 commit (배포 인지)`}
            style={{ display: 'inline-flex' }}
          >
            <Badge variant="neutral" size="md">
              🚀 tested @ {run.tested_environment || 'env'}: <code>{run.tested_commit.slice(0, 8)}</code>
            </Badge>
          </span>
        )}
        {run.auto_ticket_id && (
          <a
            href={run.board_id
              ? `/ws/${run.workspace_id}/boards/${run.board_id}?ticket=${encodeURIComponent(run.auto_ticket_id)}`
              : `/?ticket=${encodeURIComponent(run.auto_ticket_id)}`}
            style={{ fontSize: 12, fontWeight: 600, color: tokens.colors.danger, textDecoration: 'none', border: `1px solid ${tokens.colors.danger}`, borderRadius: tokens.radii.sm, padding: '2px 8px' }}
            title="이 실패 run 이 자동 생성한 수정 티켓으로 이동"
          >
            → 생성된 티켓 #{run.auto_ticket_id.slice(0, 8)}
          </a>
        )}
      </div>
      <PhaseTimeline run={run} phases={phases} />
      {run.summary && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{run.summary}</div>
      )}
      {runLevelArtifactIds.length > 0 && (
        <div style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted, marginBottom: 6 }}>
            Run artifacts
          </div>
          <Gallery ids={runLevelArtifactIds} onPreview={onPreview} />
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {(run.step_results ?? []).map((sr) => (
          <div key={sr.idx} style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 10, background: tokens.colors.surfaceCard }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: sr.log || sr.artifact_resource_ids?.length ? 6 : 0 }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.textMuted }}>STEP {sr.idx}</span>
              <Badge variant={statusVariant(sr.status)} size="sm">{sr.status}</Badge>
            </div>
            {sr.log && <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 6 }}>{sr.log}</div>}
            {!!sr.artifact_resource_ids?.length && (
              <Gallery ids={sr.artifact_resource_ids} onPreview={onPreview} />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Phase timeline for a QA run (ticket 90cc22f7). Renders run.phase_history: one
 * row per phase the run entered, with entered→left, elapsed, and a progress bar
 * vs that phase's timeout (resolved from the scenario ?? board qa_phases config).
 * The active phase of an in-flight run shows a live elapsed-vs-timeout gauge that
 * turns amber as it nears the limit and red once over — the same threshold the
 * reaper uses to error-close a hung phase. If the reaper error-closed the run on a
 * phase timeout, the server prepends the reason to run.summary (shown below this).
 */
function PhaseTimeline({ run, phases }: { run: QaRun; phases: QaPhasesConfig | null }) {
  const history = run.phase_history ?? [];
  if (history.length === 0) return null;

  const runActive = run.status === 'running' || run.status === 'pending';
  const now = Date.now();
  const findPhase = (id: string) => phases?.phases.find((p) => p.id === id) ?? null;

  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted, marginBottom: 6 }}>
        Phase timeline
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {history.map((h, idx) => {
          const def = findPhase(h.phase);
          const timeout = def?.timeout_sec ?? null;
          const enteredMs = Date.parse(h.entered_at);
          const leftMs = h.left_at ? Date.parse(h.left_at) : null;
          const active = !h.left_at;
          // Active phase of a live run measures elapsed to "now"; a closed phase
          // measures to left_at. An active phase on a terminal run (e.g. reaper
          // error-close) measures to the run's finish so the bar freezes.
          const endMs = leftMs ?? (active && runActive ? now : Date.parse(run.finished_at ?? '') || now);
          const elapsedSec = Number.isFinite(enteredMs) ? Math.max(0, (endMs - enteredMs) / 1000) : 0;
          const pct = timeout ? Math.min(100, (elapsedSec / timeout) * 100) : null;
          const over = timeout != null && elapsedSec > timeout;
          const imminent = active && runActive && timeout != null && !over && elapsedSec >= timeout * 0.8;
          const barColor = over
            ? tokens.colors.danger
            : imminent
              ? tokens.colors.warning
              : active && runActive
                ? tokens.colors.info
                : tokens.colors.success;
          return (
            <div key={idx} style={{ border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: '8px 10px', background: tokens.colors.surfaceCard }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: timeout != null ? 6 : 0, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: tokens.colors.textMuted }}>#{idx + 1}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>{def?.label || h.phase}</span>
                {active && (
                  <Badge variant={runActive ? 'warning' : 'neutral'} size="sm">{runActive ? 'active' : 'open'}</Badge>
                )}
                <span style={{ marginLeft: 'auto', fontSize: 11, color: tokens.colors.textMuted }}>
                  {formatDuration(elapsedSec)}{timeout != null && ` / ${formatDuration(timeout)}`}
                  {over && timeout != null && <span style={{ color: tokens.colors.danger, fontWeight: 600 }}> · over</span>}
                </span>
              </div>
              {timeout != null ? (
                <div style={{ height: 6, borderRadius: 3, background: tokens.colors.surface, overflow: 'hidden' }}>
                  <div style={{ width: `${pct ?? 0}%`, height: '100%', background: barColor, transition: 'width 0.3s' }} />
                </div>
              ) : (
                <div style={{ fontSize: 11, color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                  no timeout defined for this phase (not in the resolved config)
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Gallery({ ids, onPreview }: { ids: string[]; onPreview: (src: string, kind: 'image' | 'video') => void }) {
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      {ids.map((id) => {
        const src = rawResourceUrl(id);
        // We don't know the mimetype here without a fetch; render an <img> and
        // fall back to a video thumbnail-style tile by attempting both. A plain
        // <img> that fails to load is swapped for a video element via onError.
        return <MediaThumb key={id} src={src} onClick={(kind) => onPreview(src, kind)} />;
      })}
    </div>
  );
}

function MediaThumb({ src, onClick }: { src: string; onClick: (kind: 'image' | 'video') => void }) {
  // Resolve the real mimetype before choosing the element. The previous version
  // always rendered an <img> and relied on its onError to swap to <video> — but
  // a video/* resource streams back HTTP 200, so the <img> just shows a broken
  // frame and never fires onError, leaving QA video evidence completely
  // invisible. A tiny ranged GET (bytes=0-0) of the streaming endpoint gives us
  // the authoritative Content-Type while transferring a single byte (src already
  // carries the ?token the /raw route requires).
  const [kind, setKind] = useState<'image' | 'video' | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetch(src, { headers: { Range: 'bytes=0-0' } })
      .then((res) => (res.headers.get('content-type') || '').toLowerCase())
      .then((ct) => { if (!cancelled) setKind(ct.startsWith('video/') ? 'video' : 'image'); })
      .catch(() => { if (!cancelled) setKind('image'); });
    return () => { cancelled = true; };
  }, [src]);
  if (kind === 'video') {
    return (
      <div onClick={() => onClick('video')} style={{ width: 120, height: 76, borderRadius: tokens.radii.sm, overflow: 'hidden', position: 'relative', background: '#000', cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}>
        <video src={src} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 22 }}>▶</span>
      </div>
    );
  }
  // image (or not-yet-resolved): keep the onError→video fallback as a safety net
  // in case the Content-Type probe fails or is stripped by a proxy.
  return (
    <img
      src={src}
      onClick={() => onClick('image')}
      onError={() => setKind('video')}
      alt="artifact"
      style={{ width: 76, height: 76, objectFit: 'cover', borderRadius: tokens.radii.sm, cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}
    />
  );
}

function Lightbox({ src, kind, onClose }: { src: string; kind: 'image' | 'video'; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div role="dialog" aria-modal="true" onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.92)', zIndex: 10000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 40, cursor: 'zoom-out' }}>
      {kind === 'video' ? (
        <video src={src} controls autoPlay playsInline onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90vw', maxHeight: '85vh', background: '#000', borderRadius: tokens.radii.sm }} />
      ) : (
        <img src={src} alt="preview" onClick={(e) => e.stopPropagation()} style={{ maxWidth: '90vw', maxHeight: '85vh', borderRadius: tokens.radii.sm }} />
      )}
      <button onClick={(e) => { e.stopPropagation(); onClose(); }} style={{ position: 'fixed', top: 12, right: 16, background: 'rgba(255,255,255,0.18)', color: '#fff', border: 'none', borderRadius: tokens.radii.sm, padding: '8px 14px', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>Close (Esc)</button>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted, marginBottom: 8 }}>{children}</div>;
}

// ── Live-commit badges (배포 인지, ticket 8ce72b18) ────────────────────────────
// One badge per environment showing the commit currently LIVE there, so an
// operator can see at a glance "merged ≠ deployed" — which env is on which commit.
function DeploymentBadges({ deployments }: { deployments: Deployment[] }) {
  if (!deployments || deployments.length === 0) return null;
  const sorted = [...deployments].sort((a, b) => a.environment.localeCompare(b.environment));
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginBottom: tokens.spacing.md }}>
      <span style={{ fontSize: 12, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5, color: tokens.colors.textMuted }}>
        🚀 Live commits
      </span>
      {sorted.map((d) => {
        const short = (d.deployed_commit_sha || '').slice(0, 8) || '—';
        const when = d.deployed_at ? relativeTime(d.deployed_at) : '';
        const label = (
          <Badge variant="neutral" size="sm">
            {d.environment}: <code>{short}</code>{d.workspace_id === null ? ' 🌐' : ''}
          </Badge>
        );
        const title = `${d.environment} — deployed ${short}${when ? ` (${when})` : ''} · source=${d.source}${d.workspace_id === null ? ' · global' : ''}`;
        return d.base_url ? (
          <a key={d.id} href={d.base_url} target="_blank" rel="noopener noreferrer" title={title} style={{ textDecoration: 'none', display: 'inline-flex' }}>
            {label}
          </a>
        ) : (
          <span key={d.id} title={title} style={{ display: 'inline-flex' }}>{label}</span>
        );
      })}
    </div>
  );
}

// ── Create / edit modal ──────────────────────────────────────────────────────

interface ScenarioEditorProps {
  scenario: QaScenario | null;
  workspaceId: string;
  boardId?: string;
  agents: QaAgent[];
  onClose: () => void;
  onSaved: (s: QaScenario) => void;
}

function ScenarioEditor({ scenario, workspaceId, boardId, agents, onClose, onSaved }: ScenarioEditorProps) {
  const { showToast } = useToast();
  const [name, setName] = useState(scenario?.name ?? '');
  const [description, setDescription] = useState(scenario?.description ?? '');
  const [targetAgentId, setTargetAgentId] = useState(scenario?.target_agent_id ?? (agents[0]?.id ?? ''));
  const [qaDriver, setQaDriver] = useState(scenario?.qa_driver ?? 'browser');
  // Deployment-awareness target environment (ticket 8ce72b18).
  const [targetEnvironment, setTargetEnvironment] = useState(scenario?.target_environment ?? '');
  const [enabled, setEnabled] = useState(scenario?.enabled ?? true);
  const [stepsText, setStepsText] = useState(JSON.stringify(scenario?.steps ?? [], null, 2));
  const [configText, setConfigText] = useState(JSON.stringify(scenario?.qa_driver_config ?? {}, null, 2));
  const [tagsText, setTagsText] = useState((scenario?.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);

  // 작업폴더 옵션 (workspace_folder / repo_ref / checkout_mode / build_mode).
  const [wf, setWf] = useState<WorkspaceFolderFormState>(initWorkspaceFolderState(scenario));
  const patchWf = (patch: Partial<WorkspaceFolderFormState>) => setWf((prev) => ({ ...prev, ...patch }));

  // On-failure auto-ticket policy (실패 시 → 티켓 생성).
  const oft = scenario?.on_failure_ticket ?? null;
  const [oftEnabled, setOftEnabled] = useState(!!oft?.enabled);
  const [oftPriority, setOftPriority] = useState<QaOnFailureTicketConfig['priority']>(oft?.priority ?? 'high');
  const [oftAssigneeId, setOftAssigneeId] = useState(oft?.assignee_id ?? '');
  const [oftColumn, setOftColumn] = useState(oft?.column_name ?? '');
  const [oftDedupe, setOftDedupe] = useState<QaOnFailureTicketConfig['dedupe']>(oft?.dedupe ?? 'per_run');
  const [oftBoardId, setOftBoardId] = useState(oft?.board_id ?? '');
  const [oftLabels, setOftLabels] = useState((oft?.labels ?? []).join(', '));
  // QA → fix → QA closed loop (ticket 467dbc7a).
  const [oftRerunOnFix, setOftRerunOnFix] = useState(!!oft?.rerun_on_fix);
  const [oftMaxRerun, setOftMaxRerun] = useState(String(oft?.max_rerun_attempts ?? 3));
  const [oftRerunDelay, setOftRerunDelay] = useState(String(oft?.rerun_delay_seconds ?? 0));
  // Deployment-fact gate (ticket 8ce72b18): wait for target_environment to deploy
  // the fix before re-running, instead of the fixed rerun_delay_seconds.
  const [oftDeploymentGate, setOftDeploymentGate] = useState(!!oft?.deployment_gate);

  // Per-scenario QA phases override (ticket 90cc22f7). Off = inherit the board's
  // qa_phases (or legacy single-timeout). On = these phases win for this scenario.
  const initialPhases = parseQaPhasesValue(scenario?.qa_phases);
  const [phasesOverride, setPhasesOverride] = useState(!!initialPhases);
  const [qaPhases, setQaPhases] = useState<QaPhase[]>(initialPhases?.phases ?? []);
  // Board default for the inherit preview. Fetched lazily; null = none/unknown.
  const [boardPhases, setBoardPhases] = useState<QaPhase[] | null>(null);
  useEffect(() => {
    const bid = scenario?.board_id ?? boardId ?? null;
    if (!bid) { setBoardPhases(null); return; }
    let cancelled = false;
    api.getBoard(bid)
      .then((b) => { if (!cancelled) setBoardPhases(parseQaPhasesValue((b as any)?.qa_phases)?.phases ?? null); })
      .catch(() => { if (!cancelled) setBoardPhases(null); });
    return () => { cancelled = true; };
  }, [scenario?.board_id, boardId]);

  const handleSave = async () => {
    if (!name.trim()) { showToast('Name is required', 'error'); return; }
    if (!targetAgentId) { showToast('Target agent is required', 'error'); return; }
    let steps: any; let config: any;
    try { steps = stepsText.trim() ? JSON.parse(stepsText) : []; } catch { showToast('Steps must be valid JSON array', 'error'); return; }
    try { config = configText.trim() ? JSON.parse(configText) : {}; } catch { showToast('Driver config must be valid JSON', 'error'); return; }
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    // Build the on-failure policy. Disabled → send an explicit { enabled:false }
    // so an existing policy is turned off (rather than left untouched).
    const onFailureTicket: QaOnFailureTicketConfig = oftEnabled
      ? {
          enabled: true,
          priority: oftPriority,
          dedupe: oftDedupe,
          ...(oftAssigneeId ? { assignee_id: oftAssigneeId } : {}),
          ...(oftColumn.trim() ? { column_name: oftColumn.trim() } : {}),
          ...(oftBoardId.trim() ? { board_id: oftBoardId.trim() } : {}),
          ...(oftLabels.trim() ? { labels: oftLabels.split(',').map((l) => l.trim()).filter(Boolean) } : {}),
          rerun_on_fix: oftRerunOnFix,
          ...(oftRerunOnFix ? {
            max_rerun_attempts: Math.max(0, parseInt(oftMaxRerun, 10) || 0),
            rerun_delay_seconds: Math.max(0, parseInt(oftRerunDelay, 10) || 0),
            deployment_gate: oftDeploymentGate,
          } : {}),
        }
      : { enabled: false };
    const wfPayload = buildWorkspaceFolderPayload(wf);
    // QA phases override: off OR empty → null (inherit board / legacy); on with
    // rows → validate against the WRITE contract before sending.
    let qaPhasesPayload: QaPhasesConfig | null = null;
    if (phasesOverride && qaPhases.length > 0) {
      const phaseErr = qaPhasesError(qaPhases);
      if (phaseErr) { showToast(phaseErr, 'error'); return; }
      qaPhasesPayload = { phases: qaPhases };
    }
    setSaving(true);
    try {
      let saved: QaScenario;
      if (scenario) {
        saved = await api.updateQaScenario(scenario.id, {
          workspace_id: workspaceId, name, description, target_agent_id: targetAgentId,
          qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
          target_environment: targetEnvironment.trim(),
          on_failure_ticket: onFailureTicket, qa_phases: qaPhasesPayload, ...wfPayload,
        });
      } else {
        saved = await api.createQaScenario({
          workspace_id: workspaceId, board_id: boardId || null, name, description,
          target_agent_id: targetAgentId, qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
          target_environment: targetEnvironment.trim(),
          on_failure_ticket: onFailureTicket, qa_phases: qaPhasesPayload, ...wfPayload,
        });
      }
      showToast(`Scenario ${scenario ? 'updated' : 'created'}`, 'success');
      onSaved(saved);
    } catch (err: any) {
      showToast(err?.message || 'Failed to save scenario', 'error');
    } finally {
      setSaving(false);
    }
  };

  const fieldLabel: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: tokens.colors.textSecondary, marginBottom: 4, display: 'block' };
  const textareaStyle: React.CSSProperties = {
    width: '100%', minHeight: 120, fontFamily: 'monospace', fontSize: 12, padding: 8,
    background: tokens.colors.surface, color: tokens.colors.textPrimary,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, resize: 'vertical',
  };

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={scenario ? 'Edit QA scenario' : 'New QA scenario'}
      maxWidth={640}
      footer={
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={handleSave} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <Input label="Name" value={name} onChange={(e) => setName((e.target as HTMLInputElement).value)} />
        <Input label="Description" value={description} onChange={(e) => setDescription((e.target as HTMLInputElement).value)} />
        <Select
          label="Target QA agent"
          placeholder="— select —"
          value={targetAgentId}
          options={agents.map((a) => ({ value: a.id, label: formatAgentDisplayName(a) }))}
          onChange={(e) => setTargetAgentId((e.target as HTMLSelectElement).value)}
        />
        <Input label="QA driver (browser / game-client / http-api)" value={qaDriver} onChange={(e) => setQaDriver((e.target as HTMLInputElement).value)} />
        <div>
          <Input
            label="Target environment (배포 인지 — Deployment.environment)"
            placeholder="예: awb-server, production, staging (비우면 env 미연결)"
            value={targetEnvironment}
            onChange={(e) => setTargetEnvironment((e.target as HTMLInputElement).value)}
          />
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 4 }}>
            설정 시 각 run 이 이 환경의 live 배포 commit 을 <code>tested_commit</code> 으로 기록하고,
            아래 배포 게이트가 이 환경에 fix 가 배포될 때까지 재실행을 대기시킵니다.
          </div>
        </div>
        <div>
          <label style={fieldLabel}>Steps (JSON array of {'{ idx, action, expect?, mcp_tool?, params? }'})</label>
          <textarea style={textareaStyle} value={stepsText} onChange={(e) => setStepsText(e.target.value)} />
        </div>
        <div>
          <label style={fieldLabel}>Driver config (JSON)</label>
          <textarea style={{ ...textareaStyle, minHeight: 80 }} value={configText} onChange={(e) => setConfigText(e.target.value)} />
        </div>
        <Input label="Tags (comma separated)" value={tagsText} onChange={(e) => setTagsText((e.target as HTMLInputElement).value)} />
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} /> Enabled
        </label>

        {/* 작업폴더 옵션 (workspace_folder / repo_ref / checkout_mode / build_mode) */}
        <WorkspaceFolderOptions kind="qa" state={wf} onChange={patchWf} />

        {/* QA phases override (ticket 90cc22f7) */}
        <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12, marginTop: 4 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
            <input
              type="checkbox"
              checked={phasesOverride}
              onChange={(e) => {
                setPhasesOverride(e.target.checked);
                // Seed the editor from the board default when first enabling an
                // override so the operator edits a copy rather than an empty list.
                if (e.target.checked && qaPhases.length === 0 && boardPhases?.length) {
                  setQaPhases(boardPhases.map((p) => ({ ...p })));
                }
              }}
            />
            QA phases 시나리오 override
          </label>
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, margin: '4px 0 0 24px' }}>
            {phasesOverride
              ? '이 시나리오 전용 phase 정의입니다 — board 기본값을 덮어씁니다.'
              : 'board 기본값을 상속합니다. 체크하면 이 시나리오만의 phase 를 정의할 수 있습니다.'}
          </div>

          {/* board 기본값 미리보기 (inherit 상태일 때) */}
          {!phasesOverride && (
            <div style={{ fontSize: 12, color: tokens.colors.textSecondary, margin: '8px 0 0 24px' }}>
              {boardPhases && boardPhases.length > 0 ? (
                <>
                  <span style={{ color: tokens.colors.textMuted }}>상속되는 board phases: </span>
                  {boardPhases.map((p, i) => (
                    <span key={p.id}>
                      {i > 0 && ' → '}
                      <span style={{ fontWeight: 600 }}>{p.label || p.id}</span>
                      <span style={{ color: tokens.colors.textMuted }}> ({formatDuration(p.timeout_sec)})</span>
                    </span>
                  ))}
                </>
              ) : (
                <span style={{ color: tokens.colors.textMuted, fontStyle: 'italic' }}>
                  board 에 phase 정의 없음 → 단일 timeout(legacy) 사용.
                </span>
              )}
            </div>
          )}

          {phasesOverride && (
            <div style={{ marginTop: 10, paddingLeft: 24 }}>
              <QaPhaseRowsEditor phases={qaPhases} onChange={setQaPhases} />
              {qaPhases.length === 0 && (
                <div style={{ fontSize: 12, color: tokens.colors.textMuted, marginTop: 8, fontStyle: 'italic' }}>
                  phase 가 없으면 override 가 비워져 저장 시 board 기본값을 상속합니다.
                </div>
              )}
              {qaPhases.length > 0 && qaPhasesError(qaPhases) && (
                <div style={{ fontSize: 12, color: tokens.colors.danger, marginTop: 8 }}>
                  {qaPhasesError(qaPhases)}
                </div>
              )}
            </div>
          )}
        </div>

        {/* 실패 시 → 티켓 생성 (on-failure auto-ticket) */}
        <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 12, marginTop: 4 }}>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
            <input type="checkbox" checked={oftEnabled} onChange={(e) => setOftEnabled(e.target.checked)} />
            실패 시 → 수정 티켓 자동 생성
          </label>
          <div style={{ fontSize: 12, color: tokens.colors.textMuted, margin: '4px 0 0 24px' }}>
            run 이 failed/error 로 끝나면 실패 증거(스텝 로그 + 스크린샷 링크)를 담은 수정 티켓을 자동 생성합니다.
          </div>
          {oftEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10, paddingLeft: 24 }}>
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <Select
                    label="Priority"
                    value={oftPriority}
                    options={[
                      { value: 'low', label: 'low' },
                      { value: 'medium', label: 'medium' },
                      { value: 'high', label: 'high' },
                      { value: 'critical', label: 'critical' },
                    ]}
                    onChange={(e) => setOftPriority((e.target as HTMLSelectElement).value as QaOnFailureTicketConfig['priority'])}
                  />
                </div>
                <div style={{ flex: 1 }}>
                  <Select
                    label="중복 방지 (dedupe)"
                    value={oftDedupe}
                    options={[
                      { value: 'per_run', label: 'per_run (run당 1개)' },
                      { value: 'per_open_ticket', label: 'per_open_ticket (열린 티켓에 코멘트)' },
                    ]}
                    onChange={(e) => setOftDedupe((e.target as HTMLSelectElement).value as QaOnFailureTicketConfig['dedupe'])}
                  />
                </div>
              </div>
              <Select
                label="담당자 (assignee — 비우면 시나리오 타깃 에이전트)"
                placeholder="— 시나리오 타깃 에이전트 사용 —"
                value={oftAssigneeId}
                options={agents.map((a) => ({ value: a.id, label: formatAgentDisplayName(a) }))}
                onChange={(e) => setOftAssigneeId((e.target as HTMLSelectElement).value)}
              />
              <Input label='컬럼 (비우면 "To Do")' value={oftColumn} onChange={(e) => setOftColumn((e.target as HTMLInputElement).value)} />
              <Input label="Board ID (비우면 run/시나리오 보드)" value={oftBoardId} onChange={(e) => setOftBoardId((e.target as HTMLInputElement).value)} />
              <Input label="Labels (comma — 비우면 qa-failure, auto)" value={oftLabels} onChange={(e) => setOftLabels((e.target as HTMLInputElement).value)} />

              {/* QA → fix → QA 닫힌 루프 (재실행) */}
              <div style={{ borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10, marginTop: 2 }}>
                <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
                  <input type="checkbox" checked={oftRerunOnFix} onChange={(e) => setOftRerunOnFix(e.target.checked)} />
                  수정 티켓 Done 시 → 시나리오 자동 재실행
                </label>
                <div style={{ fontSize: 12, color: tokens.colors.textMuted, margin: '4px 0 0 24px' }}>
                  자동 생성된 수정 티켓이 Done 컬럼에 들어가면 서버가 같은 시나리오를 결정적으로 재실행합니다.
                  pass 면 종료(새 티켓 없음), 재실패면 새 수정 티켓 + 세대 카운터 증가, max 도달 시 중단 코멘트.
                  {' '}⚠️ QA 는 <b>돌고 있는 서버</b>를 검증합니다 — main→prod auto-deploy 지연이 있으면 재실행 지연(초)을 배포 시간만큼 주세요.
                </div>
                {oftRerunOnFix && (
                  <div style={{ display: 'flex', gap: 10, marginTop: 10 }}>
                    <div style={{ flex: 1 }}>
                      <Input
                        label="최대 재실행 횟수 (max_rerun_attempts)"
                        type="number"
                        value={oftMaxRerun}
                        onChange={(e) => setOftMaxRerun((e.target as HTMLInputElement).value)}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <Input
                        label="재실행 지연 (초 — fallback cap)"
                        type="number"
                        value={oftRerunDelay}
                        onChange={(e) => setOftRerunDelay((e.target as HTMLInputElement).value)}
                      />
                    </div>
                  </div>
                )}
                {oftRerunOnFix && (
                  <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 13, color: tokens.colors.textSecondary, marginTop: 6 }}>
                    <input type="checkbox" checked={oftDeploymentGate} onChange={(e) => setOftDeploymentGate(e.target.checked)} style={{ marginTop: 3 }} />
                    <span>
                      배포 사실에 게이팅 (deployment_gate)
                      <span style={{ display: 'block', fontSize: 12, color: tokens.colors.textMuted }}>
                        시간 지연 대신, 위 <b>Target environment</b> 에 fix commit 이 실제로 배포되는 순간 재실행합니다
                        (fix-commit 라벨 ancestry / 없으면 배포시각 &ge; Done). 재실행 지연은 fallback cap 으로만 사용.
                        {!targetEnvironment.trim() && <span style={{ color: tokens.colors.danger }}> ⚠ Target environment 미설정 시 게이트 미작동(즉시/지연 경로).</span>}
                      </span>
                    </span>
                  </label>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

// ── Schedule create / edit modal (ticket b6bb7efd) ───────────────────────────

interface ScheduleEditorProps {
  schedule: QaSchedule | null;
  workspaceId: string;
  boardId?: string;
  scenarios: QaScenarioListItem[];
  onClose: () => void;
  onSaved: () => void;
}

function ScheduleEditor({ schedule, workspaceId, boardId, scenarios, onClose, onSaved }: ScheduleEditorProps) {
  const { showToast } = useToast();
  const [name, setName] = useState(schedule?.name ?? '');
  const [scope, setScope] = useState<QaScheduleScope>(schedule?.scope ?? 'all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set(schedule?.scenario_ids ?? []));
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
  const [stopOnFail, setStopOnFail] = useState(schedule?.stop_on_fail ?? false);
  const [saving, setSaving] = useState(false);

  const toggleScenario = (id: string) => {
    setSelectedIds((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const intervalMs = (() => {
    const n = parseInt(intervalValue, 10);
    if (!Number.isFinite(n) || n <= 0) return NaN;
    const factor = intervalUnit === 'hours' ? 3_600_000 : intervalUnit === 'minutes' ? 60_000 : 1_000;
    return n * factor;
  })();

  const handleSave = async () => {
    if (!name.trim()) { showToast('이름을 입력하세요', 'error'); return; }
    // scope='selected' 는 시나리오 순서를 화면 목록 순서로 보존.
    const orderedIds = scenarios.filter((s) => selectedIds.has(s.id)).map((s) => s.id);
    if (scope === 'selected' && orderedIds.length === 0) {
      showToast("scope='selected' 는 시나리오를 1개 이상 선택해야 합니다", 'error'); return;
    }
    if (cadenceKind === 'cron') {
      if (cron.trim().split(/\s+/).length !== 5) { showToast('cron 은 5개 필드여야 합니다 (예: "0 3 * * *")', 'error'); return; }
    } else if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
      showToast('주기는 1초 이상이어야 합니다', 'error'); return;
    }

    const base = {
      workspace_id: workspaceId,
      name: name.trim(),
      scope,
      scenario_ids: scope === 'selected' ? orderedIds : [],
      enabled,
      stop_on_fail: stopOnFail,
      // Send exactly one cadence; null the other so a kind-switch clears it.
      cron: cadenceKind === 'cron' ? cron.trim() : null,
      interval_ms: cadenceKind === 'interval' ? intervalMs : null,
    };

    setSaving(true);
    try {
      if (schedule) {
        await api.updateQaSchedule(schedule.id, base);
      } else {
        await api.createQaSchedule({ ...base, board_id: boardId !== undefined ? (boardId || null) : null });
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

  return (
    <Modal
      isOpen={true}
      onClose={onClose}
      title={schedule ? 'QA 스케줄 수정' : '새 QA 스케줄'}
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

        {/* Scope: 전체 vs 선택 시나리오 토글 */}
        <div>
          <label style={fieldLabel}>대상 시나리오</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: scope === 'selected' ? 8 : 0 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="qa-sched-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              전체 (실행 시점 enabled 시나리오로 자동 확장)
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="qa-sched-scope" checked={scope === 'selected'} onChange={() => setScope('selected')} />
              선택
            </label>
          </div>
          {scope === 'selected' && (
            <div style={{ maxHeight: 180, overflowY: 'auto', border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.sm, padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {scenarios.length === 0 && <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>시나리오가 없습니다.</div>}
              {scenarios.map((s) => (
                <label key={s.id} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textPrimary, cursor: 'pointer' }}>
                  <input type="checkbox" checked={selectedIds.has(s.id)} onChange={() => toggleScenario(s.id)} />
                  {s.name}
                  {!s.enabled && <Badge variant="warning" size="sm">disabled</Badge>}
                </label>
              ))}
            </div>
          )}
        </div>

        {/* Cadence: interval vs cron */}
        <div>
          <label style={fieldLabel}>실행 주기</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="qa-sched-cadence" checked={cadenceKind === 'interval'} onChange={() => setCadenceKind('interval')} />
              주기 (interval)
            </label>
            <label style={{ display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary, cursor: 'pointer' }}>
              <input type="radio" name="qa-sched-cadence" checked={cadenceKind === 'cron'} onChange={() => setCadenceKind('cron')} />
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
          <input type="checkbox" checked={stopOnFail} onChange={(e) => setStopOnFail(e.target.checked)} />
          첫 실패에서 batch 중단 (stop on fail)
        </label>
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13, color: tokens.colors.textSecondary }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enabled
        </label>

        <div style={{ fontSize: 12, color: tokens.colors.textMuted, borderTop: `1px solid ${tokens.colors.border}`, paddingTop: 10 }}>
          ⚠️ 자동 실행은 <b>돌고 있는 서버</b>를 검증합니다. main→prod auto-deploy 지연이 있으면, 주기를 배포 지연보다 넉넉히 잡거나(혹은 고정 시각 cron) 옛 코드를 검증하지 않도록 운영상 주의하세요. cron 은 모두 <b>UTC</b> 기준입니다.
        </div>
      </div>
    </Modal>
  );
}
