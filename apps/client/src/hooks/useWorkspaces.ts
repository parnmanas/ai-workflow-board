import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { Workspace } from '../types';

// Workspace list + CRUD for the app shell (AppLayout / WorkspaceSelector).
// Lived in hooks/useBoard.ts until boards were removed (docs/tickets.md).
export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<Workspace[]> => {
    try {
      const data = await api.getWorkspaces();
      setWorkspaces(data);
      setError(null);
      return data;
    } catch (err: any) {
      setError(err.message);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const createWorkspace = async (name: string, description = '') => {
    const ws = await api.createWorkspace({ name, description });
    await refresh();
    return ws;
  };

  const updateWorkspace = async (id: string, data: { name?: string; description?: string }) => {
    await api.updateWorkspace(id, data);
    await refresh();
  };

  const deleteWorkspace = async (id: string) => {
    await api.deleteWorkspace(id);
    await refresh();
  };

  return {
    workspaces,
    loading,
    error,
    refresh,
    createWorkspace,
    updateWorkspace,
    deleteWorkspace,
  };
}
