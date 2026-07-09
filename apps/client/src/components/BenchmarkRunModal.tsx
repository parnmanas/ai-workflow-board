import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useToast } from '../contexts/ToastContext';
import { tokens } from '../tokens';
import { Modal, Button, Input } from './common';
import type { Agent, BenchmarkRunDetail } from '../types';

/**
 * Create / Edit a benchmark run (ticket 5eb459c4).
 *
 * One modal drives both flows:
 *   - create: POST /benchmark/runs → a DRAFT run (candidates parked, NOT
 *     dispatched). Start happens later from the run list.
 *   - edit:   GET /benchmark/runs/:id prefills, PATCH saves. The Option-A
 *     fairness policy is enforced server-side; the UI mirrors it so the user
 *     isn't surprised by a 422 — once a run is `started`, prompt / rubric /
 *     base repo / evaluators / existing candidates are read-only (disabled with
 *     a reason tooltip) and only "add candidate" is live. A draft run is fully
 *     editable.
 *
 * On started runs we PATCH only { title, candidate_agent_ids } so an unchanged
 * prompt/evaluator field can never trip the server's set-equality guard.
 */

interface BenchmarkRunModalProps {
  isOpen: boolean;
  onClose: () => void;
  boardId: string;
  workspaceId?: string;
  /** Candidate-column choices (board columns). */
  columns: Array<{ id: string; name: string }>;
  /** Agent pool for the candidate + evaluator multiselects. */
  agents: Agent[];
  /** edit when set, otherwise create. */
  runId?: string;
  /** Called after a successful create/edit/start so the page can refresh. */
  onSaved: () => void;
}

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  fontWeight: 600,
  color: tokens.colors.textSecondary,
  margin: '0 0 4px',
};

const textareaStyle = (disabled?: boolean): React.CSSProperties => ({
  width: '100%',
  minHeight: 80,
  padding: '8px 10px',
  fontSize: 13,
  fontFamily: 'inherit',
  background: disabled ? tokens.colors.surface : tokens.colors.surfaceCard,
  border: `1px solid ${tokens.colors.border}`,
  borderRadius: tokens.radii.md,
  color: disabled ? tokens.colors.textMuted : tokens.colors.textStrong,
  resize: 'vertical',
  boxSizing: 'border-box',
});

const fieldGap: React.CSSProperties = { marginBottom: 16 };

const STARTED_REASON =
  'Locked: this run has started. Only adding candidates is allowed (fairness protection).';

/** A scrollable checkbox list used for both candidate + evaluator selection. */
function AgentMultiSelect({
  agents,
  selected,
  onToggle,
  lockedIds,
  lockedReason,
}: {
  agents: Agent[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  /** Ids that cannot be unchecked (e.g. existing candidates on a started run). */
  lockedIds?: Set<string>;
  lockedReason?: string;
}) {
  return (
    <div
      style={{
        maxHeight: 140,
        overflowY: 'auto',
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
        background: tokens.colors.surfaceCard,
      }}
    >
      {agents.length === 0 ? (
        <div style={{ padding: 10, fontSize: 12, color: tokens.colors.textMuted }}>
          No agents in this workspace.
        </div>
      ) : (
        agents.map((a) => {
          const isChecked = selected.has(a.id);
          const isLocked = !!lockedIds?.has(a.id);
          return (
            <label
              key={a.id}
              title={isLocked ? lockedReason : undefined}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 10px',
                fontSize: 13,
                color: isLocked ? tokens.colors.textMuted : tokens.colors.textStrong,
                cursor: isLocked ? 'not-allowed' : 'pointer',
                borderBottom: `1px solid ${tokens.colors.border}40`,
              }}
            >
              <input
                type="checkbox"
                checked={isChecked}
                disabled={isLocked}
                onChange={() => onToggle(a.id)}
              />
              <span>{a.manager_name ? `${a.manager_name}/${a.name}` : a.name}</span>
            </label>
          );
        })
      )}
    </div>
  );
}

