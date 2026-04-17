import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api';
import { PromptTemplate } from '../types';
import { useBoard } from '../hooks/useBoard';
import { useToast } from '../contexts/ToastContext';
import { useLoading } from '../contexts/LoadingContext';
import PageHeader from './PageHeader';
import PageTabs from './PageTabs';
import ColumnManager from './ColumnManager';
import { tokens } from '../tokens';
import { Button } from './common';
import ResourceManager from './admin/ResourceManager';

type TabKey = 'columns' | 'resources';

export default function BoardSettingsPage() {
  const { showToast } = useToast();
  const { withLoading } = useLoading();
  const [activeTab, setActiveTab] = useState<TabKey>('columns');

  // Board and workspace identity come from the URL.
  const { wsId, boardId } = useParams<{ wsId: string; boardId: string }>();

  const {
    board, refresh,
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
      <PageTabs
        tabs={[
          { id: 'columns', label: 'Columns', onClick: () => setActiveTab('columns') },
          { id: 'resources', label: 'Resources', onClick: () => setActiveTab('resources') },
        ]}
        activeId={activeTab}
      />
      <div style={{ ...pageStyle, flex: 1, overflow: 'auto', minHeight: 0 }}>
        {activeTab === 'columns' && (
          <ColumnManager
            columns={board.columns}
            boardId={board.id}
            routingConfig={routingConfig}
            columnPrompts={columnPrompts}
            promptTemplates={promptTemplates}
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
        )}
        {activeTab === 'resources' && (
          <ResourceManager workspaceId={wsId} boardId={boardId} />
        )}
      </div>
    </div>
  );
}
