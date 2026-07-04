import React, { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../api';
import {
  Board, BoardWithCards, PromptTemplate, BoardMovePreview, MoveBlocker, MoveRemedy,
  EffortPreset, EffortPresetsConfig, EffortLevel, BUILTIN_EFFORT_PRESETS, Resource,
} from '../types';
import MoveBlockerList from './MoveBlockerList';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { useLoading } from '../contexts/LoadingContext';
import { useConfirm } from '../contexts/ConfirmContext';
import PageHeader from './PageHeader';
import ColumnManager from './ColumnManager';
import HarnessConfigEditor from './HarnessConfigEditor';
import EnvironmentConfigEditor from './EnvironmentConfigEditor';
import { QaPhaseRowsEditor, parseQaPhasesValue, qaPhasesError } from './QaPhasesEditor';
import { QaPhase } from '../types';
import { tokens } from '../tokens';
import { Button, Input, HeaderAction } from './common';

export default function BoardSettingsPage() {
  const { showToast } = useToast();
  const { withLoading } = useLoading();

  // Board and workspace identity come from the URL.
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();

  const {
    board, workspaceRoles, refresh,
    createColumn, updateColumn, deleteColumn,
  } = useBoard(boardId ?? '');

  // Prompt templates for the column→template selector. Loaded once per
  // workspace; ColumnManager renders a "(None)" option plus these.
  // Permission-gated on the server (MANAGE_PROMPT_TEMPLATES) — fall back
  // silently to an empty list so non-privileged users can still view
  // settings without a crash.
  const [promptTemplates, setPromptTemplates] = useState<PromptTemplate[]>([]);
  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    api.listPromptTemplates(wsId)
      .then((list) => { if (!cancelled) setPromptTemplates(list); })
      .catch(() => { if (!cancelled) setPromptTemplates([]); });
    return () => { cancelled = true; };
  }, [wsId]);

  // Repository resources for the Environment Setup repo dropdown (ticket
  // 354d336b). Workspace-scoped, type='repository'. Silent fall-back to []
  // so a non-privileged user can still view settings.
  const [repoResources, setRepoResources] = useState<Resource[]>([]);
  useEffect(() => {
    if (!wsId) return;
    let cancelled = false;
    api.listResources(wsId, undefined, 'repository')
      .then((rows) => { if (!cancelled) setRepoResources(rows || []); })
      .catch(() => { if (!cancelled) setRepoResources([]); });
    return () => { cancelled = true; };
  }, [wsId]);

  // Agents roster for the Default-role-holders picker (ticket d94a1b87). Silent
  // fall-back to [] so a non-privileged user can still view settings.
  const [agents, setAgents] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    api.getAgents()
      .then((rows) => { if (!cancelled) setAgents((rows || []).map((a: any) => ({ id: a.id, name: a.name }))); })
      .catch(() => { if (!cancelled) setAgents([]); });
    return () => { cancelled = true; };
  }, [wsId]);

  const wrap = async (fn: () => Promise<any>, okMsg?: string) => {
    try {
      await withLoading(fn);
      if (okMsg) showToast(okMsg, 'success');
    } catch (err: any) {
      showToast(err?.message || 'Operation failed', 'error');
    }
  };

  // Layout styles
  const pageStyle: React.CSSProperties = {
    padding: '24px',
    background: tokens.colors.surface,
    color: tokens.colors.textStrong,
    boxSizing: 'border-box',
  };

  if (!boardId) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader title="Board Settings" />
        <div style={pageStyle}>
          <div style={{ color: tokens.colors.textSecondary, fontSize: 14, marginBottom: 12 }}>No board selected.</div>
          <Button variant="secondary" size="sm" onClick={() => window.history.back()}>Go Back</Button>
        </div>
      </div>
    );
  }

  if (!board) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
        <PageHeader title="Board Settings" />
        <div style={pageStyle}>
          <div style={{ color: tokens.colors.textMuted, fontSize: 13 }}>Loading…</div>
        </div>
      </div>
    );
  }

  const routingConfig = (() => {
    try { return JSON.parse(board.routing_config || '{}'); } catch { return {}; }
  })();

  const columnPrompts: Record<string, string> = (() => {
    try { return JSON.parse(board.column_prompts || '{}'); } catch { return {}; }
  })();

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Board Settings"
        description={board.name}
        actions={
          wsId && boardId ? (
            <HeaderAction icon="←" label="Back to Board" to={`/ws/${wsId}/boards/${boardId}`} />
          ) : undefined
        }
      />
      <div style={{ ...pageStyle, flex: 1, overflow: 'auto', minHeight: 0 }}>
        <ConcurrencySetting
          board={board}
          onSave={async (n) => {
            await api.updateBoard(board.id, { max_concurrent_tickets_per_agent: n });
            await refresh();
            showToast('Concurrency limit saved', 'success');
          }}
        />
        <LanguageSetting
          board={board}
          onSave={async (language) => {
            await api.updateBoard(board.id, { language });
            await refresh();
            showToast(
              language ? `Output language set to ${language}` : 'Output language cleared (default)',
              'success',
            );
          }}
        />
        <SelfImprovementSetting
          board={board}
          onSave={async (mode) => {
            await api.updateBoard(board.id, { self_improvement_mode: mode });
            await refresh();
            showToast('Self-improvement mode saved', 'success');
          }}
        />
        <BenchmarkModeSetting
          board={board}
          onSave={async (mode) => {
            await api.updateBoard(board.id, { benchmark_mode: mode });
            await refresh();
            showToast(mode === 'on' ? 'Benchmark mode enabled' : 'Benchmark mode disabled', 'success');
          }}
        />
        <AutoArchiveSetting
          board={board}
          onSave={async (days) => {
            await api.updateBoard(board.id, { auto_archive_days: days });
            await refresh();
            showToast(
              days === null ? 'Auto-archive disabled' : `Auto-archive set to ${days} days`,
              'success',
            );
          }}
        />
        <HarnessConfigEditor
          raw={board.harness_config}
          title="Agent Harness (board override)"
          description={
            <>
              Per-board harness for subagents working tickets on this board: extra system prompt,
              tool allow/deny lists, model and permission mode. Keys set here override the
              workspace default <em>per key</em> at dispatch; unset keys inherit. Leave everything
              empty to fully inherit the workspace default (current behaviour).
            </>
          }
          onSave={async (config) => {
            try {
              await api.updateBoard(board.id, { harness_config: config });
              await refresh();
              showToast(config === null ? 'Board harness override cleared' : 'Board harness saved', 'success');
            } catch (err: any) {
              // Server zod rejection (400) surfaces its message here.
              showToast(err?.message || 'Failed to save harness', 'error');
            }
          }}
        />
        <EffortPresetsSetting
          board={board}
          onSave={async (config) => {
            await api.updateBoard(board.id, { effort_presets: config });
            await refresh();
            showToast(config === null ? 'Effort presets cleared' : 'Effort presets saved', 'success');
          }}
        />
        <QaPhasesSetting
          board={board}
          onSave={async (config) => {
            try {
              await api.updateBoard(board.id, { qa_phases: config });
              await refresh();
              showToast(config === null ? 'QA phases cleared' : 'QA phases saved', 'success');
            } catch (err: any) {
              // Server zod rejection (400) surfaces its message here.
              showToast(err?.message || 'Failed to save QA phases', 'error');
              throw err;
            }
          }}
        />
        <EnvironmentConfigEditor
          raw={board.environment_config}
          repoOptions={repoResources}
          onSave={async (config) => {
            try {
              await api.updateBoard(board.id, { environment_config: config });
              await refresh();
              showToast(config === null ? 'Environment setup cleared' : 'Environment setup saved', 'success');
            } catch (e: any) {
              // Server zod rejection (400) surfaces its message here.
              showToast(e?.message || 'Failed to save environment setup', 'error');
              throw e;
            }
          }}
        />
        <ColumnManager
          columns={board.columns}
          boardId={board.id}
          routingConfig={routingConfig}
          columnPrompts={columnPrompts}
          promptTemplates={promptTemplates}
          workspaceRoles={workspaceRoles}
          onCreateColumn={(bid, name, color) => wrap(() => createColumn(bid, name, color), 'Column created')}
          onUpdateColumn={(columnId, data) => wrap(() => updateColumn(columnId, data), 'Column updated')}
          onDeleteColumn={(columnId) => wrap(() => deleteColumn(columnId), 'Column deleted')}
          onUpdateRoutingConfig={async (config) => {
            await api.updateBoard(board.id, { routing_config: config });
            refresh();
          }}
          onUpdateColumnPrompts={async (next) => {
            // null clears all; empty object is equivalent per server contract.
            const payload = Object.keys(next).length === 0 ? null : next;
            await api.updateBoard(board.id, { column_prompts: payload });
            refresh();
          }}
        />
        <DefaultRoleHoldersEditor
          board={board}
          workspaceRoles={workspaceRoles}
          agents={agents}
          onSave={async (next) => {
            try {
              await api.updateBoard(board.id, { default_role_assignments: next });
              await refresh();
              showToast(next ? 'Default role holders saved' : 'Default role holders cleared', 'success');
            } catch (e: any) {
              // Server rejection (400 — unknown slug / missing agent) surfaces here.
              showToast(e?.message || 'Failed to save default role holders', 'error');
              throw e;
            }
          }}
        />
        <MoveToWorkspaceSetting board={board} sourceWorkspaceId={wsId ?? board.workspace_id} />
        <DeleteBoardSetting board={board} workspaceId={wsId ?? board.workspace_id} />
      </div>
    </div>
  );
}

