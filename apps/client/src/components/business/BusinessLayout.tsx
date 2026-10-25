import React from 'react';
import { NavLink, Outlet, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { BusinessIcon } from './BusinessIcon';

export default function BusinessLayout() {
  const { hasPermission } = useAuth();
  const [search] = useSearchParams();
  const company = search.get('company');
  const suffix = company ? `?company=${encodeURIComponent(company)}` : '';
  const business = hasPermission('business.manage');
  const marketing = hasPermission('marketing.manage') || hasPermission('marketing.approve_spend');
  return <div className="business-shell">
    <div className="business-topbar">
      <div className="business-brand"><span className="business-brand-icon"><BusinessIcon name="formation" /></span><span>Business <small>설립부터 성장까지</small></span></div>
      <nav className="business-nav" aria-label="Business 메뉴">
        {business && <>
          <NavLink to={`/business${suffix}`} end><BusinessIcon name="overview" size={17} /><span>전체 흐름</span></NavLink>
          <NavLink to={`/business/operations${suffix}`}><BusinessIcon name="workflow" size={17} /><span>운영</span></NavLink>
          <NavLink to="/business/mail"><BusinessIcon name="mail" size={17} /><span>메일</span></NavLink>
          <NavLink to={`/business/connectors${suffix}`}><BusinessIcon name="connector" size={17} /><span>커넥터</span></NavLink>
        </>}
        {marketing && <NavLink to="/marketing"><BusinessIcon name="growth" size={17} /><span>마케팅</span></NavLink>}
      </nav>
    </div>
    <div className="business-content"><Outlet /></div>
  </div>;
}
