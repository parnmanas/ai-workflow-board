export type CatalogScope = 'global' | 'workspace';

export interface CatalogScoped {
  workspace_id: string | null;
  board_id: string | null;
}

export function catalogScopeOf(row: CatalogScoped): CatalogScope {
  return row.workspace_id ? 'workspace' : 'global';
}

export function normalizeCatalogScope(input: {
  scope?: CatalogScope | 'board';
  workspace_id?: string | null;
  board_id?: string | null;
}): CatalogScoped {
  if (input.scope === 'board' || input.board_id) {
    throw Object.assign(
      new Error('Board-scoped catalog items are no longer supported; create the item in its Workspace instead'),
      { status: 400 },
    );
  }
  const requested = input.scope
    || (input.workspace_id ? 'workspace' : 'global');
  if (requested === 'global') return { workspace_id: null, board_id: null };
  const workspaceId = String(input.workspace_id || '').trim();
  if (!workspaceId) throw Object.assign(new Error('workspace_id is required for workspace scope'), { status: 400 });
  return { workspace_id: workspaceId, board_id: null };
}

export function canUseCatalogItem(row: CatalogScoped, workspaceId: string, _boardId?: string | null): boolean {
  if (row.board_id !== null) return false;
  if (row.workspace_id === null) return true;
  return row.workspace_id === workspaceId;
}

/** @deprecated Board catalog scope was removed. Kept as a no-op for callers
 * that share validation plumbing with older clients. */
export async function assertCatalogBoardScope(
  _findBoard: (boardId: string, workspaceId: string) => Promise<boolean>,
  _scope: CatalogScoped,
): Promise<void> {
  return;
}
