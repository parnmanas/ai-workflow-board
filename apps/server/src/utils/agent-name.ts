// Server-side mirror of apps/client/src/utils/agentName.ts.
//
// CONTRACT + CHECKLIST: docs/runbooks/agent-display-name.md — read it
// before adding any surface that renders an agent name. Rendering a bare
// `agent.name` (or a raw agent id) is a bug: the same leaf name legitimately
// exists under multiple managers, so the prefix is what disambiguates them.
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

// Agent.id is `@PrimaryGeneratedColumn('uuid')`, so every real agent id is a
// canonical UUID. Non-UUID actor ids — system labels ('system',
// 'auto-advance', 'manual by …'), user ids that happen to be non-uuid, deleted
// rows — are by definition NOT agents. Filtering them out before the
// `Agent.id IN (...)` lookup is required for correctness on Postgres, where the
// id column is a real `uuid` type: a stray 'system' in the IN list makes the
// whole query throw `invalid input syntax for type uuid` and takes down the
// entire activity-feed read (the audit surface this trigger-loss work relies
// on). On SQLite the IN(text) would silently match nothing, so this narrowing
// is behaviour-preserving there and load-bearing on Postgres. Matches the
// documented contract of resolveAgentDisplayNamesByIds: non-agent ids are
// "simply ABSENT from the map".
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 같은 판정을 필요로 하는 다른 엔티티 조회를 위한 술어. `User.id` 도
// `@PrimaryGeneratedColumn('uuid')` 라 Postgres 에서 real uuid 컬럼이고, 비-uuid
// id 를 findOne 에 그대로 넘기면 위와 똑같이 throw 한다(ticket a825872b —
// comment 작성자 이름 해석). 그 호출자가 정규식을 새로 만들지 않도록 술어만
// 내보낸다. **UUID_RE 자체를 export 하지 말 것**: `common/artifact-ref.ts` 가
// 같은 이름으로 version/variant nibble 까지 고정한 더 엄격한 정규식을 이미
// export 하고 있어, 혼동해 import 하면 Postgres 가 받아들이는 uuid 를 거짓
// 거부해 이름이 조용히 폴백된다.
export function isUuidShapedId(id: string | null | undefined): id is string {
  return !!id && UUID_RE.test(id);
}

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
  // 비-uuid actor id 는 정의상 Agent 가 아니다 — 같은 UUID_RE 가드를 배치 형제
  // resolveAgentDisplayNamesByIds 가 이미 쓰고 있고, 단일 id 경로만 남아 있었다.
  // Postgres 에서 Agent.id 는 real uuid 라 'system'/'auto-advance' 로 findOne 하면
  // `invalid input syntax for type uuid` 로 **throw** 해 호출자를 끌고 내려간다:
  // board_update SSE 매핑이 그 throw 를 먹고 프레임을 통째로 유실했다.
  // sqlite 에서는 어차피 매칭되는 행이 없어 null 이었으므로 동작 보존이다.
  if (!isUuidShapedId(agentId)) return null;
  const agent = await agentRepo.findOne({ where: { id: agentId } });
  if (!agent) return null;
  const map = await resolveAgentDisplayMap(agentRepo, [agent]);
  return map.get(agent.id) ?? agent.name;
}

/**
 * Batched (actorId → canonical display) for an arbitrary set of ids that MAY
 * or MAY NOT be agents. Loads the ids that resolve to an Agent row, then their
 * managers, and returns the `<Manager>/<Agent>` (or bare-name) display keyed by
 * agent id. Ids that are not agents — user ids, system labels, deleted rows —
 * are simply ABSENT from the map, so a caller reading a denormalized snapshot
 * can do `map.get(actor_id) ?? storedName` and leave non-agent actors
 * untouched. Used by the read side (ActivityService) to re-canonicalize
 * `actor_name` without a backfill on the high-churn activity_logs table.
 */
export async function resolveAgentDisplayNamesByIds(
  agentRepo: Repository<Agent>,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  // Keep only UUID-shaped ids — a non-uuid actor id (system label, deleted
  // row) can never be an Agent.id, and passing it to `Agent.id IN (...)` throws
  // on Postgres (uuid column). See UUID_RE note above.
  const distinct = Array.from(new Set(ids.filter(isUuidShapedId)));
  if (distinct.length === 0) return new Map();
  const agents = await agentRepo.find({
    where: { id: In(distinct) } as any,
    select: { id: true, name: true, manager_agent_id: true } as any,
  });
  return resolveAgentDisplayMap(agentRepo, agents);
}
