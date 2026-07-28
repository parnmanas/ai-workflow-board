export type CatalogScope = 'global' | 'workspace' | 'board';

export interface CatalogScoped {
  workspace_id: string | null;
  board_id: string | null;
}

export function catalogScopeOf(row: CatalogScoped): CatalogScope {
  if (row.board_id) return 'board';
  return row.workspace_id ? 'workspace' : 'global';
}

export function normalizeCatalogScope(input: {
  scope?: CatalogScope;
  workspace_id?: string | null;
  board_id?: string | null;
}): CatalogScoped {
  const requested = input.scope
    || (input.board_id ? 'board' : input.workspace_id ? 'workspace' : 'global');
  if (requested === 'global') return { workspace_id: null, board_id: null };
  const workspaceId = String(input.workspace_id || '').trim();
  if (!workspaceId) throw Object.assign(new Error('workspace_id is required for workspace and board scope'), { status: 400 });
  if (requested === 'workspace') return { workspace_id: workspaceId, board_id: null };
  const boardId = String(input.board_id || '').trim();
  if (!boardId) throw Object.assign(new Error('board_id is required for board scope'), { status: 400 });
  return { workspace_id: workspaceId, board_id: boardId };
}

export function canUseCatalogItem(row: CatalogScoped, workspaceId: string, boardId?: string | null): boolean {
  if (row.workspace_id === null) return true;
  if (row.workspace_id !== workspaceId) return false;
  return row.board_id === null || row.board_id === (boardId || null);
}

export async function assertCatalogBoardScope(
  findBoard: (boardId: string, workspaceId: string) => Promise<boolean>,
  scope: CatalogScoped,
): Promise<void> {
  if (!scope.board_id || !scope.workspace_id) return;
  if (!await findBoard(scope.board_id, scope.workspace_id)) {
    throw Object.assign(new Error('board_id does not belong to workspace_id'), { status: 400 });
  }
}
