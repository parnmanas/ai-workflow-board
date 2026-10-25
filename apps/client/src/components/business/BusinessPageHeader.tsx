import React from 'react';
import SessionHeaderMenu from '../sessions/SessionHeaderMenu';

/** Keep one primary action visible; put secondary actions in the shared disclosure.
 * The company selector has its own row when the Business shell (not the viewport) is narrow. */
export function BusinessPageHeader({ title, description, context, status, actions, moreActions }: {
  title: string;
  description?: string;
  context?: React.ReactNode;
  status?: React.ReactNode;
  actions?: React.ReactNode;
  moreActions?: (close: () => void) => React.ReactNode;
}) {
  const showMenu = !!moreActions || !!description;
  return <header className="business-page-heading">
    <div className="business-heading-copy">
      <h1 title={title}>{title}</h1>
      {description && <p className="business-heading-description" title={description}>{description}</p>}
      {status && <div className="business-heading-status">{status}</div>}
    </div>
    {context && <div className="business-heading-context">{context}</div>}
    {(actions || showMenu) && <div className="business-heading-actions">
      {actions}
      {showMenu && <SessionHeaderMenu label={`${title} 메뉴`} icon="⋯">
        {close => <>
          <div className="business-heading-menu-info"><strong>{title}</strong>{description && <p>{description}</p>}</div>
          {moreActions && <div className="business-heading-menu-actions">{moreActions(close)}</div>}
        </>}
      </SessionHeaderMenu>}
    </div>}
  </header>;
}