interface DeleteBoardSettingProps {
  board: BoardWithCards;
  workspaceId: string;
}

// Hard board delete (ticket 2d6780a5). Mirrors the WorkspaceSelector delete
// pattern: confirm → DELETE /api/boards/:id (cascades to columns / tickets /
// subtasks / comments) → toast → navigate back to the workspace board list and
// fire `boards-changed` so AppLayout refreshes the sidebar. Irreversible — there
// is no archive/restore here (use the Archive page for soft archival instead).
function DeleteBoardSetting({ board, workspaceId }: DeleteBoardSettingProps) {
  const confirm = useConfirm();
  const navigate = useNavigate();
  const { showToast } = useToast();
  const [busy, setBusy] = useState(false);

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete board',
      message: `Delete “${board.name}”? The board and all its tickets will be permanently deleted. This cannot be undone.`,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteBoard(board.id);
      showToast('Board deleted', 'success');
      // Tell AppLayout to refetch the sidebar board list, then leave this now
      // stale board-scoped route for the workspace's board index.
      window.dispatchEvent(new Event('boards-changed'));
      navigate(`/ws/${workspaceId}/boards`);
    } catch (err: any) {
      showToast(err?.message || 'Failed to delete board', 'error');
      setBusy(false);
    }
  };

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.danger}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Delete board
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Permanently delete this board along with <strong>all of its columns, tickets, subtasks and
        comments</strong>. This cannot be undone — to hide a board without losing its tickets, archive
        it instead.
      </div>
      <Button variant="danger" size="sm" disabled={busy} onClick={handleDelete}>
        {busy ? 'Deleting…' : 'Delete board…'}
      </Button>
    </section>
  );
}

interface MoveToWorkspaceSettingProps {
  board: BoardWithCards;
  sourceWorkspaceId: string;
}

