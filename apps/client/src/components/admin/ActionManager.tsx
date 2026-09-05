import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import { formatAgentDisplayName } from '../../utils/agentName';
import type { Action, ActionRun, ChatRoomMessageItem } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Card, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import MessageList from '../chat/MessageList';
import ChatMessageInput from '../chat/ChatMessageInput';
import type { MentionParticipant } from '../chat/utils/markdown';
import { WorkspaceFolderOptions, initWorkspaceFolderState, buildWorkspaceFolderPayload, type WorkspaceFolderFormState } from './WorkspaceFolderOptions';

interface AgentOption {
  id: string;
  name: string;
  /** Required for the `<Manager>/<Agent>` render — see utils/agentName.ts. */
  manager_name?: string | null;
}

/**
 * 이 Action 의 대상 에이전트 목록 (티켓 fc3906c5).
 *
 * 서버 REST 경로는 `actionToWireJson` 으로 배열을 내보내지만, 이 헬퍼는 **문자열
 * 형태도 받아낸다**: 이 컬럼은 DB 에 JSON 문자열로 저장되므로, 엔티티를 그대로
 * 흘려보내는 경로가 하나라도 생기면(또는 이 필드가 없던 시절 응답이 캐시돼
 * 있으면) 여기로 `'["a","b"]'` 가 들어온다. 문자열에 `.filter` 를 부르면 화면이
 * 통째로 터지므로, 방어를 진입점 한 곳에 모아 둔다.
 *
 * 배열이 비면 레거시 단일 필드로 폴백한다 — 서버 쪽 actionTargetAgentIds() 와
 * 같은 규칙이다.
 */
function actionTargets(a: Pick<Action, 'target_agent_id' | 'target_agent_ids'>): string[] {
  const raw: unknown = a.target_agent_ids;
  let many: string[] = [];
  if (Array.isArray(raw)) {
    many = raw.filter(Boolean);
  } else if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) many = parsed.filter(Boolean);
    } catch {
      many = [];
    }
  }
  if (many.length > 0) return many;
  return a.target_agent_id ? [a.target_agent_id] : [];
}

/** 배치의 종합 판정 — 전체 성공 / 부분 실패 / 전체 실패 / 진행 중. */
type BatchVerdict = 'running' | 'succeeded' | 'partial' | 'failed';

/**
 * 같은 batch_id 의 run 들을 하나로 묶는다. 한 에이전트에 run 이 여럿이면
 * (재시도 체인) `attempt` 가 가장 큰 것이 그 에이전트의 최종 결과다 —
 * created_at 이 아니라 attempt 로 고르는 이유는 재시도가 항상 attempt+1 로
 * 생성돼 배치·에이전트 안에서 유일하고 단조이기 때문이다.
 *
 * batch_id 가 없는 레거시 run 은 각자 자기 자신만의 배치로 취급한다.
 */
interface RunBatch {
  key: string;
  /** 표시 순서용 — 배치에서 가장 최근 run 의 created_at. */
  latestAt: string;
  runs: ActionRun[];
  /** 에이전트별 최종 run (재시도 체인의 마지막 시도). */
  finals: ActionRun[];
  verdict: BatchVerdict;
  succeeded: number;
  total: number;
}

