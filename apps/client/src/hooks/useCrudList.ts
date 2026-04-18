import { useState, useEffect, useCallback, DependencyList } from 'react';

export function useCrudList<T>(
  fetcher: () => Promise<T[]>,
  deps: DependencyList = [],
) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await fetcher());
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { refresh(); }, [refresh]);

  return { items, setItems, loading, showForm, setShowForm, editingId, setEditingId, refresh };
}
