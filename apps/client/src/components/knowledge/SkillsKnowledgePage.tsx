import { t as translate } from '../../i18n/core';
import { useLocale } from '../../i18n/react';
import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { Button } from '../common';
import PageHeader from '../PageHeader';
import SkillsPage from '../admin/SkillsPage';

/**
 * Skills — Knowledge 의 한 축(docs/skills.md). 범위별 배정(Shared · 프로젝트 · 특정 실행)이 첫 화면이고,
 * 카탈로그(만들기 · 버전 · fork)와 제안 검토가 탭으로 따라온다. 전역 skill 원천(내장 팩 · tap)은 admin 의
 * Skill Registry 에 그대로 있다.
 */
export default function SkillsKnowledgePage() {
  useLocale();
  const navigate = useNavigate();
  const { hasPermission } = useAuth();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <PageHeader
        title={translate('Skills')}
        description={translate('Reusable instructions agents load when they need them — shared by every agent, per project, or for one runtime.')}
        actions={hasPermission('admin.access')
          ? <Button size="sm" variant="ghost" onClick={() => navigate('/admin/skill-registry')}>{translate('Skill Registry')}</Button>
          : undefined}
      />
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 20 }}>
        <SkillsPage />
      </div>
    </div>
  );
}
