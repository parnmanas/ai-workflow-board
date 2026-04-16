import { useState, useEffect } from 'react';

/**
 * Lightweight viewport-size hook — returns `true` when the given CSS media query matches.
 * Uses window.matchMedia with a change listener; SSR-safe (returns false if window is undefined).
 *
 * Phase 1 usage: breakpoint detection for the responsive sidebar in AppLayout.
 * See .planning/phases/01-foundation/01-UI-SPEC.md §"Sidebar Responsive Behavior".
 */
export function useMediaQuery(query: string): boolean {
  const getInitial = () => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia(query).matches;
  };

  const [matches, setMatches] = useState<boolean>(getInitial);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    // Sync on mount in case the initial state diverged from the current one
    setMatches(mql.matches);
    // Modern API (addEventListener) — supported in all Node 22-era browsers
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, [query]);

  return matches;
}
