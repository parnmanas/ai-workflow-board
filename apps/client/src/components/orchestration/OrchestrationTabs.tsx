import React from 'react';
import PageTabs from '../PageTabs';

/** The two halves of Orchestration mode: the work (Missions) and the roster (Teams). */
export default function OrchestrationTabs({ wsId, active }: { wsId: string; active: 'missions' | 'teams' }) {
  return (
    <PageTabs
      activeId={active}
      tabs={[
        { id: 'missions', label: 'Missions', to: `/ws/${wsId}/orchestration` },
        { id: 'teams', label: 'Teams', to: `/ws/${wsId}/orchestration/teams` },
      ]}
    />
  );
}
