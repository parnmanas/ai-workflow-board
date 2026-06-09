import React, { useEffect, useState } from 'react';
import { tokens } from '../../tokens';
import { Button } from './Button';
import { Input } from './Input';
import { Modal } from './Modal';

export interface ConfirmDialogProps {
  isOpen: boolean;
  title?: string;
  /** Body text. Accepts plain strings (newlines preserved) or rich nodes. */
  message?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Render the confirm button in the destructive (red) style. Default true. */
  danger?: boolean;
  /**
   * High-risk "type-to-confirm" variant: the confirm button stays disabled
   * until the user types this exact string (e.g. a board name).
   */
  requireName?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * Unified confirmation dialog for destructive actions. Built on the shared
 * Modal (so it inherits ESC-to-close, backdrop-click, and aria-modal). When
 * `requireName` is set it becomes the type-to-confirm variant used for the
 * highest-risk actions (board archive, etc.); otherwise it is a plain
 * confirm/cancel prompt.
 *
 * Most call sites should reach for the imperative `useConfirm()` hook rather
 * than rendering this directly.
 */
export default function ConfirmDialog({
  isOpen,
  title = 'Are you sure?',
  message,
  confirmLabel = 'Delete',
  cancelLabel = 'Cancel',
  danger = true,
  requireName,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const needsName = !!requireName;
  const isMatch = !needsName || inputValue === requireName;

  // Reset the type-to-confirm field each time the dialog is (re)opened.
  useEffect(() => {
    if (isOpen) setInputValue('');
  }, [isOpen]);

  const handleConfirm = () => {
    if (!isMatch) return;
    onConfirm();
  };

  // Enter confirms. For the type-to-confirm variant the Input's own onKeyDown
  // handles Enter (and gates on a match), so only bind the window listener for
  // the plain variant to avoid a double fire.
  useEffect(() => {
    if (!isOpen || needsName) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        onConfirm();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [isOpen, needsName, onConfirm]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title={title}
      maxWidth={420}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>{cancelLabel}</Button>
          <Button
            variant={danger ? 'danger' : 'primary'}
            onClick={handleConfirm}
            disabled={!isMatch}
            autoFocus={!needsName}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message != null && (
        <div
          style={{
            fontSize: tokens.typography.fontSizeMd,
            color: tokens.colors.textSecondary,
            lineHeight: 1.5,
            whiteSpace: 'pre-wrap',
          }}
        >
          {message}
        </div>
      )}
      {needsName && (
        <div style={{ marginTop: tokens.spacing.sm }}>
          <Input
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && isMatch) handleConfirm(); }}
            placeholder={requireName}
            autoFocus
          />
        </div>
      )}
    </Modal>
  );
}