// Cross-workspace board move (ticket 8882056b). Admin-gated on the server.
// Flow: pick destination → Preview (dry-run, writes nothing) → review the
// move/copy/remap plan and any blockers → Move (commits atomically). A
// preview with blockers disables the commit button. carry_agents brings the
// board's companion agents along when they hold no roles outside this board.
function MoveToWorkspaceSetting({ board, sourceWorkspaceId }: MoveToWorkspaceSettingProps) {
  const { showToast } = useToast();
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string }>>([]);
  const [target, setTarget] = useState<string>('');
  const [carryAgents, setCarryAgents] = useState(false);
  // ticket 9efa643b — companion agents dropped from the carry via the inline
  // drop_companion_agent remedy. A move option, so it feeds every (re)preview.
  const [excludeAgentIds, setExcludeAgentIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<BoardMovePreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Destination candidates = every workspace except this board's own.
  useEffect(() => {
    let cancelled = false;
    api.getWorkspaces()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(
          (list || [])
            .filter((w: any) => w.id !== sourceWorkspaceId)
            .map((w: any) => ({ id: w.id, name: w.name })),
        );
      })
      .catch(() => { if (!cancelled) setWorkspaces([]); });
    return () => { cancelled = true; };
  }, [sourceWorkspaceId]);

  // Any change to the destination / carry choice invalidates a stale preview —
  // the operator must re-run Preview before they can commit. Changing either
  // also resets the per-agent carry exclusions (they were scoped to that plan).
  const onTargetChange = (id: string) => { setTarget(id); setPreview(null); setExcludeAgentIds([]); };
  const onCarryChange = (v: boolean) => { setCarryAgents(v); setPreview(null); setExcludeAgentIds([]); };

  // Preview honours optional overrides so an inline repreview-remedy can apply a
  // freshly-computed option (e.g. the just-extended exclude set) without racing
  // React's async setState.
  const runPreview = async (overrides?: { carryAgents?: boolean; excludeAgentIds?: string[] }) => {
    if (!target) return;
    setBusy(true);
    try {
      const report = await api.moveBoard(board.id, target, {
        dryRun: true,
        carryAgents: overrides?.carryAgents ?? carryAgents,
        excludeAgentIds: overrides?.excludeAgentIds ?? excludeAgentIds,
      });
      setPreview(report);
    } catch (err: any) {
      showToast(err?.message || 'Preview failed', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Inline blocker remedy. repreview → flip the carry-exclusion option locally
  // and re-preview (no write). mutation → call the remedy endpoint, then
  // re-preview so a resolved blocker drops off automatically.
  const onRemedy = async (_blocker: MoveBlocker, remedy: MoveRemedy) => {
    if (remedy.kind === 'repreview') {
      if (remedy.action === 'drop_companion_agent' && remedy.params?.agent_id) {
        const next = [...new Set([...excludeAgentIds, remedy.params.agent_id as string])];
        setExcludeAgentIds(next);
        await runPreview({ excludeAgentIds: next });
      }
      return;
    }
    // mutation
    setBusy(true);
    try {
      await api.moveBoardRemedy(board.id, remedy.action, remedy.params || {});
    } catch (err: any) {
      showToast(err?.message || 'Remedy failed', 'error');
      setBusy(false);
      return;
    }
    setBusy(false);
    await runPreview();
  };

  const runCommit = async () => {
    if (!target || !preview || preview.blockers.length > 0) return;
    setBusy(true);
    try {
      await api.moveBoard(board.id, target, { dryRun: false, carryAgents, excludeAgentIds });
      const destName = workspaces.find((w) => w.id === target)?.name || target;
      showToast(`Board moved to “${destName}”. Reloading…`, 'success');
      // The board now lives in another workspace; this URL's wsId is stale, so
      // bounce to the destination's board view rather than 404 in place.
      setConfirming(false);
      setPreview(null);
      setTimeout(() => { window.location.href = `/ws/${target}/boards`; }, 600);
    } catch (err: any) {
      showToast(err?.message || 'Move failed', 'error');
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const blocked = !!preview && preview.blockers.length > 0;

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.danger}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Move to workspace
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Move this board — with <strong>all its columns and tickets</strong> — to a different
        workspace. A workspace is a scope boundary, so the move re-stamps <code>workspace_id</code>
        on the board, every column and every ticket, remaps each ticket's role assignment to the
        destination's same-slug role, and copies referenced prompt templates / ws-level actions /
        resources / channels into the destination if absent (non-destructive). <strong>Always
        Preview first</strong> — it writes nothing and shows exactly what will move, copy, remap,
        or block. Admin-only.
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 240 }}>
          <label
            style={{
              display: 'block', fontSize: 11, color: tokens.colors.textMuted,
              marginBottom: 4, textTransform: 'uppercase', fontWeight: 600,
            }}
          >
            Destination workspace
          </label>
          <select
            value={target}
            onChange={(e) => onTargetChange(e.target.value)}
            style={{
              width: '100%', background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
              padding: '8px 10px', color: tokens.colors.textStrong, fontSize: 13,
              fontFamily: 'inherit', boxSizing: 'border-box',
            }}
          >
            <option value="">Select a workspace…</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: tokens.colors.textStrong, paddingBottom: 8 }}>
          <input type="checkbox" checked={carryAgents} onChange={(e) => onCarryChange(e.target.checked)} />
          Carry companion agents
        </label>
        <Button variant="secondary" size="sm" disabled={!target || busy} onClick={() => runPreview()}>
          {busy && !confirming ? 'Previewing…' : 'Preview'}
        </Button>
      </div>

      {preview && (
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12, color: tokens.colors.textStrong, marginBottom: 8 }}>
            Plan: <strong>{preview.counts.restamped}</strong> re-stamped ·{' '}
            <strong>{preview.counts.copied}</strong> copied ·{' '}
            <strong>{preview.counts.remapped}</strong> remapped ·{' '}
            {preview.counts.columns} columns, {preview.counts.tickets} tickets
            {preview.committed ? ' · committed' : ' · dry-run'}
          </div>

          <MoveBlockerList blockers={preview.blockers} busy={busy} onRemedy={onRemedy} />

          {preview.items.length > 0 && (
            <div
              style={{
                maxHeight: 220, overflow: 'auto', border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md, padding: '6px 8px', marginBottom: 10,
              }}
            >
              {preview.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', gap: 8, fontSize: 11, padding: '2px 0', color: tokens.colors.textStrong }}>
                  <span
                    style={{
                      flex: '0 0 64px', textTransform: 'uppercase', fontWeight: 600,
                      color: it.kind === 'block' ? tokens.colors.danger
                        : it.kind === 'warn' ? tokens.colors.textPrimary
                        : tokens.colors.textMuted,
                    }}
                  >
                    {it.kind}
                  </span>
                  <span style={{ flex: '0 0 110px', color: tokens.colors.textMuted }}>{it.entity}</span>
                  <span style={{ flex: 1 }}>{it.detail}</span>
                </div>
              ))}
            </div>
          )}

          {!confirming ? (
            <Button variant="danger" size="sm" disabled={blocked || busy} onClick={() => setConfirming(true)}>
              Move board to workspace…
            </Button>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: tokens.colors.textStrong }}>
                Commit this move? This applies atomically and cannot be auto-undone.
              </span>
              <Button variant="danger" size="sm" disabled={busy} onClick={runCommit}>
                {busy ? 'Moving…' : 'Confirm move'}
              </Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

