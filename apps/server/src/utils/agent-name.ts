// Server-side mirror of apps/client/src/utils/agentName.ts.
//
// Whenever the server returns an agent display string the UI will render
// (chat sender_name / dm_partner_name / participant.name, comment author,
// focus badge, agent log row, agent-manager instance label, …) it must use
// the same `<Manager>/<Agent>` format the AI Agents listing already uses,
// so the user sees one stable identity for every agent across the site.
//
// Two flavours:
//   - formatAgentDisplayName({ name, manager_name }) — pure formatter for
//     callers that already resolved the manager.
//   - resolveAgentDisplayMap(repo, agents) — batched (id → display) for
//     list endpoints; one extra `agents` query for every distinct manager.

import { In, Repository } from 'typeorm';
import { Agent } from '../entities/Agent';

const SEPARATOR = '/';

export interface AgentDisplayInput {
  name?: string | null;
  manager_name?: string | null;
}

export function formatAgentDisplayName(agent: AgentDisplayInput | null | undefined): string {
  if (!agent) return '(unknown)';
  const name = (agent.name ?? '').trim();
  const mgr = (agent.manager_name ?? '').trim();
  if (!name) return '(unnamed)';
  return mgr ? `${mgr}${SEPARATOR}${name}` : name;
}

export async function resolveAgentDisplayMap(
  agentRepo: Repository<Agent>,
  agents: Array<Pick<Agent, 'id' | 'name' | 'manager_agent_id'>>,
): Promise<Map<string, string>> {
  const managerIds = Array.from(new Set(
    agents.map(a => a.manager_agent_id).filter((id): id is string => !!id),
  ));
  const managerNameById = new Map<string, string>();
  if (managerIds.length > 0) {
    const managers = await agentRepo.find({
      where: { id: In(managerIds) } as any,
      select: { id: true, name: true } as any,
    });
    for (const m of managers) managerNameById.set(m.id, m.name);
  }
  const out = new Map<string, string>();
  for (const a of agents) {
    out.set(a.id, formatAgentDisplayName({
      name: a.name,
      manager_name: a.manager_agent_id ? managerNameById.get(a.manager_agent_id) ?? null : null,
    }));
  }
  return out;
}

export async function resolveAgentDisplayName(
  agentRepo: Repository<Agent>,
  agentId: string,
): Promise<string | null> {
  const agent = await agentRepo.findOne({ where: { id: agentId } });
  if (!agent) return null;
  const map = await resolveAgentDisplayMap(agentRepo, [agent]);
  return map.get(agent.id) ?? agent.name;
}
