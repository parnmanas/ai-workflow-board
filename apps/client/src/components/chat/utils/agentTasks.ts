import type { AgentCurrentTask, DashboardAgent } from '../../../types';
import type { MentionParticipant } from './markdown';

export function normalizeAgentTasks(agent?: Pick<DashboardAgent, 'active_tasks' | 'current_task'> | null): AgentCurrentTask[] {
  if (!agent) return [];
  if (agent.active_tasks && agent.active_tasks.length > 0) return agent.active_tasks;
  return agent.current_task ? [agent.current_task] : [];
}

export function getDmAgentPartnerId(options: {
  roomType?: string | null;
  participants: MentionParticipant[];
  currentUserId?: string;
  isObserver: boolean;
}): string | null {
  const { roomType, participants, currentUserId, isObserver } = options;
  if (roomType !== 'dm' || isObserver || !currentUserId) return null;
  const others = participants.filter((participant) => !(participant.type === 'user' && participant.id === currentUserId));
  return others.length === 1 && others[0].type === 'agent' ? others[0].id : null;
}
