/**
 * Runtime-identity → slot credential resolution for the manager
 * credential-fetch route (`GET api/agent-manager/managed-agents/:id/credential`).
 *
 * Why this file exists: P4c-4 removed the Agent table — and with it the
 * endpoint that resolved a managed agent's `credential_id` through its Agent
 * row. The manager side (`fetchAgentCredential`, `spawn_agent`,
 * `restart_agent`) still calls that route, so since the removal every one of
 * those calls 404s and every slot-declared credential silently degrades to
 * the operator-HOME fallback. The UI keeps accepting a credential on every
 * roster slot while dispatch only honors it for Agent Sessions (which use
 * their own credential route) — "same interface, works in one place, fails
 * in another".
 *
 * This resolver replaces the Agent-row lookup with a slot lookup: a runtime
 * identity key is functionally determined by its spec, so the slot holding
 * that identity IS the credential grant a human already made when they built
 * the roster. Sources, in order:
 *   1. mission runtime rosters (`runtime_roster`) — a team slot has no folder,
 *      so its identities exist per mission: the slot in each project folder,
 *      frozen when the mission started (orchestration-roster.ts)
 *   2. legacy identities recorded on team rows from when slots declared their
 *      own folder (`orchestrator_agent_id` / member `agent_id`), and mission
 *      ad-hoc members from then (`extra_member_specs[].agent_id`)
 *   3. ticket assignees (`assignee`, matched by denormalized `assignee_key`)
 *   4. chat participant inline specs (`runtime_spec`)
 *
 * All matches are returned — the caller filters by the calling host, because
 * the identity hash does NOT include the host and the same spec can exist on
 * several machines. The credential_id is functionally determined by the key
 * (it is a hash input), so every same-host match agrees on it.
 */

import { DataSource, In } from 'typeorm';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { Ticket } from '../../entities/Ticket';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { readRuntimeRoster } from '../orchestration/orchestration-roster';

export interface SlotCredentialSource {
  /** credential_id from the slot spec. null = operator-HOME fallback (204). */
  credential_id: string | null;
  /** Host running this slot — must equal the calling manager's host. */
  manager_agent_id: string;
  /** Owner scope for the credential-visibility check (team / mission / ticket / room account). */
  account_id: string | null;
  /** Human label for logs (`team "<name>" orchestrator`, …). */
  label: string;
}

function str(value: unknown): string {
  return value == null ? '' : String(value).trim();
}

function readSlotRef(spec: unknown): { credential_id: string | null; manager_agent_id: string } | null {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return null;
  const raw = spec as Record<string, unknown>;
  const managerAgentId = str(raw.manager_agent_id);
  if (!managerAgentId) return null;
  return { credential_id: str(raw.credential_id) || null, manager_agent_id: managerAgentId };
}

