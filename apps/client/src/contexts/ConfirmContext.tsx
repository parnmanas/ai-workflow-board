import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import ConfirmDialog from '../components/common/ConfirmDialog';

export interface ConfirmOptions {
  title?: string;
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Destructive (red) confirm button. Default true. */
  danger?: boolean;
  /** Type-to-confirm: confirm stays disabled until this exact string is typed. */
  requireName?: string;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

/**
 * Imperative confirmation prompt:
 *   const confirm = useConfirm();
 *   if (!(await confirm({ title, message, danger }))) return;
 *   await api.delete(...);
 * Resolves true when the user confirms, false on cancel / ESC / backdrop click.
 */
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolverRef = useRef<((result: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>((options) => {
    return new Promise<boolean>((resolve) => {
      // If a prompt is somehow already open, resolve it as cancelled first.
      resolverRef.current?.(false);
      resolverRef.current = resolve;
      setOpts(options);
    });
  }, []);

  const finish = useCallback((result: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setOpts(null);
    resolve?.(result);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <ConfirmDialog
          isOpen={true}
          {...opts}
          onConfirm={() => finish(true)}
          onCancel={() => finish(false)}
        />
      )}
    </ConfirmContext.Provider>
  );
}
