import React from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import AgentDetailModal from './AgentDetailModal';

/**
 * Route wrapper for AgentDetailModal so the detail surface is a real page
 * (`/ws/:wsId/agents/:agentId`) inside AppLayout's content area instead of
 * a fixed-position overlay. Two reasons we made the move:
 *   1. Refresh was closing the panel because state lived in AgentsPage.
 *   2. Agent detail now hosts Files + Subagents transcripts that need the
 *      full content width to be useful.
 *
 * The component name "Modal" is preserved for now — its internal markup is
 * already the right shape (header, scroll body, tab bar, sections); only
 * the backdrop wrapper changed. A rename is a separate cleanup.
 */
export default function AgentDetailPage() {
  const { wsId, agentId } = useParams<{ wsId: string; agentId: string }>();
  const navigate = useNavigate();
  if (!agentId) return null;
  const goBack = () => {
    // Prefer history-back when there's somewhere to go (e.g., user clicked
    // a card on AgentsPage); otherwise fall back to the Agents list URL so
    // a hard-loaded detail link still has a meaningful close action.
    if (window.history.length > 1) navigate(-1);
    else navigate(`/ws/${wsId}/agents`);
  };
  return (
    <AgentDetailModal
      agentId={agentId}
      onClose={goBack}
      onDeleted={() => navigate(`/ws/${wsId}/agents`, { replace: true })}
    />
  );
}
