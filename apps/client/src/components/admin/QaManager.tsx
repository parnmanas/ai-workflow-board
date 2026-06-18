import React, { useState, useEffect, useCallback } from 'react';
import { api, getActiveWorkspaceId, rawResourceUrl } from '../../api';
import type { QaScenario, QaRun, QaStepResult } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { tokens } from '../../tokens';
import { Button, Input, Select, Modal, Card, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';

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

  const [scenarios, setScenarios] = useState<QaScenario[]>([]);
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<QaScenario | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [editing, setEditing] = useState<QaScenario | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<QaScenario | null>(null);

  const load = useCallback(async () => {
    if (!effectiveWorkspaceId) { setScenarios([]); return; }
    try {
      const [list, agentList] = await Promise.all([
        api.listQaScenarios(effectiveWorkspaceId, boardId !== undefined ? (boardId || '') : undefined),
        api.getAgents().catch(() => []),
      ]);
      setScenarios(list);
      setAgents((agentList || []).map((a: any) => ({ id: a.id, name: a.name })));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load QA scenarios', 'error');
    }
  }, [effectiveWorkspaceId, boardId, showToast]);

  useEffect(() => { load(); }, [load]);

  const agentName = useCallback((id: string) => agents.find((a) => a.id === id)?.name || id.slice(0, 8), [agents]);

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

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: tokens.spacing.md }}>
        <div style={{ color: tokens.colors.textSecondary, fontSize: 13 }}>
          Scenario-based QA — run a scenario, accumulate step pass/fail + screenshots, re-run to compare.
        </div>
        <Button variant="primary" size="md" onClick={() => setEditing('new')}>+ New Scenario</Button>
      </div>

      {scenarios.length === 0 ? (
        <Card padding="20px">
          <div style={{ color: tokens.colors.textSecondary }}>
            No QA scenarios yet. Create one and point it at a QA driver (browser / game-client / http-api).
            See <code>docs/qa-driver-guide.md</code>.
          </div>
        </Card>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: tokens.spacing.md }}>
          {scenarios.map((s) => (
            <Card key={s.id} padding="14px 16px">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
                <div style={{ cursor: 'pointer', flex: 1 }} onClick={() => setSelected(s)}>
                  <div style={{ fontWeight: 600, color: tokens.colors.textPrimary, marginBottom: 4 }}>{s.name}</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                    {s.qa_driver && <Badge variant="info" size="sm">{s.qa_driver}</Badge>}
                    <Badge variant="neutral" size="sm">{(s.steps?.length ?? 0)} steps</Badge>
                    {!s.enabled && <Badge variant="warning" size="sm">disabled</Badge>}
                  </div>
                  {s.description && (
                    <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 6 }}>{s.description}</div>
                  )}
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted }}>agent: {agentName(s.target_agent_id)}</div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <Button variant="primary" size="sm" onClick={() => handleRun(s)} disabled={running === s.id}>
                  {running === s.id ? 'Starting…' : '▶ Run'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setSelected(s)}>Open</Button>
                <Button variant="ghost" size="sm" onClick={() => setEditing(s)}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => setConfirmDelete(s)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {modals}
    </div>
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
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <Badge variant={statusVariant(run.status)} size="md">{run.status}</Badge>
        <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>
          {(run.step_results?.length ?? 0)} step results · {(run.artifact_resource_ids?.length ?? 0)} artifacts
        </span>
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
  agents: Array<{ id: string; name: string }>;
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

  const handleSave = async () => {
    if (!name.trim()) { showToast('Name is required', 'error'); return; }
    if (!targetAgentId) { showToast('Target agent is required', 'error'); return; }
    let steps: any; let config: any;
    try { steps = stepsText.trim() ? JSON.parse(stepsText) : []; } catch { showToast('Steps must be valid JSON array', 'error'); return; }
    try { config = configText.trim() ? JSON.parse(configText) : {}; } catch { showToast('Driver config must be valid JSON', 'error'); return; }
    const tags = tagsText.split(',').map((t) => t.trim()).filter(Boolean);
    setSaving(true);
    try {
      let saved: QaScenario;
      if (scenario) {
        saved = await api.updateQaScenario(scenario.id, {
          workspace_id: workspaceId, name, description, target_agent_id: targetAgentId,
          qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
        });
      } else {
        saved = await api.createQaScenario({
          workspace_id: workspaceId, board_id: boardId || null, name, description,
          target_agent_id: targetAgentId, qa_driver: qaDriver, qa_driver_config: config, steps, tags, enabled,
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
          options={agents.map((a) => ({ value: a.id, label: a.name }))}
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
      </div>
    </Modal>
  );
}
