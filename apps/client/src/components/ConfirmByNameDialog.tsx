import React, { useState } from 'react';
import { tokens } from '../tokens';
import { Button, Input, Modal } from './common';

interface ConfirmByNameDialogProps {
  resourceName: string;
  title?: string;
  description?: string;
  confirmLabel?: string;
  onConfirm: () => Promise<void> | void;
  onCancel: () => void;
}

export default function ConfirmByNameDialog({
  resourceName,
  title = 'Confirm action',
  description,
  confirmLabel = 'Confirm',
  onConfirm,
  onCancel,
}: ConfirmByNameDialogProps) {
  const [inputValue, setInputValue] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const isMatch = inputValue === resourceName;

  const handleConfirm = async () => {
    if (!isMatch || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onConfirm();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      title={title}
      maxWidth={400}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>Cancel</Button>
          <Button
            variant="danger"
            onClick={handleConfirm}
            disabled={!isMatch || isSubmitting}
            loading={isSubmitting}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <p style={{
        fontSize: tokens.typography.fontSizeMd,
        color: tokens.colors.textSecondary,
        margin: `${tokens.spacing.sm}px 0`,
      }}>
        {description || `Type ${resourceName} to confirm.`}
      </p>
      <Input
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && isMatch) handleConfirm(); }}
        placeholder={resourceName}
        autoFocus
      />
    </Modal>
  );
}
