import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { Board, PromptTemplate } from '../types';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { useLoading } from '../contexts/LoadingContext';
import PageHeader from './PageHeader';
import ColumnManager from './ColumnManager';
import { tokens } from '../tokens';
import { Button, Input } from './common';

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
        <SelfImprovementSetting
          board={board}
          onSave={async (mode) => {
            await api.updateBoard(board.id, { self_improvement_mode: mode });
            await refresh();
            showToast('Self-improvement mode saved', 'success');
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
      </div>
    </div>
  );
}

type SelfImprovementMode = NonNullable<Board['self_improvement_mode']>;

interface SelfImprovementSettingProps {
  board: Board;
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

interface AutoArchiveSettingProps {
  board: Board;
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
        Hourly sweep that soft-archives root tickets sitting in a terminal column
        for longer than <strong>N</strong> days. Archived tickets are excluded
        from the board view, SSE updates, agent triggers, and focus selection,
        but remain restorable from the dedicated Archive page. Disabled by default.
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
  board: Board;
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
