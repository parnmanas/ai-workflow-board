import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId, rawResourceUrl } from '../../api';
import type { QaScenario, QaScenarioListItem, QaRun, QaStepResult, QaOnFailureTicketConfig, QaRunBatch } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Select, Modal, Card, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import { formatAgentDisplayName } from '../../utils/agentName';

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

  const load = useCallback(async () => {
    if (!effectiveWorkspaceId) { setScenarios([]); return; }
    try {
      const [list, agentList] = await Promise.all([
        api.listQaScenarios(effectiveWorkspaceId, boardId !== undefined ? (boardId || '') : undefined),
        api.getAgents().catch(() => []),
      ]);
      setScenarios(list);
      setAgents((agentList || []).map((a: any) => ({ id: a.id, name: a.name, manager_name: a.manager_name })));
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
            <th style={{ ...TH, textAlign: 'right' }}>Pass</th>
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
        {s.pass_rate !== null
          ? <span title={`${s.run_count} run${s.run_count === 1 ? '' : 's'}`} style={{ color: s.pass_rate === 100 ? tokens.colors.success : tokens.colors.textSecondary, fontVariantNumeric: 'tabular-nums' }}>{s.pass_rate}%</span>
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

  const passRate = (() => {
    const finished = runs.filter((r) => r.status === 'passed' || r.status === 'failed' || r.status === 'error');
    if (!finished.length) return null;
    const passed = finished.filter((r) => r.status === 'passed').length;
    return Math.round((passed / finished.length) * 100);
  })();

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <Button variant="ghost" size="sm" onClick={onBack}>← Back</Button>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: tokens.colors.textPrimary }}>{scenario.name}</div>
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {scenario.qa_driver && <Badge variant="info" size="sm">{scenario.qa_driver}</Badge>}
            <Badge variant="neutral" size="sm">agent: {agentName(scenario.target_agent_id)}</Badge>
            {passRate !== null && <Badge variant={passRate === 100 ? 'success' : 'warning'} size="sm">{passRate}% pass</Badge>}
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
            <RunDetail run={activeRun} onPreview={(src, kind) => setLightbox({ src, kind })} />
          )}
        </div>
      </div>

      {lightbox && <Lightbox {...lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

function RunDetail({ run, onPreview }: { run: QaRun; onPreview: (src: string, kind: 'image' | 'video') => void }) {
  return (
    <div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8, flexWrap: 'wrap' }}>
        <Badge variant={statusVariant(run.status)} size="md">{run.status}</Badge>
        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          {(run.step_results?.length ?? 0)} step results · {(run.artifact_resource_ids?.length ?? 0)} artifacts
        </span>
        {run.rerun_generation > 0 && (
          <span title="QA→fix→QA 자동 재실행 세대 (수정 티켓 Done 시 트리거)" style={{ display: 'inline-flex' }}>
            <Badge variant="info" size="md">🔁 재실행 #{run.rerun_generation}</Badge>
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
      {run.summary && (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, marginBottom: 12, whiteSpace: 'pre-wrap' }}>{run.summary}</div>
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
  const [isVideo, setIsVideo] = useState(false);
  if (isVideo) {
    return (
      <div onClick={() => onClick('video')} style={{ width: 120, height: 76, borderRadius: tokens.radii.sm, overflow: 'hidden', position: 'relative', background: '#000', cursor: 'pointer', border: `1px solid ${tokens.colors.border}` }}>
        <video src={src} muted playsInline preload="metadata" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'rgba(255,255,255,0.85)', fontSize: 22 }}>▶</span>
      </div>
    );
  }
  return (
    <img
      src={src}
      onClick={() => onClick('image')}
      onError={() => setIsVideo(true)}
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
  const [enabled, setEnabled] = useState(scenario?.enabled ?? true);
  const [stepsText, setStepsText] = useState(JSON.stringify(scenario?.steps ?? [], null, 2));
  const [configText, setConfigText] = useState(JSON.stringify(scenario?.qa_driver_config ?? {}, null, 2));
  const [tagsText, setTagsText] = useState((scenario?.tags ?? []).join(', '));
  const [saving, setSaving] = useState(false);

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
          } : {}),
        }
      : { enabled: false };
    setSaving(true);
    try {
      let saved: QaScenario;
      if (scenario) {
        saved = await api.updateQaScenario(scenario.id, {
          workspace_id: workspaceId, name, description, target_agent_id: targetAgentId,
          qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
          on_failure_ticket: onFailureTicket,
        });
      } else {
        saved = await api.createQaScenario({
          workspace_id: workspaceId, board_id: boardId || null, name, description,
          target_agent_id: targetAgentId, qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
          on_failure_ticket: onFailureTicket,
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
                        label="재실행 지연 (초 — 배포 게이트)"
                        type="number"
                        value={oftRerunDelay}
                        onChange={(e) => setOftRerunDelay((e.target as HTMLInputElement).value)}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
