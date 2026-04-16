import React, { createContext, useContext, useState, useCallback } from 'react';
import { tokens } from '../tokens';

interface LoadingContextType {
  isLoading: boolean;
  startLoading: () => void;
  stopLoading: () => void;
  withLoading: <T>(fn: () => Promise<T>) => Promise<T>;
}

const LoadingContext = createContext<LoadingContextType>({
  isLoading: false,
  startLoading: () => {},
  stopLoading: () => {},
  withLoading: async (fn) => fn(),
});

export const useLoading = () => useContext(LoadingContext);

export function LoadingProvider({ children }: { children: React.ReactNode }) {
  const [count, setCount] = useState(0);
  const isLoading = count > 0;

  const startLoading = useCallback(() => setCount(c => c + 1), []);
  const stopLoading = useCallback(() => setCount(c => Math.max(0, c - 1)), []);
  const withLoading = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    startLoading();
    try { return await fn(); } finally { stopLoading(); }
  }, [startLoading, stopLoading]);

  return (
    <LoadingContext.Provider value={{ isLoading, startLoading, stopLoading, withLoading }}>
      {children}
      {isLoading && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, height: 3, zIndex: 9999,
          background: tokens.gradients.accentShimmer,
          backgroundSize: '200% 100%',
          animation: 'loadingSlide 1.5s ease-in-out infinite',
        }} />
      )}
    </LoadingContext.Provider>
  );
}
