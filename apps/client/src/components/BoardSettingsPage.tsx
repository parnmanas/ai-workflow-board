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