export default function BenchmarkRunModal({
  isOpen,
  onClose,
  boardId,
  workspaceId,
  columns,
  agents,
  runId,
  onSaved,
}: BenchmarkRunModalProps) {
  const { showToast } = useToast();
  const isEdit = !!runId;

  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [rubric, setRubric] = useState('');
  const [baseRepo, setBaseRepo] = useState('');
  const [candidateIds, setCandidateIds] = useState<Set<string>>(new Set());
  const [evaluatorIds, setEvaluatorIds] = useState<Set<string>>(new Set());
  const [candidateColumn, setCandidateColumn] = useState('');
  const [state, setState] = useState<'draft' | 'started'>('draft');
  // Candidate agents that already exist on a started run — locked (no removal).
  const [lockedCandidates, setLockedCandidates] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const started = isEdit && state === 'started';

  // Reset + (edit) prefill whenever the modal opens.
  useEffect(() => {
    if (!isOpen) return;
    if (!isEdit) {
      setTitle('');
      setPrompt('');
      setRubric('');
      setBaseRepo('');
      setCandidateIds(new Set());
      setEvaluatorIds(new Set());
      setCandidateColumn(columns[0]?.name ?? '');
      setState('draft');
      setLockedCandidates(new Set());
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .getBenchmarkRun(runId!)
      .then((d: BenchmarkRunDetail) => {
        if (cancelled) return;
        setTitle(d.title || '');
        setPrompt(d.prompt || '');
        setRubric(d.rubric || '');
        setBaseRepo(d.base_repo || '');
        const cand = new Set(d.candidates.map((c) => c.assignee_agent_id).filter(Boolean));
        setCandidateIds(cand);
        setEvaluatorIds(new Set(d.evaluator_agent_ids || []));
        const col = columns.find((c) => c.id === d.candidate_column_id);
        setCandidateColumn(col?.name ?? columns[0]?.name ?? '');
        setState(d.state);
        setLockedCandidates(d.state === 'started' ? cand : new Set());
      })
      .catch((err: any) => showToast(err?.message || 'Failed to load run', 'error'))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isOpen, isEdit, runId, columns, showToast]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string, locked?: Set<string>) => {
    if (locked?.has(id)) return; // cannot remove a locked candidate
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const columnOptions = useMemo(
    () => columns.map((c) => ({ value: c.name, label: c.name })),
    [columns],
  );

  // manager(type='manager') agent 은 role holder·트리거·chat 대상에서 구조적으로 차단되어
  // 후보/평가자로 골라도 실제 dispatch 되지 않는다. 다른 4개 셀렉트(⑦ 티켓)와 동일하게
  // 후보·평가자 드롭다운에서 숨겨 무반응/혼동을 막는다.
  const selectableAgents = useMemo(
    () => agents.filter((a) => a.type !== 'manager'),
    [agents],
  );

  const submit = async () => {
    if (!prompt.trim()) {
      showToast('Prompt is required', 'error');
      return;
    }
    setSaving(true);
    try {
      if (!isEdit) {
        await api.createBenchmarkRun({
          board_id: boardId,
          title: title.trim() || undefined,
          prompt,
          rubric: rubric.trim() || undefined,
          base_repo: baseRepo.trim() || undefined,
          candidate_agent_ids: Array.from(candidateIds),
          evaluator_agent_ids: Array.from(evaluatorIds),
          candidate_column_name: candidateColumn || undefined,
        });
        showToast('Draft run created', 'success');
      } else if (started) {
        // Option-A: only title + candidate additions survive on a started run.
        await api.updateBenchmarkRun(runId!, {
          title: title.trim() || undefined,
          candidate_agent_ids: Array.from(candidateIds),
        });
        showToast('Run updated', 'success');
      } else {
        await api.updateBenchmarkRun(runId!, {
          title: title.trim() || undefined,
          prompt,
          rubric,
          base_repo: baseRepo,
          candidate_agent_ids: Array.from(candidateIds),
          evaluator_agent_ids: Array.from(evaluatorIds),
          candidate_column_name: candidateColumn || undefined,
        });
        showToast('Draft run updated', 'success');
      }
      onSaved();
      onClose();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save run', 'error');
    } finally {
      setSaving(false);
    }
  };

  const footer = (
    <>
      <Button variant="secondary" size="sm" onClick={onClose} disabled={saving}>
        Cancel
      </Button>
      <Button variant="primary" size="sm" onClick={submit} disabled={saving || loading}>
        {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create draft'}
      </Button>
    </>
  );

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={isEdit ? 'Edit benchmark run' : 'New benchmark run'}
      footer={footer}
      maxWidth={560}
    >
      {loading ? (
        <div style={{ padding: 20, fontSize: 13, color: tokens.colors.textMuted }}>Loading run…</div>
      ) : (
        <div>
          {started && (
            <div
              style={{
                fontSize: 12,
                color: tokens.colors.warningLight,
                background: `${tokens.colors.warningBg}20`,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                marginBottom: 16,
              }}
            >
              This run has <strong>started</strong>. To protect fairness, only adding candidates is
              allowed — prompt, rubric, evaluators and existing candidates are locked.
            </div>
          )}

          <div style={fieldGap}>
            <Input
              label="Title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Benchmark run"
            />
          </div>

          <div style={fieldGap}>
            <label style={labelStyle} title={started ? STARTED_REASON : undefined}>
              Prompt *{started ? ' (locked)' : ''}
            </label>
            <textarea
              style={textareaStyle(started)}
              value={prompt}
              disabled={started}
              title={started ? STARTED_REASON : undefined}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="The task each candidate agent works on…"
            />
          </div>

          <div style={fieldGap}>
            <label style={labelStyle} title={started ? STARTED_REASON : undefined}>
              Rubric{started ? ' (locked)' : ''}
            </label>
            <textarea
              style={textareaStyle(started)}
              value={rubric}
              disabled={started}
              title={started ? STARTED_REASON : undefined}
              onChange={(e) => setRubric(e.target.value)}
              placeholder="How evaluators should score (e.g. correctness 0..10)…"
            />
          </div>

          <div style={fieldGap}>
            <label style={labelStyle} title={started ? STARTED_REASON : undefined}>
              Base repository{started ? ' (locked)' : ''}
            </label>
            <textarea
              style={{ ...textareaStyle(started), minHeight: 44 }}
              value={baseRepo}
              disabled={started}
              title={started ? STARTED_REASON : undefined}
              onChange={(e) => setBaseRepo(e.target.value)}
              placeholder="Optional: repo URL / branch context for candidates…"
            />
          </div>

          <div style={fieldGap}>
            <label style={labelStyle}>
              Candidate agents{started ? ' (existing locked — add only)' : ''}
            </label>
            <AgentMultiSelect
              agents={selectableAgents}
              selected={candidateIds}
              lockedIds={started ? lockedCandidates : undefined}
              lockedReason={STARTED_REASON}
              onToggle={(id) =>
                toggle(candidateIds, setCandidateIds, id, started ? lockedCandidates : undefined)
              }
            />
          </div>

          <div style={fieldGap}>
            <label style={labelStyle} title={started ? STARTED_REASON : undefined}>
              Evaluator agents{started ? ' (locked)' : ''}
            </label>
            {started ? (
              <div style={{ fontSize: 13, color: tokens.colors.textMuted, padding: '4px 0' }}>
                {evaluatorIds.size === 0
                  ? 'None'
                  : agents
                      .filter((a) => evaluatorIds.has(a.id))
                      .map((a) => a.name)
                      .join(', ')}
              </div>
            ) : (
              <AgentMultiSelect
                agents={selectableAgents}
                selected={evaluatorIds}
                onToggle={(id) => toggle(evaluatorIds, setEvaluatorIds, id)}
              />
            )}
          </div>

          <div style={fieldGap}>
            <label style={labelStyle} title={started ? STARTED_REASON : undefined}>
              Candidate column{started ? ' (locked)' : ''}
            </label>
            <select
              value={candidateColumn}
              disabled={started}
              title={started ? STARTED_REASON : undefined}
              onChange={(e) => setCandidateColumn(e.target.value)}
              style={{
                width: '100%',
                padding: '8px 10px',
                fontSize: 13,
                background: started ? tokens.colors.surface : tokens.colors.surfaceCard,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                color: started ? tokens.colors.textMuted : tokens.colors.textStrong,
              }}
            >
              {columnOptions.length === 0 && <option value="">(board default)</option>}
              {columnOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </Modal>
  );
}
