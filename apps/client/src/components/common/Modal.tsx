import React, { useEffect, useRef } from 'react';
import { tokens } from '../../tokens';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useDialogFocus } from '../useDialogFocus';

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
  const dialogRef = useRef<HTMLDivElement>(null);

  // 초기 포커스·Tab 트랩·opener 복귀를 공용 훅으로 통일한다(F2-5). aria-modal 이므로
  // trap=true — 열려 있는 동안 Tab 이 모달 밖 배경으로 새지 않는다. initialFocusRef 를
  // 주지 않아 컨테이너 내 첫 포커스 요소(없으면 다이얼로그 자신, tabIndex=-1)로 이동한다.
  useDialogFocus({ active: isOpen, trap: true, containerRef: dialogRef });

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
        background: tokens.overlays.backdrop,
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
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        tabIndex={-1}
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