function readExtraMembers(value: unknown): Array<Record<string, any>> {
  if (!value) return [];
  let arr: unknown = value;
  if (typeof arr === 'string') {
    try {
      arr = JSON.parse(arr);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return (arr as any[]).filter((e) => e && typeof e === 'object' && typeof (e as any).agent_id === 'string');
}

/**
 * Every slot anywhere that addresses `identityId`, across all four surfaces.
 * Pure lookup — authz (host ownership, account visibility) is the caller's job.
 */
export async function resolveSlotCredentialSources(
  dataSource: DataSource,
  identityId: string,
): Promise<SlotCredentialSource[]> {
  const id = str(identityId);
  if (!id) return [];
  const out: SlotCredentialSource[] = [];

  const memberRepo = dataSource.getRepository(OrchestrationTeamMember);
  const teamRepo = dataSource.getRepository(OrchestrationTeam);
  const missionRepo = dataSource.getRepository(OrchestrationMission);
  const ticketRepo = dataSource.getRepository(Ticket);
  const participantRepo = dataSource.getRepository(ChatRoomParticipant);
  const roomRepo = dataSource.getRepository(ChatRoom);

  // 1. mission runtime rosters — every (slot, project folder) runtime a started
  // mission resolved. Fetch only the columns needed and filter in JS: the
  // missions table is small and this route fires on spawn, never per dispatch.
  const missions = await missionRepo.find({ select: ['id', 'account_id', 'extra_member_specs', 'runtime_roster'] as any });
  for (const mission of missions) {
    const roster = readRuntimeRoster((mission as any)?.runtime_roster);
    for (const runtime of roster?.runtimes ?? []) {
      if (runtime.agent_id !== id) continue;
      const slot = runtime.slot_id === 'orchestrator'
        ? roster!.orchestrator
        : roster!.members.find((m) => m.slot_id === runtime.slot_id);
      out.push({
        credential_id: runtime.spec.credential_id,
        manager_agent_id: runtime.spec.manager_agent_id,
        account_id: (mission as any)?.account_id ?? null,
        label: `mission "${String((mission as any)?.id ?? '').slice(0, 8)}" ${slot?.name ?? runtime.slot_id}`,
      });
    }
  }

  // 2a. legacy team member identities — stored agent_id was the identity key.
  const members = await memberRepo.find({ where: { agent_id: id } });
  if (members.length > 0) {
    const teams = await teamRepo.find({ where: { id: In(Array.from(new Set(members.map((m) => m.team_id)))) } });
    const teamById = new Map(teams.map((t) => [t.id, t]));
    for (const m of members) {
      const ref = readSlotRef((m as any)?.spec);
      if (!ref) continue;
      const team = teamById.get(m.team_id);
      out.push({
        credential_id: ref.credential_id,
        manager_agent_id: ref.manager_agent_id,
        account_id: team?.account_id ?? null,
        label: `team "${team?.name ?? m.team_id}" member "${(m as any)?.role_label || id.slice(0, 8)}"`,
      });
    }
  }

  // 2b. legacy team orchestrator identities.
  const orchTeams = await teamRepo.find({ where: { orchestrator_agent_id: id } });
  for (const t of orchTeams) {
    const ref = readSlotRef((t as any)?.orchestrator_spec);
    if (!ref) continue;
    out.push({
      credential_id: ref.credential_id,
      manager_agent_id: ref.manager_agent_id,
      account_id: t.account_id ?? null,
      label: `team "${t.name}" orchestrator`,
    });
  }

  // 2c. legacy mission ad-hoc members (they carried their identity key).
  for (const mission of missions) {
    for (const extra of readExtraMembers((mission as any)?.extra_member_specs)) {
      if (String(extra.agent_id) !== id) continue;
      const ref = readSlotRef(extra.spec);
      if (!ref) continue;
      out.push({
        credential_id: ref.credential_id,
        manager_agent_id: ref.manager_agent_id,
        account_id: (mission as any)?.account_id ?? null,
        label: `mission "${(mission as any)?.id?.slice?.(0, 8) ?? ''}" ad-hoc member "${extra.role_label || id.slice(0, 8)}"`,
      });
    }
  }

  // 3. ticket assignees — assignee_key is the denormalized identity, indexed.
  // Only open tickets can dispatch, so closed history is irrelevant.
  const tickets = await ticketRepo.find({
    where: { assignee_key: id } as any,
    order: { updated_at: 'DESC' } as any,
    take: 5,
  });
  for (const ticket of tickets) {
    if ((ticket as any)?.status === 'done' || (ticket as any)?.archived_at) continue;
    const ref = readSlotRef((ticket as any)?.assignee);
    if (!ref) continue;
    out.push({
      credential_id: ref.credential_id,
      manager_agent_id: ref.manager_agent_id,
      account_id: (ticket as any)?.account_id ?? null,
      label: `ticket "${String((ticket as any)?.id ?? '').slice(0, 8)}" assignee`,
    });
  }

  // 4. chat participant inline specs.
  const participations = await participantRepo.find({
    where: { participant_id: id } as any,
    order: { joined_at: 'DESC' } as any,
    take: 5,
  });
  const liveSpecs = participations.filter((p) => readSlotRef((p as any)?.runtime_spec));
  if (liveSpecs.length > 0) {
    const rooms = await roomRepo.find({
      where: { id: In(Array.from(new Set(liveSpecs.map((p) => (p as any).room_id)))) },
    });
    const roomById = new Map(rooms.map((r) => [(r as any).id, r]));
    for (const p of liveSpecs) {
      const ref = readSlotRef((p as any)?.runtime_spec)!;
      out.push({
        credential_id: ref.credential_id,
        manager_agent_id: ref.manager_agent_id,
        account_id: (roomById.get((p as any).room_id) as any)?.account_id ?? null,
        label: `chat room "${String((p as any)?.room_id ?? '').slice(0, 8)}" participant`,
      });
    }
  }

  return out;
}
