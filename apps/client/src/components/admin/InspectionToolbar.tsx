import React from 'react';
import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import { tokens } from '../../tokens';
import SessionHeaderMenu from '../sessions/SessionHeaderMenu';

/** Keep creation visible while batch actions and help fit in a phone menu. */
export default function InspectionToolbar({ description, primary, children }: {
  description: string;
  primary: React.ReactNode;
  children: (close: () => void) => React.ReactNode;
}) {
  useLocale();
  return (
    <div className="awb-inspection-toolbar">
      <p className="awb-inspection-toolbar-description" style={{ color: tokens.colors.textSecondary, fontSize: 13, margin: 0 }}>{description}</p>
      <div className="awb-inspection-toolbar-actions">
        <div className="awb-inspection-toolbar-extra">{children(() => {})}</div>
        {primary}
        <div className="awb-inspection-toolbar-menu">
          <SessionHeaderMenu label={translate('More actions')} icon="⋯">
            {close => <div className="awb-inspection-menu-content">
              <p style={{ color: tokens.colors.textSecondary, fontSize: 13, margin: 0 }}>{description}</p>
              {children(close)}
            </div>}
          </SessionHeaderMenu>
        </div>
      </div>
    </div>
  );
}
