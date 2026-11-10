import React from 'react';
import { useNavigate } from 'react-router-dom';
import { t } from '../../i18n/core';
import { useAgentSessionsNav } from '../../hooks/useAgentSessionsNav';
import { SessionView } from '../sessions/SessionsPage';

/**
 * 업무가 이어 쓰는 Agent Session 을 업무 상세에 그대로 띄운다.
 *
 * 세션 화면은 Sessions 페이지의 `SessionView` 그 자체다(표면마다 따로 만들지 않는다) — 그래서 전사 ·
 * 승인/질문 · 모델 설정 · 프로세스 다시 띄우기가 전부 여기서도 된다. 업무 실행이 죽어도 이 자리에서
 * 무슨 일이 있었는지 보고, 다시 열어 이어 가고, 궁금한 것을 바로 물을 수 있다.
 */
export function BusinessTaskSession({ accountId, session }: {
  accountId: string; session: { manager_id: string; cli: string; session_id: string };
}) {
  const navigate = useNavigate();
  const { hosts } = useAgentSessionsNav(accountId);
  const host = hosts.find(item => item.manager_id === session.manager_id) ?? null;
  return <section className="business-task-session" aria-label={t('세션')}>
    <SessionView key={`${session.manager_id}/${session.cli}/${session.session_id}`} accountId={accountId}
      managerId={session.manager_id} cli={session.cli} sessionId={session.session_id} host={host} onNew={() => navigate('/sessions?new=1')} />
  </section>;
}