type SelfImprovementMode = NonNullable<Board['self_improvement_mode']>;

// ─── Default role holders (ticket d94a1b87) ─────────────────────
// Per-board default assignee / reviewer / reporter (and any custom-role)
// holders. A freshly-created ticket fills every role the caller left unstaffed
// from this map, so a new ticket lands on the loop without a human wiring roles
// each time (the single most-repeated manual step in the board activity logs).
// Priority at create time: explicit holder > board default > unassigned.
type DefaultHolder = { agent_id?: string; user_id?: string };
type DefaultHolderMap = Record<string, DefaultHolder[]>;

// Parse the stored JSON map, keeping BOTH agent_id and user_id holders so a
// user_id set via MCP/REST survives an agent-only edit here.
function parseDefaultHolderMap(raw: string | null | undefined): DefaultHolderMap {
  if (!raw) return {};
  try {
    const obj = JSON.parse(raw);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
    const out: DefaultHolderMap = {};
    for (const [slug, holders] of Object.entries(obj as Record<string, unknown>)) {
      if (!Array.isArray(holders)) continue;
      const list: DefaultHolder[] = [];
      for (const h of holders) {
        if (!h || typeof h !== 'object') continue;
        const a = String((h as any).agent_id || '').trim();
        const u = String((h as any).user_id || '').trim();
        if (a) list.push({ agent_id: a });
        else if (u) list.push({ user_id: u });
      }
      if (list.length) out[slug] = list;
    }
    return out;
  } catch {
    return {};
  }
}

interface DefaultRoleHoldersEditorProps {
  board: BoardWithCards;
  workspaceRoles: Array<{ id: string; slug: string; name: string; is_builtin: boolean; position: number }>;
  agents: Array<{ id: string; name: string }>;
  onSave(next: DefaultHolderMap | null): Promise<void>;
}

