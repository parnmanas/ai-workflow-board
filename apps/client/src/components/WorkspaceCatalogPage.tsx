import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import type { Board, CatalogScope } from '../types';
import { tokens } from '../tokens';
import { useAuth } from '../contexts/AuthContext';
import PageHeader from './PageHeader';
import FunctionManager from './admin/FunctionManager';
import CredentialManager from './admin/CredentialManager';
import ResourceManager from './admin/ResourceManager';
import ActionManager from './admin/ActionManager';
import PromptTemplateManager from './admin/PromptTemplateManager';
import QaManager from './admin/QaManager';
import SecurityManager from './admin/SecurityManager';
import WorkspaceSchedulesEditor from './WorkspaceSchedulesEditor';
import WorkspaceClaudeBackendProfilesEditor from './WorkspaceClaudeBackendProfilesEditor';
import ClaudeBackendProfilesManager from './admin/ClaudeBackendProfilesManager';
import QaRunner from './admin/QaRunner';
import ColumnPoliciesManager from './admin/ColumnPoliciesManager';
import WorkflowHealthDashboard from './admin/WorkflowHealthDashboard';

const CATALOG_SCOPES: CatalogScope[] = ['global', 'workspace', 'board'];

function CatalogSection({
  id,
  title,
  description,
  scopes,
  children,
}: {
  id: string;
  title: string;
  description: string;
  scopes: string;
  children: React.ReactNode;
}) {
  return (
    <section
      id={`catalog-${id}`}
      style={{
        scrollMarginTop: 16,
        border: `1px solid ${tokens.colors.border}`,
        borderRadius: tokens.radii.lg,
        background: tokens.colors.surface,
        overflow: 'hidden',
      }}
    >
      <header style={{ padding: '16px 20px', borderBottom: `1px solid ${tokens.colors.border}`, background: tokens.colors.surfaceSubtle }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <h2 style={{ margin: 0, fontSize: 17, color: tokens.colors.textStrong }}>{title}</h2>
          <span style={{ fontSize: 11, fontWeight: 700, color: tokens.colors.accent, textTransform: 'uppercase' }}>{scopes}</span>
        </div>
        <p style={{ margin: '5px 0 0', color: tokens.colors.textMuted, fontSize: 12, lineHeight: 1.5 }}>{description}</p>
      </header>
      <div style={{ padding: 20 }}>{children}</div>
    </section>
  );
}

export default function WorkspaceCatalogPage() {
  const { wsId = '' } = useParams<{ wsId: string }>();
  const { hasPermission } = useAuth();
  const [params, setParams] = useSearchParams();
  const requestedScope = params.get('scope') as CatalogScope | null;
  const createScope = CATALOG_SCOPES.includes(requestedScope as CatalogScope) ? requestedScope! : 'workspace';
  const [boards, setBoards] = useState<Board[]>([]);
  const requestedBoard = params.get('board') || '';
  const boardId = createScope === 'board' ? (requestedBoard || boards[0]?.id || '') : '';
  const operationalBoardId = createScope === 'board' ? boardId : undefined;

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

  useEffect(() => {
    const legacySection = params.get('section') || params.get('tab');
    if (!legacySection) return;
    const target = document.getElementById(`catalog-${legacySection}`);
    if (target) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }, [params]);

  const setScopeParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    next.delete('tab');
    next.delete('section');
    setParams(next);
  };

  const sharedDefinitionProps = {
    workspaceId: wsId,
    createScope,
    boardId: boardId || undefined,
    catalogMode: true,
    allScopes: true,
  } as const;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title="Automation Catalog"
        description="All reusable definitions, operational automation, and scope assignments in one page."
      />
      <div style={{ padding: '14px 24px', display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', background: tokens.colors.surfaceSubtle }}>
        <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
          Default scope for new items
          <select
            value={createScope}
            onChange={event => setScopeParam('scope', event.target.value)}
            style={{ display: 'block', marginTop: 5, minWidth: 180, padding: '8px 10px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
          >
            {CATALOG_SCOPES.map(scope => <option key={scope} value={scope}>{scope[0].toUpperCase() + scope.slice(1)}</option>)}
          </select>
        </label>
        {createScope === 'board' && (
          <label style={{ color: tokens.colors.textSecondary, fontSize: 12 }}>
            Board
            <select
              value={boardId}
              onChange={event => setScopeParam('board', event.target.value)}
              style={{ display: 'block', marginTop: 5, minWidth: 240, padding: '8px 10px', borderRadius: 6, border: `1px solid ${tokens.colors.border}`, background: tokens.colors.surface, color: tokens.colors.textPrimary }}
            >
              {boards.map(board => <option key={board.id} value={board.id}>{board.name}</option>)}
            </select>
          </label>
        )}
        <div style={{ color: tokens.colors.textMuted, fontSize: 12, paddingBottom: 8 }}>
          Lists always show every applicable scope. Actions, QA, Security, and Schedules bind workspace agents or execution history;
          when Global is selected, their new items remain Workspace-scoped.
        </div>
      </div>
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0, padding: 24, display: 'grid', gap: 20 }}>
        <CatalogSection id="functions" title="Functions" scopes="Global · Workspace · Board" description="Executable reusable functions, resolved from Board to Workspace to Global.">
          <FunctionManager {...sharedDefinitionProps} />
        </CatalogSection>
        <CatalogSection id="credentials" title="Credentials" scopes="Global · Workspace · Board" description="Secrets and authentication references available to catalog consumers within their scope boundary.">
          <CredentialManager {...sharedDefinitionProps} />
        </CatalogSection>
        <CatalogSection id="resources" title="Resources" scopes="Global · Workspace · Board" description="Repositories, files, links, and resource-to-credential bindings.">
          <ResourceManager {...sharedDefinitionProps} />
        </CatalogSection>
        <CatalogSection id="prompts" title="Prompt Templates" scopes="Global · Workspace · Board" description="Reusable prompts and Board column prompt assignments.">
          <PromptTemplateManager {...sharedDefinitionProps} />
        </CatalogSection>
        <CatalogSection id="actions" title="Actions" scopes="Workspace · Board" description="Reusable agent actions and ticket-done triggers.">
          <ActionManager workspaceId={wsId} boardId={operationalBoardId} allScopes />
        </CatalogSection>
        <CatalogSection id="qa" title="QA Scenarios" scopes="Workspace · Board" description="Scenario definitions, execution history, batches, and QA schedules.">
          <QaManager workspaceId={wsId} boardId={operationalBoardId} allScopes />
        </CatalogSection>
        <CatalogSection id="security" title="Security Profiles" scopes="Workspace · Board" description="Security inspection profiles, runs, batches, and schedules.">
          <SecurityManager workspaceId={wsId} boardId={operationalBoardId} allScopes />
        </CatalogSection>
        <CatalogSection id="schedules" title="Agent Schedules" scopes="Workspace · Board" description="General scheduled agent tasks.">
          <WorkspaceSchedulesEditor workspaceId={wsId} boardId={operationalBoardId} />
        </CatalogSection>
        <CatalogSection id="claude-backends" title="Claude Backend Profiles" scopes="Global · Workspace" description="Define instance backends and assign the allowed/default profiles for this workspace.">
          {hasPermission('admin.access') && (
            <div style={{ marginBottom: 20 }}>
              <ClaudeBackendProfilesManager />
            </div>
          )}
          <WorkspaceClaudeBackendProfilesEditor workspaceId={wsId} />
        </CatalogSection>
        {hasPermission('admin.access') && (
          <>
            <CatalogSection id="system-qa" title="System QA" scopes="Global" description="Run AWB system-level quality assurance checks.">
              <QaRunner />
            </CatalogSection>
            <CatalogSection id="column-policies" title="Column Policies" scopes="Global" description="Declarative role enforcement and stuck-ticket protection.">
              <ColumnPoliciesManager />
            </CatalogSection>
            <CatalogSection id="workflow-health" title="Workflow Health" scopes="Global" description="Automation suppression, respawn storms, QA trend, and token usage.">
              <WorkflowHealthDashboard />
            </CatalogSection>
          </>
        )}
      </div>
    </div>
  );
}
