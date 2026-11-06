import React from 'react';
import { t as translate } from '../i18n/core';
import { useLocale } from '../i18n/react';
import { tokens } from '../tokens';
import SessionHeaderMenu from './sessions/SessionHeaderMenu';

interface PageHeaderProps {
  title: string;
  description?: string;
  actions?: React.ReactNode;
  moreActions?: (close: () => void) => React.ReactNode;
}

export default function PageHeader({ title, description, actions, moreActions }: PageHeaderProps) {
  useLocale();
  return (
    <header
      className="awb-page-header"
      style={{
        background: tokens.gradients.surfaceCard,
        borderBottom: `1px solid ${tokens.colors.border}`,
      }}
    >
      <div className="awb-page-header-row">
        <div className="awb-page-heading-copy">
          <h1 title={title} style={{ fontSize: '16px', fontWeight: 700, color: tokens.colors.textPrimary, margin: 0 }}>{title}</h1>
          {description && (
            <p className="awb-page-description" style={{ fontSize: '11px', color: tokens.colors.textSecondary, margin: '2px 0 0 0' }}>{description}</p>
          )}
        </div>
        {(actions || description || moreActions) && (
          <div className="awb-page-actions">
            {actions}
            {(description || moreActions) && <div className={moreActions ? 'awb-page-menu' : 'awb-page-info-menu'}>
              <SessionHeaderMenu label={translate('{0} 메뉴', { 0: title })} icon="⋯">
                {close => <>
                  <div className="awb-page-menu-info" style={{ color: tokens.colors.textSecondary }}>
                    <strong style={{ color: tokens.colors.textPrimary }}>{title}</strong>
                    {description && <p>{description}</p>}
                  </div>
                  {moreActions && <div className="awb-page-menu-actions">{moreActions(close)}</div>}
                </>}
              </SessionHeaderMenu>
            </div>}
          </div>
        )}
      </div>
    </header>
  );
}