function DefaultRoleHoldersEditor({ board, workspaceRoles, agents, onSave }: DefaultRoleHoldersEditorProps) {
  const [draft, setDraft] = useState<DefaultHolderMap>(() => parseDefaultHolderMap(board.default_role_assignments));
  const [busy, setBusy] = useState(false);

  // Re-seed when the persisted value changes (post-save refresh / board switch).
  useEffect(() => {
    setDraft(parseDefaultHolderMap(board.default_role_assignments));
  }, [board.default_role_assignments]);

  const roles = [...workspaceRoles].sort((a, b) => a.position - b.position);
  const agentName = (id: string) => agents.find((a) => a.id === id)?.name || id;

  const addAgent = (slug: string, agentId: string) => {
    if (!agentId) return;
    setDraft((prev) => {
      const list = prev[slug] ? [...prev[slug]] : [];
      if (list.some((h) => h.agent_id === agentId)) return prev; // no duplicates
      list.push({ agent_id: agentId });
      return { ...prev, [slug]: list };
    });
  };
  const removeHolder = (slug: string, idx: number) => {
    setDraft((prev) => {
      const list = (prev[slug] || []).filter((_, i) => i !== idx);
      const next = { ...prev };
      if (list.length) next[slug] = list;
      else delete next[slug];
      return next;
    });
  };

  // Only slugs carrying ≥1 holder are persisted; an all-empty map → null (clear).
  const buildPayload = (): DefaultHolderMap | null => {
    const out: DefaultHolderMap = {};
    for (const [slug, list] of Object.entries(draft)) {
      if (list && list.length) out[slug] = list;
    }
    return Object.keys(out).length ? out : null;
  };

  const labelStyle: React.CSSProperties = {
    display: 'block', fontSize: 11, color: tokens.colors.textMuted,
    marginBottom: 4, textTransform: 'uppercase', fontWeight: 600,
  };
  const chipStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 6, padding: '3px 8px',
    background: tokens.colors.surface, border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md, fontSize: 12, color: tokens.colors.textStrong,
  };

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Default role holders
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        When a ticket is created on this board, any role left unstaffed is filled from these defaults
        so the ticket lands on the loop without manual staffing. Explicit assignments always win;
        callers pass <code>skip_default_assignments</code> for a genuine zero-holder ticket. Applies to
        new tickets only — existing tickets are never changed. User holders set via the API are shown
        as <code>user:…</code> and preserved.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {roles.map((role) => {
          const holders = draft[role.slug] || [];
          const takenAgentIds = new Set(holders.map((h) => h.agent_id).filter(Boolean) as string[]);
          const available = agents.filter((a) => !takenAgentIds.has(a.id));
          return (
            <div key={role.id}>
              <label style={labelStyle}>{role.name} <span style={{ textTransform: 'none', opacity: 0.7 }}>({role.slug})</span></label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                {holders.length === 0 && (
                  <span style={{ fontSize: 12, color: tokens.colors.textMuted }}>No default — left unassigned.</span>
                )}
                {holders.map((h, i) => (
                  <span key={`${role.slug}-${i}`} style={chipStyle}>
                    {h.agent_id ? agentName(h.agent_id) : `user:${h.user_id}`}
                    <button
                      type="button"
                      onClick={() => removeHolder(role.slug, i)}
                      title="Remove holder"
                      style={{
                        border: 'none', background: 'transparent', cursor: 'pointer',
                        color: tokens.colors.textMuted, fontSize: 13, lineHeight: 1, padding: 0,
                      }}
                    >
                      ✕
                    </button>
                  </span>
                ))}
                <select
                  value=""
                  onChange={(e) => { addAgent(role.slug, e.target.value); e.target.value = ''; }}
                  style={{
                    background: tokens.colors.surface,
                    border: `1px solid ${tokens.colors.border}`,
                    borderRadius: tokens.radii.md,
                    padding: '6px 8px',
                    color: tokens.colors.textStrong,
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                >
                  <option value="">+ Add agent…</option>
                  {available.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </div>
            </div>
          );
        })}
        {roles.length === 0 && (
          <div style={{ fontSize: 12, color: tokens.colors.textMuted }}>No workspace roles found.</div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <Button
          variant="primary"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(buildPayload());
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={busy || Object.keys(draft).length === 0}
          onClick={() => setDraft({})}
        >
          Clear all
        </Button>
      </div>
    </section>
  );
}

// ─── Output language (i18n) ─────────────────────────────────────
// Per-board language for agent output. The stored value is the human-readable
// language NAME that drops straight into the agent's system prompt at dispatch
// (e.g. "Korean"), so the dropdown values are English language names; the
// labels show the native form for the operator. "" = unset (agent default,
// English). "__custom__" reveals a free-text box for any language not listed.
interface LanguageSettingProps {
  board: BoardWithCards;
  onSave(language: string | null): Promise<void>;
}

const LANGUAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '',         label: '미지정 (기본 — English)' },
  { value: 'Korean',   label: '한국어 (Korean)' },
  { value: 'English',  label: 'English' },
  { value: 'Japanese', label: '日本語 (Japanese)' },
  { value: 'Chinese',  label: '中文 (Chinese)' },
  { value: 'Spanish',  label: 'Español (Spanish)' },
  { value: 'French',   label: 'Français (French)' },
  { value: 'German',   label: 'Deutsch (German)' },
];

const LANGUAGE_CUSTOM = '__custom__';

function LanguageSetting({ board, onSave }: LanguageSettingProps) {
  const initial = (board.language || '').trim();
  const isPreset = (v: string) => LANGUAGE_OPTIONS.some((o) => o.value === v);
  // When the stored language isn't one of the presets, start in custom mode.
  const [selection, setSelection] = useState<string>(isPreset(initial) ? initial : LANGUAGE_CUSTOM);
  const [custom, setCustom] = useState<string>(isPreset(initial) ? '' : initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = (board.language || '').trim();
    setSelection(isPreset(next) ? next : LANGUAGE_CUSTOM);
    setCustom(isPreset(next) ? '' : next);
  }, [board.language]);

  const resolved = (selection === LANGUAGE_CUSTOM ? custom : selection).trim();
  const dirty = resolved !== initial;

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Output language
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Agents dispatched on this board write their ticket comments, chat messages, commit messages,
        and code comments in this language. Leave unset to keep the agent default (English). Applies
        to every role on the board. Best-effort on the Claude harness (rides
        <code>--append-system-prompt</code>); other CLIs may not honour it.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 220 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              color: tokens.colors.textMuted,
              marginBottom: 4,
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Language
          </label>
          <select
            value={selection}
            onChange={(e) => setSelection(e.target.value)}
            style={{
              width: '100%',
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 10px',
              color: tokens.colors.textStrong,
              fontSize: 13,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          >
            {LANGUAGE_OPTIONS.map((o) => (
              <option key={o.value || '__unset__'} value={o.value}>{o.label}</option>
            ))}
            <option value={LANGUAGE_CUSTOM}>기타 (직접입력)…</option>
          </select>
        </div>
        {selection === LANGUAGE_CUSTOM && (
          <div style={{ minWidth: 220 }}>
            <label
              style={{
                display: 'block',
                fontSize: 11,
                color: tokens.colors.textMuted,
                marginBottom: 4,
                textTransform: 'uppercase',
                fontWeight: 600,
              }}
            >
              Custom language name
            </label>
            <input
              type="text"
              value={custom}
              placeholder="e.g. Italian"
              onChange={(e) => setCustom(e.target.value)}
              style={{
                width: '100%',
                background: tokens.colors.surface,
                border: `1px solid ${tokens.colors.border}`,
                borderRadius: tokens.radii.md,
                padding: '8px 10px',
                color: tokens.colors.textStrong,
                fontSize: 13,
                fontFamily: 'inherit',
                boxSizing: 'border-box',
              }}
            />
          </div>
        )}
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy}
          onClick={async () => {
            if (!dirty) return;
            setBusy(true);
            try {
              await onSave(resolved ? resolved : null);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

interface SelfImprovementSettingProps {
  board: BoardWithCards;
  onSave(mode: SelfImprovementMode): Promise<void>;
}

const SELF_IMPROVEMENT_MODE_OPTIONS: Array<{ value: SelfImprovementMode; label: string; hint: string }> = [
  { value: 'off',        label: 'Off',                  hint: 'No post-done retrospective on this board.' },
  { value: 'same_board', label: 'Same board',           hint: 'Reviewer files improvement tickets on THIS board after Done.' },
  { value: 'remote_awb', label: 'Remote AWB',           hint: 'Reviewer files improvement tickets on the remote AWB target (see Admin → Settings).' },
  { value: 'both',       label: 'Both (same + remote)', hint: 'Reviewer may file on either this board or the remote AWB target, at its discretion.' },
];

function SelfImprovementSetting({ board, onSave }: SelfImprovementSettingProps) {
  const initial: SelfImprovementMode = (board.self_improvement_mode || 'off') as SelfImprovementMode;
  const [value, setValue] = useState<SelfImprovementMode>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValue((board.self_improvement_mode || 'off') as SelfImprovementMode);
  }, [board.self_improvement_mode]);

  const dirty = value !== initial;
  const hint = SELF_IMPROVEMENT_MODE_OPTIONS.find((o) => o.value === value)?.hint;

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Self-improvement mode
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        When a ticket lands in a terminal column on this board, the reviewer is dispatched once
        more to analyse the work and (optionally) file a follow-up improvement ticket. Choose
        where those improvement tickets land. Tickets carrying the <code>self-improvement</code>
        label are skipped here to prevent recursion.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 220 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              color: tokens.colors.textMuted,
              marginBottom: 4,
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Mode
          </label>
          <select
            value={value}
            onChange={(e) => setValue(e.target.value as SelfImprovementMode)}
            style={{
              width: '100%',
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 10px',
              color: tokens.colors.textStrong,
              fontSize: 13,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          >
            {SELF_IMPROVEMENT_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy}
          onClick={async () => {
            if (!dirty) return;
            setBusy(true);
            try {
              await onSave(value);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 10 }}>
          {hint}
        </div>
      )}
    </section>
  );
}

// ─── Effort presets ─────────────────────────────────────────────
// Abstract per-board effort presets → per-CLI option mapping. The ticket
// carries only the abstract preset id; the server resolves it into per-CLI
// options at dispatch. Claude gets effort + ultracode + model; codex /
// antigravity get model-only. Starts from the board's stored presets, else
// BUILTIN_EFFORT_PRESETS. Save writes the whole config (or null to clear the
// override and fall back to the builtins on the server).
const EFFORT_LEVELS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max'];

// Read path — degrade malformed / empty input to the builtins, never throw
// (mirror the server READ contract). Accepts either the parsed config or the
// raw JSON string the board ships.
function parseEffortPresets(raw: Board['effort_presets']): EffortPresetsConfig {
  if (!raw) return cloneEffortConfig(BUILTIN_EFFORT_PRESETS);
  let cfg: any = raw;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return cloneEffortConfig(BUILTIN_EFFORT_PRESETS);
    try { cfg = JSON.parse(trimmed); } catch { return cloneEffortConfig(BUILTIN_EFFORT_PRESETS); }
  }
  if (!cfg || !Array.isArray(cfg.presets) || cfg.presets.length === 0) {
    return cloneEffortConfig(BUILTIN_EFFORT_PRESETS);
  }
  const presets: EffortPreset[] = cfg.presets
    .filter((p: any) => p && typeof p.id === 'string')
    .map((p: any) => ({
      id: String(p.id),
      label: typeof p.label === 'string' && p.label ? p.label : String(p.id),
      ...(p.claude ? { claude: { ...p.claude } } : {}),
      ...(p.codex ? { codex: { ...p.codex } } : {}),
      ...(p.antigravity ? { antigravity: { ...p.antigravity } } : {}),
    }));
  if (presets.length === 0) return cloneEffortConfig(BUILTIN_EFFORT_PRESETS);
  const def = typeof cfg.default === 'string' && presets.some((p) => p.id === cfg.default)
    ? cfg.default
    : presets[0].id;
  return { default: def, presets };
}

function cloneEffortConfig(cfg: EffortPresetsConfig): EffortPresetsConfig {
  return JSON.parse(JSON.stringify(cfg));
}

interface EffortPresetsSettingProps {
  board: BoardWithCards;
  onSave(config: EffortPresetsConfig | null): Promise<void>;
}

function EffortPresetsSetting({ board, onSave }: EffortPresetsSettingProps) {
  const initial = parseEffortPresets(board.effort_presets);
  const [config, setConfig] = useState<EffortPresetsConfig>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setConfig(parseEffortPresets(board.effort_presets));
  }, [board.effort_presets]);

  const dirty = JSON.stringify(config) !== JSON.stringify(initial);

  // Mutate a single preset by index, returning a fresh config so React re-renders.
  const updatePreset = (idx: number, patch: Partial<EffortPreset>) => {
    setConfig((prev) => {
      const presets = prev.presets.map((p, i) => (i === idx ? { ...p, ...patch } : p));
      return { ...prev, presets };
    });
  };

  // Patch a CLI sub-object (claude/codex/antigravity), pruning empty objects so
  // the saved config stays clean (mirror the server WRITE-side normalization).
  const updateCli = (
    idx: number,
    cli: 'claude' | 'codex' | 'antigravity',
    patch: Record<string, any>,
  ) => {
    setConfig((prev) => {
      const presets = prev.presets.map((p, i) => {
        if (i !== idx) return p;
        const next: any = { ...(p as any)[cli], ...patch };
        // Drop keys whose value is empty so we don't persist noise.
        for (const k of Object.keys(next)) {
          if (next[k] === '' || next[k] === undefined || next[k] === false) delete next[k];
        }
        const merged: any = { ...p };
        if (Object.keys(next).length === 0) delete merged[cli];
        else merged[cli] = next;
        return merged;
      });
      return { ...prev, presets };
    });
  };

  const addPreset = () => {
    setConfig((prev) => {
      // Generate a unique slug.
      let n = prev.presets.length + 1;
      let id = `preset-${n}`;
      const ids = new Set(prev.presets.map((p) => p.id));
      while (ids.has(id)) { n += 1; id = `preset-${n}`; }
      return {
        ...prev,
        presets: [...prev.presets, { id, label: `Preset ${n}`, claude: { effort: 'medium' } }],
      };
    });
  };

  const removePreset = (idx: number) => {
    setConfig((prev) => {
      const presets = prev.presets.filter((_, i) => i !== idx);
      // Keep `default` valid — if it pointed at the removed row, fall back to
      // the first remaining preset (or '' when the list is now empty).
      const removedId = prev.presets[idx]?.id;
      const def = prev.default === removedId ? (presets[0]?.id || '') : prev.default;
      return { default: def, presets };
    });
  };

  const sectionStyle: React.CSSProperties = {
    padding: 16,
    marginBottom: 16,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
  };
  const fieldLabel: React.CSSProperties = {
    display: 'block', fontSize: 10, color: tokens.colors.textMuted,
    marginBottom: 3, textTransform: 'uppercase', fontWeight: 600,
  };
  const inputStyle: React.CSSProperties = {
    width: '100%', background: tokens.colors.surface,
    border: `1px solid ${tokens.colors.border}`, borderRadius: tokens.radii.md,
    padding: '6px 8px', color: tokens.colors.textStrong, fontSize: 12,
    fontFamily: 'inherit', boxSizing: 'border-box',
  };

  return (
    <section style={sectionStyle}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Effort presets
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Abstract effort options a ticket can carry. Each preset maps to per-CLI options at dispatch:
        Claude gets <code>--effort</code>, the <code>ultracode</code> orchestration keyword, and an
        optional model; Codex and Antigravity get model-only (other keys are gracefully skipped).
        Tickets reference a preset by name; clearing falls back to the built-in presets.
      </div>

      {/* Default preset picker */}
      <div style={{ marginBottom: 14, maxWidth: 260 }}>
        <label style={fieldLabel}>Default preset</label>
        <select
          value={config.default}
          onChange={(e) => setConfig((prev) => ({ ...prev, default: e.target.value }))}
          style={inputStyle}
          disabled={config.presets.length === 0}
        >
          {config.presets.map((p) => (
            <option key={p.id} value={p.id}>{p.label || p.id}</option>
          ))}
        </select>
      </div>

      {/* Preset rows */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {config.presets.map((p, idx) => (
          <div
            key={idx}
            style={{
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: 12,
              background: tokens.colors.surface,
            }}
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', marginBottom: 8 }}>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>Label</label>
                <input
                  value={p.label}
                  onChange={(e) => updatePreset(idx, { label: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ flex: 1 }}>
                <label style={fieldLabel}>Id (slug)</label>
                <input
                  value={p.id}
                  onChange={(e) => updatePreset(idx, { id: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => removePreset(idx)}
              >
                Remove
              </Button>
            </div>

            {/* Claude options */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 8 }}>
              <div>
                <label style={fieldLabel}>Claude effort</label>
                <select
                  value={p.claude?.effort || ''}
                  onChange={(e) => updateCli(idx, 'claude', { effort: e.target.value })}
                  style={inputStyle}
                >
                  <option value="">(none)</option>
                  {EFFORT_LEVELS.map((lvl) => (
                    <option key={lvl} value={lvl}>{lvl}</option>
                  ))}
                </select>
              </div>
              <div>
                <label style={fieldLabel}>Claude model</label>
                <input
                  value={p.claude?.model || ''}
                  placeholder="(CLI default)"
                  onChange={(e) => updateCli(idx, 'claude', { model: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 6 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: tokens.colors.textStrong, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={!!p.claude?.ultracode}
                    onChange={(e) => updateCli(idx, 'claude', { ultracode: e.target.checked })}
                  />
                  ultracode
                </label>
              </div>
            </div>

            {/* Codex / Antigravity model-only */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div>
                <label style={fieldLabel}>Codex model</label>
                <input
                  value={p.codex?.model || ''}
                  placeholder="(CLI default)"
                  onChange={(e) => updateCli(idx, 'codex', { model: e.target.value })}
                  style={inputStyle}
                />
              </div>
              <div>
                <label style={fieldLabel}>Antigravity model</label>
                <input
                  value={p.antigravity?.model || ''}
                  placeholder="(CLI default)"
                  onChange={(e) => updateCli(idx, 'antigravity', { model: e.target.value })}
                  style={inputStyle}
                />
              </div>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button variant="secondary" size="sm" onClick={addPreset}>
          Add preset
        </Button>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy}
          onClick={async () => {
            if (!dirty) return;
            setBusy(true);
            try {
              // Empty preset list → clear the board override (null), so the
              // server serializes an empty column and falls back to builtins.
              await onSave(config.presets.length === 0 ? null : config);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

// ─── QA phases (multi-phase QA model, ticket 90cc22f7) ──────────────────────
// A board can declare an ordered list of QA phases (e.g. import → build → run),
// each with its own timeout, so the QA reaper judges "is THIS phase overdue"
// instead of "is the whole run overdue". A scenario can override this per-scenario
// (QaManager scenario form). Empty list = clear the override (null) → legacy
// single-timeout behavior. Mirrors EffortPresetsSetting's read/edit/save shape.
interface QaPhasesSettingProps {
  board: BoardWithCards;
  onSave(config: { phases: QaPhase[] } | null): Promise<void>;
}

function QaPhasesSetting({ board, onSave }: QaPhasesSettingProps) {
  const initial = parseQaPhasesValue(board.qa_phases)?.phases ?? [];
  const [phases, setPhases] = useState<QaPhase[]>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPhases(parseQaPhasesValue(board.qa_phases)?.phases ?? []);
  }, [board.qa_phases]);

  const dirty = JSON.stringify(phases) !== JSON.stringify(initial);
  const validationError = qaPhasesError(phases);

  const sectionStyle: React.CSSProperties = {
    padding: 16,
    marginBottom: 16,
    background: tokens.colors.surfaceCard,
    border: `1px solid ${tokens.colors.border}`,
    borderRadius: tokens.radii.md,
  };

  return (
    <section style={sectionStyle}>
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        QA phases
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Ordered phases for QA runs on this board (e.g. <code>import</code> → <code>build</code> →
        <code>run</code>), each with its own timeout. The QA reaper applies the <em>current</em>{' '}
        phase's timeout from when it was entered, so a long build doesn't false-reap and a hung
        import is still caught. A scenario can override these per-scenario. Leave empty to clear the
        override — runs fall back to the single whole-run timeout (legacy behavior).
      </div>

      {phases.length === 0 && (
        <div style={{ fontSize: 12, color: tokens.colors.textSecondary, marginBottom: 10, fontStyle: 'italic' }}>
          No phases — this board uses the legacy single-timeout QA model.
        </div>
      )}

      <QaPhaseRowsEditor phases={phases} onChange={setPhases} />

      {validationError && (
        <div style={{ fontSize: 12, color: tokens.colors.danger, marginTop: 10 }}>
          {validationError}
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy || !!validationError}
          onClick={async () => {
            if (!dirty || validationError) return;
            setBusy(true);
            try {
              // Empty list → clear the board override (null) so the server stores
              // an empty column and runs fall back to the single-timeout model.
              await onSave(phases.length === 0 ? null : { phases });
            } catch {
              // onSave toasts; keep the editor dirty so the user can retry.
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </section>
  );
}

type BenchmarkMode = NonNullable<Board['benchmark_mode']>;

interface BenchmarkModeSettingProps {
  board: BoardWithCards;
  onSave(mode: BenchmarkMode): Promise<void>;
}

const BENCHMARK_MODE_OPTIONS: Array<{ value: BenchmarkMode; label: string; hint: string }> = [
  { value: 'off', label: 'Off',                 hint: 'Ordinary board — no benchmark scoring or leaderboard.' },
  { value: 'on',  label: 'On (benchmark host)', hint: 'Candidate children are scored by evaluator agents on Review entry; the Leaderboard panel renders on the board.' },
];

function BenchmarkModeSetting({ board, onSave }: BenchmarkModeSettingProps) {
  const initial: BenchmarkMode = (board.benchmark_mode || 'off') as BenchmarkMode;
  const [value, setValue] = useState<BenchmarkMode>(initial);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setValue((board.benchmark_mode || 'off') as BenchmarkMode);
  }, [board.benchmark_mode]);

  const dirty = value !== initial;
  const hint = BENCHMARK_MODE_OPTIONS.find((o) => o.value === value)?.hint;

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Benchmark mode
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Turn this board into a benchmark host. A run is a parent ticket holding the task; its
        candidate children are worked by different agents in isolated worktrees. When a candidate
        reaches a <code>review</code> column, the run's evaluator agents score it. The Leaderboard
        panel aggregates per-candidate and per-agent scores.
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ minWidth: 220 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              color: tokens.colors.textMuted,
              marginBottom: 4,
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Mode
          </label>
          <select
            value={value}
            onChange={(e) => setValue(e.target.value as BenchmarkMode)}
            style={{
              width: '100%',
              background: tokens.colors.surface,
              border: `1px solid ${tokens.colors.border}`,
              borderRadius: tokens.radii.md,
              padding: '8px 10px',
              color: tokens.colors.textStrong,
              fontSize: 13,
              fontFamily: 'inherit',
              boxSizing: 'border-box',
            }}
          >
            {BENCHMARK_MODE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy}
          onClick={async () => {
            if (!dirty) return;
            setBusy(true);
            try {
              await onSave(value);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
      {hint && (
        <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 10 }}>
          {hint}
        </div>
      )}
    </section>
  );
}

interface AutoArchiveSettingProps {
  board: BoardWithCards;
  onSave(days: number | null): Promise<void>;
}

// Default days input when the operator first enables auto-archive. Stays
// 30 unless they explicitly change it; mirrors the spec's recommendation.
const AUTO_ARCHIVE_DEFAULT_DAYS = 30;

function AutoArchiveSetting({ board, onSave }: AutoArchiveSettingProps) {
  // null/undefined on the board → disabled. Stash the most-recently-seen
  // days value so the input retains its number when the user toggles off
  // and back on without saving in between.
  const initialDays = board.auto_archive_days ?? null;
  const [enabled, setEnabled] = useState<boolean>(initialDays !== null);
  const [days, setDays] = useState<string>(
    String(initialDays ?? AUTO_ARCHIVE_DEFAULT_DAYS),
  );
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const next = board.auto_archive_days ?? null;
    setEnabled(next !== null);
    setDays(String(next ?? AUTO_ARCHIVE_DEFAULT_DAYS));
  }, [board.auto_archive_days]);

  const parsed = Math.floor(Number(days));
  const validDays = Number.isFinite(parsed) && parsed >= 1 && parsed <= 365;
  const initialEnabled = initialDays !== null;
  const dirty = enabled !== initialEnabled
    || (enabled && validDays && parsed !== initialDays);
  const saveDisabled = busy || !dirty || (enabled && !validDays);

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Auto-archive Done tickets
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Hourly sweep that soft-archives root tickets in a terminal column that
        have been <strong>idle for N days</strong> — no entry into Done, edit, or
        comment in that window (a still-discussed ticket keeps resetting the
        clock). Archived tickets are excluded from the board view, SSE updates,
        agent triggers, and focus selection, but remain restorable from the
        dedicated Archive page. Disabled by default.
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, color: tokens.colors.textStrong }}>
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Enable auto-archive
        </label>
        <div style={{ width: 140 }}>
          <Input
            label="Archive after (days)"
            type="number"
            min={1}
            max={365}
            value={days}
            disabled={!enabled}
            onChange={(e) => setDays(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={saveDisabled}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave(enabled ? parsed : null);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {enabled && !validDays && (
          <span style={{ fontSize: 11, color: tokens.colors.danger }}>
            Must be 1–365
          </span>
        )}
      </div>
    </section>
  );
}

interface ConcurrencySettingProps {
  board: BoardWithCards;
  onSave(n: number): Promise<void>;
}

function ConcurrencySetting({ board, onSave }: ConcurrencySettingProps) {
  const initial = Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent ?? 1));
  const [value, setValue] = useState<string>(String(initial));
  const [busy, setBusy] = useState(false);

  // Re-sync the input if the board prop refreshes (e.g. after another tab
  // raised the limit). Avoids the field looking stale after a refresh.
  useEffect(() => {
    setValue(String(Math.max(1, Math.floor(board.max_concurrent_tickets_per_agent ?? 1))));
  }, [board.max_concurrent_tickets_per_agent]);

  const parsed = Math.floor(Number(value));
  const valid = Number.isFinite(parsed) && parsed >= 1;
  const dirty = valid && parsed !== initial;

  return (
    <section
      style={{
        padding: 16,
        marginBottom: 16,
        background: tokens.colors.surfaceCard,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.md,
      }}
    >
      <h3 style={{ margin: 0, fontSize: 13, fontWeight: 600, color: tokens.colors.textPrimary }}>
        Agent concurrency
      </h3>
      <div style={{ fontSize: 11, color: tokens.colors.textMuted, marginTop: 4, marginBottom: 12 }}>
        Max distinct tickets one agent can be actively working on at once on this board.
        Default <strong>1</strong> — same agent assigned to multiple tickets would otherwise
        spawn parallel subagents that stomp on the same working_dir. Raise only when concurrent
        local-repo work is genuinely safe (e.g. a read-only review queue).
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
        <div style={{ width: 120 }}>
          <Input
            label="Max tickets / agent"
            type="number"
            min={1}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
        </div>
        <Button
          variant="primary"
          size="sm"
          disabled={!dirty || busy || !valid}
          onClick={async () => {
            if (!valid || !dirty) return;
            setBusy(true);
            try {
              await onSave(parsed);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : 'Save'}
        </Button>
        {!valid && (
          <span style={{ fontSize: 11, color: tokens.colors.danger, alignSelf: 'center' }}>
            Must be ≥ 1
          </span>
        )}
      </div>
    </section>
  );
}
