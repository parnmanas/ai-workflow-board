import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { Account } from '../types';

// Account list + CRUD for the app shell (AppLayout / AccountSelector).
// Lived in hooks/useBoard.ts until boards were removed (docs/tickets.md).
export function useAccounts() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<Account[]> => {
    try {
      const data = await api.getAccounts();
      setAccounts(data);
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

  const createAccount = async (name: string, description = '') => {
    const ws = await api.createAccount({ name, description });
    await refresh();
    return ws;
  };

  const updateAccount = async (id: string, data: { name?: string; description?: string }) => {
    await api.updateAccount(id, data);
    await refresh();
  };

  const deleteAccount = async (id: string) => {
    await api.deleteAccount(id);
    await refresh();
  };

  return {
    accounts,
    loading,
    error,
    refresh,
    createAccount,
    updateAccount,
    deleteAccount,
  };
}
