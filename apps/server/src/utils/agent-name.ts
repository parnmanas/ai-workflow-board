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

import { In, type DataSource, type EntityManager } from 'typeorm';
import { RuntimeHost } from '../entities/RuntimeHost';
import { ApiKey } from '../entities/ApiKey';

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

export type IdentityScope = Pick<DataSource, 'getRepository'> | Pick<EntityManager, 'getRepository'>;

/**
 * P4c-4: Agent 테이블 제거 이후의 표시명 해소. uuid id → RuntimeHost 행 이름,
 * 없으면 api_keys 페어링 링크의 Host 이름, 둘 다 없으면 맵에서 빠진다
 * (호출자는 저장된 denormalized 이름으로 폴백). `<Manager>/<Agent>` prefix 는
 * Host 자체가 정체성이므로 더 이상 붙이지 않는다.
 */
async function hostNameById(
  scope: IdentityScope,
  ids: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const distinct = Array.from(new Set(ids.filter(isUuidShapedId)));
  if (distinct.length === 0) return out;
  const [hosts, keys] = await Promise.all([
    scope.getRepository(RuntimeHost).find({
      where: { id: In(distinct) },
      select: { id: true, name: true },
    }),
    scope.getRepository(ApiKey).find({
      where: [{ agent_id: In(distinct) }, { host_id: In(distinct) }],
      select: { agent_id: true, host_id: true },
    }),
  ]);
  const hostName = new Map(hosts.map((h) => [h.id, h.name]));
  for (const h of hosts) {
    if (h.name) out.set(h.id, h.name);
  }
  if (keys.length > 0) {
    const linkedHostIds = [...new Set(keys.map((k) => k.host_id).filter((x): x is string => !!x))];
    if (linkedHostIds.length > 0) {
      const linked = await scope.getRepository(RuntimeHost).find({
        where: { id: In(linkedHostIds) },
        select: { id: true, name: true },
      });
      for (const h of linked) hostName.set(h.id, h.name);
    }
    for (const k of keys) {
      if (k.agent_id && k.host_id && !out.has(k.agent_id)) {
        const n = hostName.get(k.host_id);
        if (n) out.set(k.agent_id, n);
      }
    }
  }
  return out;
}

export async function resolveAgentDisplayMap(
  scope: IdentityScope,
  agents: Array<{ id: string; name?: string | null }>,
): Promise<Map<string, string>> {
  const names = await hostNameById(scope, agents.map((a) => a.id));
  const out = new Map<string, string>();
  for (const a of agents) {
    out.set(a.id, names.get(a.id) ?? ((a.name || '').trim() || a.id.slice(0, 8)));
  }
  return out;
}

export async function resolveAgentDisplayName(
  scope: IdentityScope,
  agentId: string,
): Promise<string | null> {
  // 비-uuid actor id 는 정의상 조회 대상이 아니다 (기존 UUID_RE 가드 유지 —
  // Postgres uuid 컬럼 throw 방지).
  if (!isUuidShapedId(agentId)) return null;
  const names = await hostNameById(scope, [agentId]);
  return names.get(agentId) ?? null;
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
  scope: IdentityScope,
  ids: Array<string | null | undefined>,
): Promise<Map<string, string>> {
  // Keep only UUID-shaped ids — a non-uuid actor id (system label, rt- key)
  // is simply ABSENT from the map. See UUID_RE note above.
  return hostNameById(scope, Array.from(new Set(ids.filter((x): x is string => !!x))));
}