export function groupRunsIntoBatches(runs: ActionRun[]): RunBatch[] {
  const byKey = new Map<string, ActionRun[]>();
  for (const r of runs) {
    const key = r.batch_id || `run:${r.id}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(r);
    else byKey.set(key, [r]);
  }
  const batches: RunBatch[] = [];
  for (const [key, bucketRuns] of byKey) {
    const latestByAgent = new Map<string, ActionRun>();
    for (const r of bucketRuns) {
      const agentKey = r.agent_id || `legacy:${r.id}`;
      const prev = latestByAgent.get(agentKey);
      if (!prev || (r.attempt ?? 1) > (prev.attempt ?? 1)) latestByAgent.set(agentKey, r);
    }
    const finals = [...latestByAgent.values()];
    const anyRunning = bucketRuns.some((r) => (r.status || 'running') === 'running');
    const succeeded = finals.filter((r) => r.status === 'succeeded').length;
    const verdict: BatchVerdict = anyRunning
      ? 'running'
      : succeeded === finals.length
        ? 'succeeded'
        : succeeded === 0
          ? 'failed'
          : 'partial';
    const latestAt = bucketRuns.reduce((acc, r) => (r.created_at > acc ? r.created_at : acc), bucketRuns[0].created_at);
    batches.push({ key, latestAt, runs: bucketRuns, finals, verdict, succeeded, total: finals.length });
  }
  return batches.sort((a, b) => (a.latestAt < b.latestAt ? 1 : a.latestAt > b.latestAt ? -1 : 0));
}

interface ActionManagerProps {
  workspaceId?: string;
}

export default function ActionManager({ workspaceId }: ActionManagerProps) {
  const { showToast } = useToast();
  const effectiveWorkspaceId = workspaceId || (getActiveWorkspaceId() || '');

  const [actions, setActions] = useState<Action[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Action | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editAction, setEditAction] = useState<Action | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Action | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState<string | null>(null);

  // Form state
  const [formName, setFormName] = useState('');
  const [formDescription, setFormDescription] = useState('');
  const [formPrompt, setFormPrompt] = useState('');
  // 대상은 배열이다 (티켓 fc3906c5) — 한 Action 을 여러 에이전트가 각자 실행한다.
  const [formAgentIds, setFormAgentIds] = useState<string[]>([]);
  const [formCron, setFormCron] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formMaxRuns, setFormMaxRuns] = useState(10);
  const [formTrigger, setFormTrigger] = useState('');
  const [formTriggerLabel, setFormTriggerLabel] = useState('');
  const [formFolder, setFormFolder] = useState<WorkspaceFolderFormState>(initWorkspaceFolderState(null));
  const [formErrors, setFormErrors] = useState<{ name?: string; agent?: string }>({});

  const loadActions = useCallback(async () => {
    if (!effectiveWorkspaceId) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [list, agentList] = await Promise.all([
        api.listActions(effectiveWorkspaceId),
        api.getAgents(effectiveWorkspaceId).catch(() => [] as any[]),
      ]);
      setActions(list);
      setAgents((agentList as any[]).map((a) => ({ id: a.id, name: a.name, manager_name: a.manager_name })));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load actions', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkspaceId, showToast]);

  useEffect(() => { loadActions(); }, [loadActions]);

  useEffect(() => {
    const artifactId = typeof window === 'undefined'
      ? ''
      : new URLSearchParams(window.location.search).get('artifact') || '';
    if (!artifactId || loading) return;
    const target = actions.find((action) => action.id === artifactId);
    if (target) setSelected(target);
  }, [actions, loading]);

  // Re-sync selected action with the freshly loaded list (so last_run_at
  // updates after a Run, etc.). Without this, the panel keeps showing stale
  // data even after a refresh.
  useEffect(() => {
    if (!selected) return;
    const fresh = actions.find((a) => a.id === selected.id);
    if (fresh && fresh !== selected) setSelected(fresh);
  }, [actions, selected]);

  const startCreate = () => {
    setEditAction(null);
    setFormName('');
    setFormDescription('');
    setFormPrompt('');
    setFormAgentIds(agents[0] ? [agents[0].id] : []);
    setFormCron('');
    setFormEnabled(true);
    setFormMaxRuns(10);
    setFormTrigger('');
    setFormTriggerLabel('');
    setFormFolder(initWorkspaceFolderState(null));
    setFormErrors({});
    setShowForm(true);
  };

  const startEdit = (a: Action) => {
    setEditAction(a);
    setFormName(a.name);
    setFormDescription(a.description);
    setFormPrompt(a.prompt);
    setFormAgentIds(actionTargets(a));
    setFormCron(a.schedule_cron);
    setFormEnabled(a.enabled);
    setFormMaxRuns(a.max_runs);
    setFormTrigger(a.trigger || '');
    setFormTriggerLabel(a.trigger_label || '');
    setFormFolder(initWorkspaceFolderState(a));
    setFormErrors({});
    setShowForm(true);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditAction(null);
    setFormErrors({});
  };

  const handleSave = async () => {
    const errs: { name?: string; agent?: string } = {};
    if (!formName.trim()) errs.name = 'Name is required';
    if (formAgentIds.length === 0) errs.agent = '대상 에이전트를 1개 이상 선택하세요';
    setFormErrors(errs);
    if (errs.name || errs.agent) return;
    setSaving(true);
    try {
      const triggerPayload = {
        trigger: formTrigger,
        trigger_label: formTrigger === 'on_ticket_done' ? formTriggerLabel : '',
      };
      // build_mode는 Action 엔티티에 대응하는 개념이 없다(cold/warm build 개념 자체가 없음)
      // — 제거하고 workspace_folder/repo_ref/checkout_mode만 유지한다.
      const { build_mode: _buildMode, ...folderPayload } = buildWorkspaceFolderPayload(formFolder);
      if (editAction) {
        const updated = await api.updateAction(editAction.id, {
          workspace_id: effectiveWorkspaceId,
          name: formName.trim(),
          description: formDescription,
          prompt: formPrompt,
          target_agent_ids: formAgentIds,
          schedule_cron: formTrigger === 'on_ticket_done' ? '' : formCron,
          ...triggerPayload,
          enabled: formEnabled,
          max_runs: formMaxRuns,
          ...folderPayload,
        });
        showToast('Action updated', 'success');
        if (selected?.id === updated.id) setSelected(updated);
      } else {
        await api.createAction({
          workspace_id: effectiveWorkspaceId,
          name: formName.trim(),
          description: formDescription,
          prompt: formPrompt,
          target_agent_ids: formAgentIds,
          schedule_cron: formTrigger === 'on_ticket_done' ? '' : formCron,
          ...triggerPayload,
          enabled: formEnabled,
          max_runs: formMaxRuns,
          ...folderPayload,
        });
        showToast('Action created', 'success');
      }
      closeForm();
      await loadActions();
    } catch (err: any) {
      showToast(err?.message || 'Failed to save action', 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await api.deleteAction(deleteTarget.id, effectiveWorkspaceId);
      showToast('Action deleted', 'success');
      if (selected?.id === deleteTarget.id) setSelected(null);
      setDeleteTarget(null);
      await loadActions();
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete action', 'error');
    }
  };

  const handleRun = async (a: Action) => {
    setRunning(a.id);
    try {
      const result = await api.runAction(a.id);
      // fan-out (티켓 fc3906c5): 대상 일부가 디스패치에 실패해도 나머지는 떴다.
      // 성공한 것처럼만 알리면 실패한 호스트를 운영자가 놓친다.
      const dispatched = result.runs?.length ?? 1;
      const failed = result.failures?.length ?? 0;
      if (failed > 0) {
        showToast(`${dispatched}개 대상 실행, ${failed}개 실패 — 실행 이력에서 확인하세요`, 'error');
      } else if (dispatched > 1) {
        showToast(`${dispatched}개 대상에 실행을 디스패치했습니다`, 'success');
      } else {
        showToast(`Run dispatched (room ${result.room_id.slice(0, 8)})`, 'success');
      }
      await loadActions();
      // Select the action so the user sees the new run appear in history.
      setSelected(a);
    } catch (err: any) {
      showToast(err?.message || 'Failed to run action', 'error');
    } finally {
      setRunning(null);
    }
  };

  // `<Manager>/<Agent>` — never the bare name, so two managers running an
  // agent with the same short name stay distinguishable.
  const agentName = (id: string): string => {
    // 대상이 아예 없는 Action(설정 이상)에서 빈 문자열이 그대로 렌더돼
    // "Target: " 만 남는 것을 막는다.
    if (!id) return '(대상 없음)';
    const a = agents.find((x) => x.id === id);
    return a ? formatAgentDisplayName(a) : id.slice(0, 8);
  };

  if (selected) {
    return (
      <ActionDetail
        action={selected}
        agents={agents}
        workspaceId={effectiveWorkspaceId}
        onBack={() => setSelected(null)}
        onEdit={() => startEdit(selected)}
        onDelete={() => setDeleteTarget(selected)}
        onRun={() => handleRun(selected)}
        running={running === selected.id}
      />
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
        <span style={{ fontSize: 13, color: tokens.colors.textMuted }}>{actions.length} actions</span>
        <Button variant="primary" size="md" onClick={startCreate}>+ New Action</Button>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: tokens.colors.textSecondary, padding: 24 }}>Loading…</div>
      ) : actions.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '48px 24px' }}>
          <div style={{ fontSize: 18, fontWeight: 700, color: tokens.colors.textPrimary, marginBottom: 8 }}>No actions yet</div>
          <div style={{ fontSize: 13, color: tokens.colors.textSecondary }}>
            Define a prompt and pick a target agent. Each Run opens a chat room with the agent.
          </div>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
          gap: tokens.spacing.md,
        }}>
          {actions.map((a) => (
            <Card key={a.id} padding="12px 14px">
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 6 }}>
                <div style={{
                  width: 32,
                  height: 32,
                  borderRadius: tokens.radii.md,
                  background: `${tokens.colors.accent}20`,
                  color: tokens.colors.accent,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 12,
                  fontWeight: 700,
                  flexShrink: 0,
                }}>A</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <button
                      onClick={() => setSelected(a)}
                      style={{
                        background: 'none',
                        border: 'none',
                        padding: 0,
                        cursor: 'pointer',
                        textAlign: 'left',
                        fontSize: 13,
                        fontWeight: 600,
                        color: tokens.colors.textStrong,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        fontFamily: 'inherit',
                        flex: 1,
                      }}
                    >
                      {a.name}
                    </button>
                    {a.enabled ? <Badge variant="success">on</Badge> : <Badge variant="neutral">off</Badge>}
                  </div>
                  {a.description && (
                    <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginTop: 2, lineHeight: 1.4 }}>
                      {a.description}
                    </div>
                  )}
                </div>
              </div>

              <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
                Target: <span
                  style={{ color: tokens.colors.textSecondary }}
                  title={actionTargets(a).map(agentName).join('\n')}
                >
                  {/* 대상이 여럿이면 요약 + 툴팁으로 전체 목록 (티켓 fc3906c5). */}
                  {actionTargets(a).length > 1
                    ? `${actionTargets(a).length}개 에이전트`
                    : agentName(actionTargets(a)[0] || '')}
                </span>
                {a.trigger === 'on_ticket_done' ? (
                  <> · <Badge variant="info">on_ticket_done</Badge>
                    {a.trigger_label && <> · label: <span style={{ color: tokens.colors.textSecondary }}>{a.trigger_label}</span></>}
                  </>
                ) : a.schedule_cron ? (
                  <> · Cron: <code style={{ color: tokens.colors.textSecondary }}>{a.schedule_cron}</code></>
                ) : null}
              </div>
              {a.last_run_at && (
                <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6 }}>
                  Last run: {relativeTime(a.last_run_at)}
                </div>
              )}

              <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
                <Button variant="primary" size="sm" disabled={running === a.id} onClick={() => handleRun(a)}>
                  {running === a.id ? 'Running…' : 'Run'}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => setSelected(a)}>History</Button>
                <Button variant="secondary" size="sm" onClick={() => startEdit(a)}>Edit</Button>
                <Button variant="danger" size="sm" onClick={() => setDeleteTarget(a)}>Delete</Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      <Modal isOpen={showForm} onClose={closeForm} title={editAction ? 'Edit Action' : 'New Action'}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Input
            label="Name"
            value={formName}
            onChange={(e) => setFormName(e.target.value)}
            error={formErrors.name}
            autoFocus
          />
          <Input
            label="Description"
            value={formDescription}
            onChange={(e) => setFormDescription(e.target.value)}
            placeholder="Optional"
          />
          <div>
            <label style={{ display: 'block', fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
              대상 에이전트 {formErrors.agent && <span style={{ color: tokens.colors.danger }}>· {formErrors.agent}</span>}
            </label>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginBottom: 6, lineHeight: 1.5 }}>
              여러 개를 고르면 실행 1회가 대상마다 독립적인 run 을 만들어 각자의 방에서 병렬로 돕니다.
              한 대상이 실패해도 나머지는 그대로 진행됩니다.
            </div>
            <div
              data-testid="action-target-agents"
              style={{
                maxHeight: 180,
                overflowY: 'auto',
                background: tokens.colors.surface,
                border: `1px solid ${formErrors.agent ? tokens.colors.danger : tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '6px 8px',
              }}
            >
              {agents.length === 0 && (
                <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: '6px 2px' }}>
                  이 워크스페이스에 선택 가능한 에이전트가 없습니다.
                </div>
              )}
              {agents.map((a) => {
                const checked = formAgentIds.includes(a.id);
                return (
                  <label
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '5px 2px',
                      fontSize: 13,
                      color: tokens.colors.textStrong,
                      cursor: 'pointer',
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => setFormAgentIds((prev) => (
                        prev.includes(a.id) ? prev.filter((id) => id !== a.id) : [...prev, a.id]
                      ))}
                    />
                    {/* `<Manager>/<Agent>` — bare name 은 계약 위반이다(utils/agentName.ts). */}
                    <span>{formatAgentDisplayName(a)}</span>
                  </label>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 6 }}>
              선택됨: {formAgentIds.length}개
            </div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
              Trigger
            </label>
            <select
              value={formTrigger}
              onChange={(e) => setFormTrigger(e.target.value)}
              style={{
                width: '100%',
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                color: tokens.colors.textStrong,
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            >
              <option value="">Manual / Cron</option>
              <option value="on_ticket_done">On Ticket Done</option>
            </select>
          </div>
          {formTrigger === 'on_ticket_done' && (
            <>
              <Input
                label="Trigger label (optional)"
                value={formTriggerLabel}
                onChange={(e) => setFormTriggerLabel(e.target.value)}
                placeholder="Only fire when the done ticket has this label"
              />
            </>
          )}
          <div>
            <label style={{ display: 'block', fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
              Prompt template
            </label>
            <textarea
              value={formPrompt}
              onChange={(e) => setFormPrompt(e.target.value)}
              rows={6}
              placeholder="git commit & push the current changes on branch {{board.name}}"
              style={{
                width: '100%',
                resize: 'vertical',
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                color: tokens.colors.textStrong,
                fontSize: 13,
                fontFamily: 'inherit',
                lineHeight: 1.4,
              }}
            />
            <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4 }}>
              Variables: <code>{`{{action.name}}`}</code> <code>{`{{run.id}}`}</code> <code>{`{{workspace.name}}`}</code> <code>{`{{board.name}}`}</code> <code>{`{{user.name}}`}</code> <code>{`{{agent.name}}`}</code> <code>{`{{date}}`}</code> <code>{`{{time}}`}</code> <code>{`{{datetime}}`}</code>
            </div>
          </div>
          <WorkspaceFolderOptions
            kind="action"
            state={formFolder}
            onChange={(patch) => setFormFolder((s) => ({ ...s, ...patch }))}
            showBuildMode={false}
            workspaceId={effectiveWorkspaceId}
          />
          <div style={{ display: 'flex', gap: 12 }}>
            {formTrigger !== 'on_ticket_done' && (
              <Input
                label="Schedule (cron)"
                value={formCron}
                onChange={(e) => setFormCron(e.target.value)}
                placeholder="0 9 * * 1   (Mon 9am) — empty = manual"
                style={{ flex: 2 }}
              />
            )}
            <Input
              label="Max runs"
              type="number"
              value={String(formMaxRuns)}
              onChange={(e) => setFormMaxRuns(Math.max(1, parseInt(e.target.value, 10) || 10))}
              style={{ width: 100 }}
            />
            <div style={{ alignSelf: 'flex-end' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: tokens.colors.textSecondary, padding: '8px 0' }}>
                <input
                  type="checkbox"
                  checked={formEnabled}
                  onChange={(e) => setFormEnabled(e.target.checked)}
                />
                Enabled
              </label>
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button variant="secondary" onClick={closeForm}>Cancel</Button>
            <Button variant="primary" onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editAction ? 'Save Changes' : 'Create Action'}
            </Button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        isOpen={!!deleteTarget}
        title="Delete Action?"
        message={<>Delete <strong>{deleteTarget?.name}</strong>? All run history (rooms + messages) for this action will be removed.</>}
        onConfirm={handleDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}

// ─── Action detail ────────────────────────────────────────────────────────

interface ActionDetailProps {
  action: Action;
  agents: AgentOption[];
  workspaceId: string;
  onBack: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onRun: () => void | Promise<void>;
  running: boolean;
}

function ActionDetail({ action, agents, workspaceId, onBack, onEdit, onDelete, onRun, running }: ActionDetailProps) {
  const { user } = useAuth();
  const [runs, setRuns] = useState<ActionRun[]>([]);
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatRoomMessageItem[]>([]);
  const [participants, setParticipants] = useState<MentionParticipant[]>([]);
  const [participantCount, setParticipantCount] = useState(0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const loadRuns = useCallback(async () => {
    // fan-out (티켓 fc3906c5): 트리거 1회가 대상 수만큼 run 을 만드므로, 고정
    // 20건으로 가져오면 대상이 5개일 때 트리거 4회치밖에 안 보이고 경계에 걸린
    // 배치는 일부 run 만 실려 와 "전체 성공" 으로 잘못 보일 수 있다. 대상 수에
    // 비례해 늘려 배치 단위가 온전히 들어오게 한다(서버가 100 으로 캡한다).
    const targetCount = Math.max(1, actionTargets(action).length);
    const limit = Math.min(100, 20 * targetCount);
    const list = await api.listActionRuns(action.id, workspaceId, limit);
    setRuns(list);
    // Default selection: the most recent run.
    setActiveRunId((cur) => cur ?? (list[0]?.id ?? null));
  }, [action, workspaceId]);

  const activeRun = runs.find((r) => r.id === activeRunId) || null;
  const roomId = activeRun?.room_id || null;
  // Only user-triggered runs include the viewer as a participant. Scheduler/
  // agent runs require observer=true on read endpoints and disallow sends
  // entirely (the input is hidden in that case).
  const canSend = !!activeRun && activeRun.triggered_by_type === 'user';
  const observerMode = !canSend;

  const loadMessages = useCallback(async () => {
    if (!roomId) {
      setMessages([]);
      return;
    }
    setLoadingMessages(true);
    try {
      const msgs = await api.getChatRoomMessages(roomId, 100, undefined, observerMode);
      setMessages(msgs);
    } catch {
      setMessages([]);
    } finally {
      setLoadingMessages(false);
    }
  }, [roomId, observerMode]);

  useEffect(() => { loadRuns(); }, [loadRuns]);
  useEffect(() => { loadMessages(); }, [loadMessages]);

  // Fetch room participants so MessageList can render @mention pills with
  // proper display names and we know the participant count for the read-by
  // footer. Scheduler/agent runs need observer=true to bypass the
  // active-participant gate server-side.
  useEffect(() => {
    if (!roomId) {
      setParticipants([]);
      setParticipantCount(0);
      return;
    }
    api.getChatRoom(roomId, observerMode)
      .then((detail: any) => {
        const ps: MentionParticipant[] = (detail?.participants || []).map((p: any) => ({
          id: p.participant_id,
          name: p.participant_name || p.name,
          type: p.participant_type,
        }));
        setParticipants(ps);
        setParticipantCount(ps.filter((p) => p.type === 'user').length);
      })
      .catch(() => {
        setParticipants([]);
        setParticipantCount(0);
      });
  }, [roomId, observerMode]);

  // Light-touch refresh: poll for new messages every 5s while detail is open.
  // SSE wiring would be nicer but adds chat-stream subscription plumbing that
  // isn't needed for a first cut — the user can also click Refresh.
  useEffect(() => {
    if (!roomId) return;
    const t = setInterval(() => { loadMessages(); }, 5000);
    return () => clearInterval(t);
  }, [roomId, loadMessages]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  // ChatMessageInput posts the message itself and hands the resulting row
  // back via onSent. Append optimistically (dedup against the SSE/poll path)
  // so the bubble shows up instantly instead of after the next 5s poll.
  const handleMessageSent = useCallback((msg: ChatRoomMessageItem) => {
    setMessages((prev) => {
      if (prev.some((m) => m.id === msg.id)) return prev;
      return [...prev, msg];
    });
  }, []);

  const handleRunNow = async () => {
    await onRun();
    await loadRuns();
  };

  // `<Manager>/<Agent>` — bare `a.name` 은 계약 위반이다
  // (.claude/skills/awb-agent-display-name): 같은 leaf 이름이 여러 매니저 아래
  // 존재할 수 있어, fan-out 이력에서 어느 호스트가 실행했는지 구분하려면
  // 접두사가 반드시 있어야 한다.
  const agentName = (id: string): string => {
    if (!id) return '(에이전트 기록 없음)';
    const a = agents.find((x) => x.id === id);
    return a ? formatAgentDisplayName(a) : id.slice(0, 8);
  };

  const targetLabels = actionTargets(action).map(agentName);
  const batches = groupRunsIntoBatches(runs);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
        <Button variant="secondary" size="sm" onClick={onBack}>← Back</Button>
        <div style={{ flex: 1, fontSize: 16, fontWeight: 700, color: tokens.colors.textPrimary }}>
          {action.name}
        </div>
        <Button variant="primary" size="sm" disabled={running} onClick={handleRunNow}>
          {running ? 'Running…' : 'Run now'}
        </Button>
        <Button variant="secondary" size="sm" onClick={onEdit}>Edit</Button>
        <Button variant="danger" size="sm" onClick={onDelete}>Delete</Button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 12, flex: 1, minHeight: 0 }}>
        {/* Run list */}
        <div style={{
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          background: tokens.colors.surface,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
        }}>
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${tokens.colors.border}`, fontSize: 12, color: tokens.colors.textMuted }}>
            Recent runs ({runs.length}/{action.max_runs})
          </div>
          {/* 실행 이력은 배치(트리거 1회) 단위로 묶어 보여준다 (티켓 fc3906c5) —
              fan-out 이면 한 번의 실행이 run 을 여러 건 만들기 때문에, 평평한
              목록으로는 "이번 실행이 어디까지 성공했나" 를 읽을 수 없다. */}
          <div data-testid="action-run-history" style={{ flex: 1, overflow: 'auto', padding: 4 }}>
            {runs.length === 0 ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: 12 }}>
                No runs yet. Click <strong>Run now</strong> to dispatch one.
              </div>
            ) : batches.map((batch) => {
              const multi = batch.total > 1;
              const verdictLabel = batch.verdict === 'running'
                ? '진행 중'
                : batch.verdict === 'succeeded'
                  ? '전체 성공'
                  : batch.verdict === 'failed'
                    ? '전체 실패'
                    : `부분 실패 (${batch.succeeded}/${batch.total})`;
              const verdictVariant: 'success' | 'danger' | 'warning' | 'neutral' = batch.verdict === 'succeeded'
                ? 'success'
                : batch.verdict === 'failed'
                  ? 'danger'
                  : batch.verdict === 'partial'
                    ? 'warning'
                    : 'neutral';
              const head = batch.runs[0];
              return (
                <div key={batch.key} style={{ marginBottom: 6 }}>
                  {multi && (
                    <div
                      data-testid="action-run-batch-header"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 8px 2px',
                        fontSize: 11,
                        color: tokens.colors.textMuted,
                      }}
                    >
                      <span>{relativeTime(batch.latestAt)} · {head.triggered_by_type === 'system' ? 'scheduler' : head.triggered_by_type === 'agent' ? 'agent' : 'manual'}</span>
                      <Badge variant={verdictVariant}>{verdictLabel}</Badge>
                    </div>
                  )}
                  {batch.runs.map((r) => {
                    const active = r.id === activeRunId;
                    const status = r.status || 'running';
                    const icon = status === 'succeeded' ? '✅' : status === 'failed' ? '❌' : '⏳';
                    return (
                      <button
                        key={r.id}
                        onClick={() => setActiveRunId(r.id)}
                        style={{
                          display: 'block',
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          paddingLeft: multi ? 18 : 10,
                          background: active ? tokens.colors.surfaceHover : 'transparent',
                          border: 'none',
                          borderRadius: tokens.radii.sm,
                          color: active ? tokens.colors.textStrong : tokens.colors.textSecondary,
                          cursor: 'pointer',
                          fontFamily: 'inherit',
                          fontSize: 12,
                          marginBottom: 2,
                        }}
                      >
                        <div style={{ fontWeight: active ? 600 : 500 }}>
                          {icon} {agentName(r.agent_id || '')}
                        </div>
                        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
                          Run {r.id.slice(0, 8)}
                          {(r.attempt ?? 1) > 1 && <> · {r.attempt}회 시도</>}
                          {!multi && <> · {relativeTime(r.created_at)} · {r.triggered_by_type === 'system' ? 'scheduler' : r.triggered_by_type === 'agent' ? 'agent' : 'manual'}</>}
                        </div>
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>

        {/* Messages — uses the shared chat MessageList + ChatMessageInput so
            the history pane has multi-line input, file attachments, mentions
            and progress-row rendering for free. */}
        <div style={{
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.md,
          background: tokens.colors.surface,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          overflow: 'hidden',
        }}>
          <div style={{ padding: '8px 12px', borderBottom: `1px solid ${tokens.colors.border}`, fontSize: 12, color: tokens.colors.textMuted, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0 }}>
            <span>
              {/* 선택된 run 의 담당 에이전트를 우선 보여준다 — 대상이 여럿인
                  Action 에서 action 의 대표 대상만 박아두면 지금 보고 있는
                  대화의 상대와 어긋난다 (티켓 fc3906c5). */}
              Conversation with <strong>{
                activeRun?.agent_id
                  ? agentName(activeRun.agent_id)
                  : targetLabels.length > 1
                    ? `${targetLabels.length}개 에이전트`
                    : targetLabels[0] || '(대상 없음)'
              }</strong>
            </span>
            <Button variant="secondary" size="sm" onClick={() => loadMessages()}>Refresh</Button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
            {!activeRun ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, alignSelf: 'center', marginTop: 24 }}>
                Pick a run on the left to view its conversation.
              </div>
            ) : loadingMessages && messages.length === 0 ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, alignSelf: 'center', marginTop: 24 }}>
                Loading…
              </div>
            ) : messages.length === 0 ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, alignSelf: 'center', marginTop: 24 }}>
                No messages yet — agent is processing the prompt.
              </div>
            ) : (
              <MessageList
                messages={messages}
                participantCount={participantCount}
                participants={participants}
                currentUserId={user?.id}
              />
            )}
            <div ref={messagesEndRef} />
          </div>

          {activeRun && (
            canSend && roomId ? (
              <ChatMessageInput
                roomId={roomId}
                onSent={handleMessageSent}
                isMobile={false}
              />
            ) : (
              // Non-user-triggered runs (scheduler / agent-dispatched) have no
              // real user as a participant, so a reply would 403 on the
              // participant gate. Surface the read-only state instead of
              // letting the user type into a dead box.
              <div style={{ padding: 8, borderTop: `1px solid ${tokens.colors.border}`, fontSize: 12, color: tokens.colors.textMuted, textAlign: 'center', flexShrink: 0 }}>
                {activeRun.triggered_by_type === 'system' ? 'Scheduled run' : 'Agent-triggered run'} · read-only
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
