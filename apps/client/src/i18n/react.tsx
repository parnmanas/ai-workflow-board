import React, { useEffect, useSyncExternalStore } from 'react';
import { getLocale, initializeLocale, LANGUAGE_STORAGE_KEY, savedLocale, setLocale, subscribeLocale } from './core';

/** Subscription without a keyed remount: changing language keeps forms, sessions and focus intact. */
export function useLocale() {
  return useSyncExternalStore(subscribeLocale, getLocale, () => 'en' as const);
}

export function LocaleProvider({ children }: { children: React.ReactNode }) {
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === LANGUAGE_STORAGE_KEY || event.key === null) {
        void setLocale(savedLocale(), false).catch(() => undefined);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return <>{children}</>;
}

export { initializeLocale };
