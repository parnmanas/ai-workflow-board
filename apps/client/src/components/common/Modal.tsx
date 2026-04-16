import React, { useEffect } from 'react';
import { tokens } from '../../tokens';
import { useMediaQuery } from '../../hooks/useMediaQuery';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  maxWidth?: number;
}

let _modalIdCounter = 0;

export function Modal({ isOpen, onClose, title, children, footer, maxWidth }: ModalProps) {
  // Generate a stable id per instance for aria-labelledby
  const [titleId] = React.useState(() => `modal-title-${++_modalIdCounter}`);
  const isMobile = useMediaQuery('(max-width: 768px)');

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.6)',
        zIndex: 2000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        onClick={(e) => e.stopPropagation()}
        style={{
          background: tokens.colors.surfaceCard,
          border: `1px solid ${tokens.colors.border}`,
          borderRadius: tokens.radii.xl,
          padding: tokens.spacing.lg,
          width: isMobile ? 'calc(100% - 32px)' : '90%',
          maxWidth: isMobile ? 'none' : (maxWidth || 480),
          maxHeight: isMobile ? '90vh' : '85vh',
          overflowY: 'auto' as const,
          boxShadow: tokens.shadows.modal,
          position: 'relative' as const,
        }}
      >
        {title && (
          <h2
            id={titleId}
            style={{
              fontSize: tokens.typography.fontSizeXl,
              fontWeight: tokens.typography.fontWeightSemibold,
              color: tokens.colors.textPrimary,
              margin: 0,
              marginBottom: tokens.spacing.md,
            }}
          >
            {title}
          </h2>
        )}
        <div>{children}</div>
        {footer && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'flex-end',
              gap: tokens.spacing.sm,
              marginTop: tokens.spacing.md,
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
