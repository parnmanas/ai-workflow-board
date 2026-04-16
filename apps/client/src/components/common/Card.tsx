import React, { useState } from 'react';
import { tokens } from '../../tokens';

interface CardProps {
  children: React.ReactNode;
  onClick?: () => void;
  selected?: boolean;
  padding?: number | string;
  style?: React.CSSProperties;
}

export function Card({ children, onClick, selected, padding, style }: CardProps) {
  const [isHovered, setIsHovered] = useState(false);

  const baseStyle: React.CSSProperties = {
    background: isHovered && onClick ? tokens.colors.surfaceHover : tokens.colors.surfaceCard,
    border: `1px solid ${selected ? tokens.colors.accent : tokens.colors.border}`,
    borderRadius: tokens.radii.lg,
    boxShadow: tokens.shadows.card,
    overflow: 'hidden',
    padding: padding ?? tokens.spacing.md,
    cursor: onClick ? 'pointer' : undefined,
    ...style,
  };

  return (
    <div
      style={baseStyle}
      onClick={onClick}
      onMouseEnter={onClick ? () => setIsHovered(true) : undefined}
      onMouseLeave={onClick ? () => setIsHovered(false) : undefined}
    >
      {children}
    </div>
  );
}
