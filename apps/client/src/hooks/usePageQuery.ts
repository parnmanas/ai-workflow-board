import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

/** Navigation state belongs in the URL so reloads and Back restore the same view. */
export function usePageQuery() {
  const { pathname, search, hash } = useLocation();
  const navigate = useNavigate();
  const updateQuery = useCallback((changes: Record<string, string | null>) => {
    const next = new URLSearchParams(search);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    navigate({ pathname, search: next.toString(), hash }, { replace: true });
  }, [pathname, search, hash, navigate]);
  return [new URLSearchParams(search), updateQuery] as const;
}

export function usePageTab<T extends string>(tabs: readonly T[], fallback: T, key = 'tab') {
  const [query, updateQuery] = usePageQuery();
  const requested = query.get(key) as T;
  const tab = tabs.includes(requested) ? requested : fallback;
  const setTab = useCallback((next: T) => updateQuery({ [key]: next === fallback ? null : next }), [key, fallback, updateQuery]);
  return [tab, setTab] as const;
}
