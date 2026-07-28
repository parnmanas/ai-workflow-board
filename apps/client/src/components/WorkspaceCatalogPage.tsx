import React, { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Board, CatalogScope } from '../types';
import { tokens } from '../tokens';
import PageHeader from './PageHeader';
import FunctionManager from './admin/FunctionManager';
import CredentialManager from './admin/CredentialManager';
import ResourceManager from './admin/ResourceManager';
import ActionManager from './admin/ActionManager';
import PromptTemplateManager from './admin/PromptTemplateManager';
import QaManager from './admin/QaManager';
import SecurityManager from './admin/SecurityManager';
import WorkspaceSchedulesEditor from './WorkspaceSchedulesEditor';

type CatalogTab = 'functions' | 'credentials' | 'resources' | 'actions' | 'prompts' | 'qa' | 'security' | 'schedules';

const TABS: Array<{ id: CatalogTab; label: string; scopes: CatalogScope[] }> = [
  { id: 'functions', label: 'Functions', scopes: ['global', 'workspace', 'board'] },
  { id: 'credentials', label: 'Credentials', scopes: ['global', 'workspace', 'board'] },
  { id: 'resources', label: 'Resources', scopes: ['global', 'workspace', 'board'] },
  { id: 'prompts', label: 'Prompt Templates', scopes: ['global', 'workspace', 'board'] },
  { id: 'actions', label: 'Actions', scopes: ['workspace', 'board'] },
  { id: 'qa', label: 'QA', scopes: ['workspace', 'board'] },
  { id: 'security', label: 'Security', scopes: ['workspace', 'board'] },
  { id: 'schedules', label: 'Schedules', scopes: ['workspace', 'board'] },
];

export default function WorkspaceCatalogPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const [params, setParams] = useSearchParams();
  const requestedTab = params.get('tab') as CatalogTab | null;
  const tab = TABS.some(item => item.id === requestedTab) ? requestedTab! : 'functions';
  const tabConfig = TABS.find(item => item.id === tab)!;
  const requestedScope = params.get('scope') as CatalogScope | null;
  const createScope = tabConfig.scopes.includes(requestedScope as CatalogScope)
    ? requestedScope!
    : (tabConfig.scopes.includes('workspace') ? 'workspace' : tabConfig.scopes[0]);
  const [boards, setBoards] = useState<Board[]>([]);
  const requestedBoard = params.get('board') || '';
  const boardId = createScope === 'board' ? (requestedBoard || boards[0]?.id || '') : '';

  useEffect(() => {
    if (!wsId) return;
    api.getBoards(wsId).then(setBoards).catch(() => setBoards([]));
  }, [wsId]);

  useEffect(() => {
    if (createScope === 'board' && boardId && requestedBoard !== boardId) {
      const next = new URLSearchParams(params);
      next.set('board', boardId);
      setParams(next, { replace: true });
    }
  }, [boardId, createScope, params, requestedBoard, setParams]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key === 'tab') {
      const nextTab = TABS.find(item => item.id === value)!;
      const currentScope = next.get('scope') as CatalogScope | null;
      if (!nextTab.scopes.includes(currentScope as CatalogScope)) next.set('scope', nextTab.scopes[0]);
    }
    setParams(next);
  };

  const manager = useMemo(() => {
    const shared = { workspaceId: wsId, createScope, boardId: boardId || undefined };
    switch (tab) {
      case 'functions':
        return <FunctionManager {...shared} catalogMode allScopes />;
      case 'credentials':
        return <CredentialManager {...shared} catalogMode allScopes />;
      case 'resources':
        return <ResourceManager {...shared} catalogMode allScopes />;
      case 'prompts':
        return <PromptTemplateManager {...shared} catalogMode allScopes />;
      case 'actions':
        return <ActionManager workspaceId={wsId} boardId={createScope === 'board' ? boardId : undefined} allScopes />;
      case 'qa':
        return <QaManager workspaceId={wsId} boardId={createScope === 'board' ? boardId : undefined} allScopes />;
      case 'security':
        return <SecurityManager workspaceId={wsId} boardId={createScope === 'board' ? boardId : undefined} allScopes />;
      case 'schedules':
        return <WorkspaceSchedulesEditor workspaceId={wsId} boardId={createScope === 'board' ? boardId : undefined} />;
    }
  }, [boardId, createScope, tab, wsId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Automation Catalog"
        description="Manage reusable definitions and operational automation from one place. Catalog lists include every applicable scope."
      />
      <div style={{ padding: '14px 24px 0', borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {TABS.map(item => (
            <button
              key={item.id}
              onClick={() => setParam('tab', item.id)}
              style={{
                padding: '8px 11px',
                border: 'none',
                borderBottom: tab === item.id ? `2px solid ${tokens.colors.accent}` : '2px solid transparent',
                background: 'transparent',
                color: tab === item.id ? tokens.colors.textStrong : tokens.colors.textMuted,
                fontWeight: tab === item.id ? 700 : 500,
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>
      <div style={{ padding: '14px 24px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', background: tokens.colors.surfaceSubtle }}>
        <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
          New item scope
          <select
            value={createScope}
            onChange={event => setParam('scope', event.target.value)}
            style={{ display: 'block', marginTop: 5, minWidth: 180, padding: '8px 10px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
          >
            {tabConfig.scopes.map(scope => <option key={scope} value={scope}>{scope[0].toUpperCase() + scope.slice(1)}</option>)}
          </select>
        </label>
        {createScope === 'board' && (
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Board
            <select
              value={boardId}
              onChange={event => setParam('board', event.target.value)}
              style={{ display: 'block', marginTop: 5, minWidth: 240, padding: '8px 10px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
            >
              {boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}
            </select>
          </label>
        )}
        <div style={{ color: tokens.colors.textMuted, fontSize: 12, paddingBottom: 8 }}>
          {tabConfig.scopes.length === 3
            ? 'Global items are inherited by every workspace; Workspace and Board definitions can override them.'
            : 'This type binds workspace-owned agents or execution history, so Global scope is intentionally unavailable.'}
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24 }}>
        {manager}
      </div>
    </div>
  );
}
