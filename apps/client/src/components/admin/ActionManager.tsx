import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, getActiveWorkspaceId } from '../../api';
import type { Action, ActionRun, ChatRoomMessageItem } from '../../types';
import { useToast } from '../../contexts/ToastContext';
import { useAuth } from '../../contexts/AuthContext';
import { tokens } from '../../tokens';
import { Button, Input, Modal, Card, Badge, ConfirmDialog } from '../common';
import { relativeTime } from '../../utils/time';
import MessageList from '../chat/MessageList';
import ChatMessageInput from '../chat/ChatMessageInput';
import type { MentionParticipant } from '../chat/utils/markdown';

interface AgentOption {
  id: string;
  name: string;
}

interface BoardOption {
  id: string;
  name: string;
}

interface ActionManagerProps {
  workspaceId?: string;
  boardId?: string | null;
}

export default function ActionManager({ workspaceId, boardId }: ActionManagerProps) {
  const { showToast } = useToast();
  const effectiveWorkspaceId = workspaceId || (getActiveWorkspaceId() || '');

  const [actions, setActions] = useState<Action[]>([]);
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [boards, setBoards] = useState<BoardOption[]>([]);
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
  const [formAgentId, setFormAgentId] = useState('');
  const [formCron, setFormCron] = useState('');
  const [formEnabled, setFormEnabled] = useState(true);
  const [formMaxRuns, setFormMaxRuns] = useState(10);
  const [formTrigger, setFormTrigger] = useState('');
  const [formTriggerLabel, setFormTriggerLabel] = useState('');
  const [formTriggerBoardId, setFormTriggerBoardId] = useState<string | null>(null);
  const [formErrors, setFormErrors] = useState<{ name?: string; agent?: string }>({});

  const loadActions = useCallback(async () => {
    if (!effectiveWorkspaceId) {
      setActions([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [list, agentList, boardList] = await Promise.all([
        api.listActions(effectiveWorkspaceId, boardId !== undefined ? (boardId || '') : undefined),
        api.getAgents(effectiveWorkspaceId).catch(() => [] as any[]),
        api.getBoards(effectiveWorkspaceId).catch(() => [] as any[]),
      ]);
      setActions(list);
      setAgents((agentList as any[]).map((a) => ({ id: a.id, name: a.name })));
      setBoards((boardList as any[]).map((b: any) => ({ id: b.id, name: b.name })));
    } catch (err: any) {
      showToast(err?.message || 'Failed to load actions', 'error');
    } finally {
      setLoading(false);
    }
  }, [effectiveWorkspaceId, boardId, showToast]);

  useEffect(() => { loadActions(); }, [loadActions]);

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
    setFormAgentId(agents[0]?.id ?? '');
    setFormCron('');
    setFormEnabled(true);
    setFormMaxRuns(10);
    setFormTrigger('');
    setFormTriggerLabel('');
    setFormTriggerBoardId(null);
    setFormErrors({});
    setShowForm(true);
  };

  const startEdit = (a: Action) => {
    setEditAction(a);
    setFormName(a.name);
    setFormDescription(a.description);
    setFormPrompt(a.prompt);
    setFormAgentId(a.target_agent_id);
    setFormCron(a.schedule_cron);
    setFormEnabled(a.enabled);
    setFormMaxRuns(a.max_runs);
    setFormTrigger(a.trigger || '');
    setFormTriggerLabel(a.trigger_label || '');
    setFormTriggerBoardId(a.trigger === 'on_ticket_done' ? (a.board_id || null) : null);
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
    if (!formAgentId) errs.agent = 'Pick a target agent';
    setFormErrors(errs);
    if (errs.name || errs.agent) return;
    setSaving(true);
    try {
      const triggerPayload = {
        trigger: formTrigger,
        trigger_label: formTrigger === 'on_ticket_done' ? formTriggerLabel : '',
      };
      const effectiveBoardId = formTrigger === 'on_ticket_done'
        ? (formTriggerBoardId || null)
        : (boardId !== undefined ? (boardId || null) : undefined);
      if (editAction) {
        const updated = await api.updateAction(editAction.id, {
          workspace_id: effectiveWorkspaceId,
          name: formName.trim(),
          description: formDescription,
          prompt: formPrompt,
          target_agent_id: formAgentId,
          board_id: effectiveBoardId,
          schedule_cron: formTrigger === 'on_ticket_done' ? '' : formCron,
          ...triggerPayload,
          enabled: formEnabled,
          max_runs: formMaxRuns,
        });
        showToast('Action updated', 'success');
        if (selected?.id === updated.id) setSelected(updated);
      } else {
        await api.createAction({
          workspace_id: effectiveWorkspaceId,
          board_id: effectiveBoardId ?? null,
          name: formName.trim(),
          description: formDescription,
          prompt: formPrompt,
          target_agent_id: formAgentId,
          schedule_cron: formTrigger === 'on_ticket_done' ? '' : formCron,
          ...triggerPayload,
          enabled: formEnabled,
          max_runs: formMaxRuns,
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
      showToast(`Run dispatched (room ${result.room_id.slice(0, 8)})`, 'success');
      await loadActions();
      // Select the action so the user sees the new run appear in history.
      setSelected(a);
    } catch (err: any) {
      showToast(err?.message || 'Failed to run action', 'error');
    } finally {
      setRunning(null);
    }
  };

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

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
                Target: <span style={{ color: tokens.colors.textSecondary }}>{agentName(a.target_agent_id)}</span>
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
              Target Agent {formErrors.agent && <span style={{ color: tokens.colors.danger }}>· {formErrors.agent}</span>}
            </label>
            <select
              value={formAgentId}
              onChange={(e) => setFormAgentId(e.target.value)}
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
              <option value="">— select an agent —</option>
              {agents.map((a) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
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
              <div>
                <label style={{ display: 'block', fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 4 }}>
                  Board scope
                </label>
                <select
                  value={formTriggerBoardId ?? ''}
                  onChange={(e) => setFormTriggerBoardId(e.target.value || null)}
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
                  <option value="">Any board in workspace</option>
                  {boards.map((b) => (
                    <option key={b.id} value={b.id}>{b.name}</option>
                  ))}
                </select>
              </div>
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
    const list = await api.listActionRuns(action.id, workspaceId, 20);
    setRuns(list);
    // Default selection: the most recent run.
    setActiveRunId((cur) => cur ?? (list[0]?.id ?? null));
  }, [action.id, workspaceId]);

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

  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id.slice(0, 8);

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
          <div style={{ flex: 1, overflow: 'auto', padding: 4 }}>
            {runs.length === 0 ? (
              <div style={{ fontSize: 12, color: tokens.colors.textMuted, padding: 12 }}>
                No runs yet. Click <strong>Run now</strong> to dispatch one.
              </div>
            ) : runs.map((r) => {
              const active = r.id === activeRunId;
              return (
                <button
                  key={r.id}
                  onClick={() => setActiveRunId(r.id)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '8px 10px',
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
                    Run {r.id.slice(0, 8)}
                  </div>
                  <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 2 }}>
                    {relativeTime(r.created_at)} · {r.triggered_by_type === 'system' ? 'scheduler' : r.triggered_by_type === 'agent' ? 'agent' : 'manual'}
                  </div>
                </button>
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
              Conversation with <strong>{agentName(action.target_agent_id)}</strong>
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
