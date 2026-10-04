import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { Repository, In, DataSource } from 'typeorm';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { WorkspaceRole } from '../../entities/WorkspaceRole';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { User } from '../../entities/User';
import { Ticket } from '../../entities/Ticket';
import { resolveAgentDisplayName, resolveAgentDisplayNamesByIds } from '../../utils/agent-name';
import { resolveCallerIdentityRow } from '../mcp/shared/authz';
import type { DefaultRoleAssignments } from '../../common/default-role-assignments-config';
import { parseDefaultRoleAssignments } from '../../common/default-role-assignments-config';
import {
  computeHolderKey,
  holderAssigneeId,
  isRuntimeIdentityKey,
  normalizeRuntimeSpec,
  runtimeIdentityKey,
  type HolderRef,
  type RuntimeSpec,
} from '../../common/runtime-spec';
import { isUuidShapedId } from '../../utils/agent-name';
import { agentIsVisibleInWorkspace } from '../../common/agent-workspace-scope';

/**
 * Builtin role slug → the flat legacy Ticket column(s) that mirror it. The
 * normalized `ticket_role_assignments` table is the single source of truth
 * (ticket da39d1da); these flat columns are a denormalized projection the
 * service keeps in lockstep so the surfaces that still read them never
 * disagree with the assignment table:
 *   - board cards / MCP `get_board` (read `t.assignee`)
 *   - MCP `get_board_summary` (`assignee: t.assignee || 'unassigned'`)
 *   - MCP `get_my_tickets` (its SQL WHERE FILTERS on `assignee_id` /
 *     `reporter_id` / `reviewer_id` — a normalized-only holder was excluded
 *     from the assignee's own ticket list, the dispatch-loss red herring).
 * Custom (non-builtin) slugs have no flat column. `reviewer` intentionally has
 * only an id column — there is no `reviewer` display-name column.
 */
const LEGACY_SLUG_COLUMNS: Record<
  string,
  { id: 'assignee_id' | 'reporter_id' | 'reviewer_id'; name?: 'assignee' | 'reporter' }
> = {
  assignee: { id: 'assignee_id', name: 'assignee' },
  reporter: { id: 'reporter_id', name: 'reporter' },
  reviewer: { id: 'reviewer_id' },
};

export interface ResolvedAssignment {
  assignment: TicketRoleAssignment;
  role: WorkspaceRole;
  holder: { type: 'agent' | 'user'; id: string; name: string } | null;
}

/** One role with ALL of its holders — the multi-holder (T1) view. */
export interface ResolvedRoleHolders {
  role: WorkspaceRole;
  holders: Array<{ type: 'agent' | 'user'; id: string; name: string }>;
}

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}



/**
 * Read/write helper for `ticket_role_assignments`. Centralizes the
 * (ticket_id, role_id) → holder lookup so the trigger loop, allocation
 * service, notification service, ticket CRUD, and MCP tools all share one
 * implementation of "who holds role X on ticket Y."
 *
 * MULTI-HOLDER (다중담당자 T1): a role may now carry several holders. Two
 * families of write helpers:
 *   - `setHolder()` / `syncBuiltinTrio()` — SINGLE-holder authoritative. They
 *     make the given holder the *sole* occupant of the role (clearing any
 *     others), preserving the exact v1 semantics every current consumer
 *     depends on. Passing both null clears the whole slot.
 *   - `addHolder()` / `removeHolder()` / `setHolders()` — MULTI-holder. They
 *     add/remove/replace individual holders without disturbing siblings.
 *
 * Setting a holder is upsert-style: passing `agent_id`/`user_id` writes the
 * row (keyed by `holder_key`), passing both null clears it (deletes the
 * assignment row outright — we don't keep empty rows around because the
 * absence-of-a-row already means "vacant" everywhere else in the codebase).
 *
 * Single-holder consumers (trigger loop / allocation / mention) read the
 * FIRST holder via `getHolderBySlug()` / `getOne()` shims until the T2
 * fan-out teaches them to iterate every holder.
 */
@Injectable()
export class TicketRoleAssignmentService {
  constructor(
    @InjectRepository(TicketRoleAssignment)
    private readonly assignRepo: Repository<TicketRoleAssignment>,

    @InjectRepository(WorkspaceRole)
    private readonly roleRepo: Repository<WorkspaceRole>,

    @InjectDataSource()
    private readonly dataSource: DataSource,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Ticket)
    private readonly ticketRepo: Repository<Ticket>,
  ) {}

  private async assertAgentsVisibleForTicket(ticketId: string, agentIds: string[]): Promise<void> {
    const ids = [...new Set(agentIds.filter(Boolean))];
    if (ids.length === 0) return;
    const ticket = await this.ticketRepo.findOne({ where: { id: ticketId }, select: ['id', 'workspace_id'] });
    if (!ticket) throw makeError(404, `ticket ${ticketId} not found`);
    // P4c-4: Host/링크 해소 후 workspace 가시성 검사 (Agent 행 없음).
    for (const id of ids) {
      const holder = await resolveCallerIdentityRow(this.dataSource, id);
      if (!holder) throw makeError(400, `agent ${id} not found`);
      if (!agentIsVisibleInWorkspace(holder.workspace_id, ticket.workspace_id)) {
        throw makeError(400, `agent ${id} belongs to a different workspace`);
      }
    }
  }

  /**
   * Re-project a builtin role's FIRST holder onto the ticket's flat legacy
   * columns after a normalized write, so the two never diverge (ticket
   * da39d1da). This is what makes `ticket_role_assignments` the single source
   * of truth: every mutating write helper below calls this, and the flat
   * columns become a materialized view of it — so board / summary / my_tickets
   * (which all read the flat columns) always agree with the assignment table.
   *
   * Multi-holder: a flat column holds ONE id/name, so it mirrors the earliest-
   * created holder — the same "first holder" single-holder consumers (trigger
   * loop / allocation / mention) already read via `getOne`. A vacant role
   * clears the columns to ''. Non-builtin slugs (no flat column) are a no-op.
   *
   * Display name matches the create/update write path and the REST role
   * endpoint mirror: agents resolve to canonical `<Manager>/<Agent>` via
   * `resolveAgentDisplayName`, users to `name || email`.
   */
  private async syncFlatColumnsForRole(ticketId: string, role: WorkspaceRole): Promise<void> {
    const mirror = LEGACY_SLUG_COLUMNS[role.slug];
    if (!mirror) return; // custom role — no flat column to keep in sync

    const first = await this.getOne(ticketId, role.id);
    let newId = '';
    let newName = '';
    if (first?.agent_id) {
      newId = first.agent_id;
      newName = (await resolveAgentDisplayName(this.dataSource, first.agent_id)) ?? '';
    } else if (first && isRuntimeIdentityKey(holderAssigneeId(first))) {
      // P4c-2b: spec-direct holder — flat id에 rt 키, 이름에 스냅샷 라벨.
      // 레거시 리더(보드 카드, get_my_tickets)는 varchar 비교라 안전하다.
      newId = holderAssigneeId(first) as string;
      const spec = first.runtime_spec as any;
      newName = (spec?.label || '').trim() || newId.slice(0, 11);
    } else if (first?.user_id) {
      newId = first.user_id;
      const u = await this.userRepo.findOne({ where: { id: first.user_id } });
      newName = u ? (u.name || u.email) : '';
    }

    const update: Record<string, string> = { [mirror.id]: newId };
    if (mirror.name) update[mirror.name] = newName;
    await this.ticketRepo.update(ticketId, update);
  }

  /** Raw assignment rows for a ticket. */
  async listForTicket(ticketId: string): Promise<TicketRoleAssignment[]> {
    return this.assignRepo.find({ where: { ticket_id: ticketId } });
  }

  /**
   * Resolve assignments + role definitions + holder display info for a
   * ticket. Single batched query path so callers don't N+1.
   */
  async resolveForTicket(ticketId: string): Promise<ResolvedAssignment[]> {
    const rows = await this.listForTicket(ticketId);
    if (rows.length === 0) return [];

    const roleIds = [...new Set(rows.map(r => r.role_id))];
    const agentIds = [...new Set(rows.map(r => r.agent_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map(r => r.user_id).filter((x): x is string => !!x))];

    const [roles, users] = await Promise.all([
      this.roleRepo.find({ where: { id: In(roleIds) } }),
      userIds.length ? this.userRepo.find({ where: { id: In(userIds) } }) : Promise.resolve([] as User[]),
    ]);

    const roleMap = new Map(roles.map(r => [r.id, r]));
    const userMap = new Map(users.map(u => [u.id, u]));
    // P4c-4: uuid holder 표시는 Host/링크 이름으로 해소한다 (Agent 테이블 없음).
    // 못 찾으면 id 앞 8자리로 폴백 — holder 자체는 유지된다.
    const agentDisplayById = await resolveAgentDisplayNamesByIds(this.dataSource, agentIds);

    return rows
      .map(r => {
        const role = roleMap.get(r.role_id);
        if (!role) return null;
        let holder: ResolvedAssignment['holder'] = null;
        if (r.agent_id) {
          holder = { type: 'agent', id: r.agent_id, name: agentDisplayById.get(r.agent_id) ?? r.agent_id.slice(0, 8) };
        } else if (!r.agent_id && !r.user_id && isRuntimeIdentityKey(holderAssigneeId(r))) {
          // P4c-2b: spec-direct holder — agent 행 없이 라벨로 표시한다.
          // P4c-4: runtime 스냅샷도 함께 내려 TicketPanel draft가 재지정 없이
          // round-trip할 수 있게 한다.
          const rtId = holderAssigneeId(r) as string;
          const spec = r.runtime_spec as any;
          holder = {
            type: 'agent',
            id: rtId,
            name: (spec?.label || '').trim() || rtId.slice(0, 11),
            ...(spec && typeof spec === 'object' ? { runtime: { ...spec } } : {}),
          } as ResolvedAssignment['holder'];
        } else if (r.user_id && userMap.has(r.user_id)) {
          const u = userMap.get(r.user_id)!;
          holder = { type: 'user', id: u.id, name: u.name || u.email };
        }
        return { assignment: r, role, holder };
      })
      .filter((x): x is ResolvedAssignment => !!x)
      .sort((a, b) => a.role.position - b.role.position);
  }

  /**
   * Same data as `resolveForTicket` but grouped by role into a `holders[]`
   * array — the multi-holder (T1) shape the UI (T6) and consensus gate (T3)
   * consume. The flat `resolveForTicket` is kept for the existing single-holder
   * callers (author-role badge, REST role-assignments projection) that filter
   * row-by-row; this grouped view is the additive multi-holder accessor.
   */
  async resolveGroupedForTicket(ticketId: string): Promise<ResolvedRoleHolders[]> {
    const flat = await this.resolveForTicket(ticketId);
    const byRole = new Map<string, ResolvedRoleHolders>();
    for (const r of flat) {
      let group = byRole.get(r.role.id);
      if (!group) {
        group = { role: r.role, holders: [] };
        byRole.set(r.role.id, group);
      }
      if (r.holder) group.holders.push(r.holder);
    }
    return [...byRole.values()].sort((a, b) => a.role.position - b.role.position);
  }

  /**
   * Board-wide batched multi-holder view: `resolveGroupedForTicket` for MANY
   * tickets in one shot (4 queries total — assignments + roles + agents + users),
   * returned as `ticketId → ResolvedRoleHolders[]`. Feeds the board-card
   * projection (T6 multi-avatar) without N+1 per-card lookups. Tickets with no
   * assignment are simply absent from the map (caller defaults to `[]`).
   */
  async resolveGroupedForTickets(ticketIds: string[]): Promise<Map<string, ResolvedRoleHolders[]>> {
    const result = new Map<string, ResolvedRoleHolders[]>();
    if (ticketIds.length === 0) return result;

    const rows = await this.assignRepo.find({ where: { ticket_id: In(ticketIds) } });
    if (rows.length === 0) return result;

    const roleIds = [...new Set(rows.map(r => r.role_id))];
    const agentIds = [...new Set(rows.map(r => r.agent_id).filter((x): x is string => !!x))];
    const userIds = [...new Set(rows.map(r => r.user_id).filter((x): x is string => !!x))];

    const [roles, users] = await Promise.all([
      this.roleRepo.find({ where: { id: In(roleIds) } }),
      userIds.length ? this.userRepo.find({ where: { id: In(userIds) } }) : Promise.resolve([] as User[]),
    ]);
    const roleMap = new Map(roles.map(r => [r.id, r]));
    const userMap = new Map(users.map(u => [u.id, u]));
    // P4c-4: uuid holder 표시는 Host/링크 이름으로 해소한다 (Agent 테이블 없음).
    const agentDisplayById = await resolveAgentDisplayNamesByIds(this.dataSource, agentIds);

    // ticketId → (roleId → group). Preserves per-ticket role grouping while
    // keeping insertion cheap; sorted by role.position on the way out.
    const byTicket = new Map<string, Map<string, ResolvedRoleHolders>>();
    for (const r of rows) {
      const role = roleMap.get(r.role_id);
      if (!role) continue;
      let holder: { type: 'agent' | 'user'; id: string; name: string } | null = null;
      if (r.agent_id) {
        holder = { type: 'agent', id: r.agent_id, name: agentDisplayById.get(r.agent_id) ?? r.agent_id.slice(0, 8) };
      } else if (r.user_id && userMap.has(r.user_id)) {
        const u = userMap.get(r.user_id)!;
        holder = { type: 'user', id: u.id, name: u.name || u.email };
      }
      if (!holder) continue;
      let roleGroups = byTicket.get(r.ticket_id);
      if (!roleGroups) { roleGroups = new Map(); byTicket.set(r.ticket_id, roleGroups); }
      let group = roleGroups.get(role.id);
      if (!group) { group = { role, holders: [] }; roleGroups.set(role.id, group); }
      group.holders.push(holder);
    }
    for (const [ticketId, roleGroups] of byTicket) {
      result.set(ticketId, [...roleGroups.values()].sort((a, b) => a.role.position - b.role.position));
    }
    return result;
  }

  /**
   * Lookup the FIRST assignment for one (ticket, role) pair, or null.
   *
   * With multi-holder a role can now own several rows; single-holder consumers
   * (trigger loop / allocation / mention via `getHolderBySlug`) call this as a
   * shim and get the earliest-created holder deterministically. Explicit order
   * matters — an unordered findOne would pick a nondeterministic row once a
   * role has 2+ holders. Real fan-out (iterate every holder) arrives in T2.
   */
  async getOne(ticketId: string, roleId: string): Promise<TicketRoleAssignment | null> {
    return this.assignRepo.findOne({
      where: { ticket_id: ticketId, role_id: roleId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  /** ALL holder rows for one (ticket, role) pair, earliest-created first. */
  async getAll(ticketId: string, roleId: string): Promise<TicketRoleAssignment[]> {
    return this.assignRepo.find({
      where: { ticket_id: ticketId, role_id: roleId },
      order: { created_at: 'ASC', id: 'ASC' },
    });
  }

  /**
   * Agent Manager(type='manager')는 절대 작업하지 않는다 (ticket 941c72d3) —
   * supervisor 로서 agent 를 spawn/stop 할 뿐, 티켓의 role holder 가 될 수 없다.
   * 단건 확인용.
   */
  private async isManagerAgent(agentId: string | null | undefined): Promise<boolean> {
    // P4c-4: Agent 테이블 없음 — manager 행 자체가 존재하지 않으므로 항상 false.
    // (941c72d3 규칙의 검사 대상이 사라졌다. Host uuid holder 는 실행 위치이지
    // supervisor 행이 아니라 허용한다.)
    void agentId;
    return false;
  }

  /**
   * 주어진 agent_id 들 중 manager(type='manager')인 것들의 집합을 한 번의 질의로
   * 반환. 여러 holder 를 한꺼번에 거를 때 사용 (ticket 941c72d3).
   * P4c-2b: rt- identity는 Agent 행이 될 수 없어 조회에서 제외한다 (Postgres는
   * uuid 컬럼에 비-uuid를 넣으면 throw한다).
   */
  private async managerAgentIdSet(
    agentIds: Array<string | null | undefined>,
  ): Promise<Set<string>> {
    // P4c-4: Agent 테이블 없음 — 항상 빈 집합.
    void agentIds;
    return new Set();
  }

  /**
   * P4c-2b: holder 입력 정규화. agent_id/user_id/runtime 중 정확히 하나 —
   * 둘 이상이면 400. runtime shape 오류도 400으로 감싼다. 반환된 runtime은
   * 정규화된 RuntimeSpec (스냅샷 저장용) 또는 null.
   */
  private normalizeHolderInput(holder: HolderRef): {
    agent_id: string | null;
    user_id: string | null;
    runtime: RuntimeSpec | null;
  } {
    const agent_id = holder.agent_id || null;
    const user_id = holder.user_id || null;
    const hasRuntime = holder.runtime !== undefined && holder.runtime !== null;
    const setCount = (agent_id ? 1 : 0) + (user_id ? 1 : 0) + (hasRuntime ? 1 : 0);
    if (setCount > 1) {
      throw makeError(400, 'cannot set more than one of agent_id, user_id, runtime on the same role assignment');
    }
    let runtime: RuntimeSpec | null = null;
    if (hasRuntime) {
      try {
        runtime = normalizeRuntimeSpec(holder.runtime, 'holder.runtime');
      } catch (e: any) {
        throw makeError(400, e?.message || 'invalid holder.runtime');
      }
    }
    return { agent_id, user_id, runtime };
  }

  /**
   * SINGLE-holder authoritative set. Makes `holder` the *sole* occupant of the
   * role on the ticket (clearing any other holders); passing both null clears
   * the whole slot. This preserves the exact v1 semantics every current
   * consumer depends on — even if a role has since gained extra holders via the
   * multi-holder path, `setHolder` collapses it back to one. Mutually exclusive
   * agent_id / user_id.
   *
   * Caller is responsible for verifying the holder exists in the right
   * workspace — this helper accepts the IDs as-is and only enforces the
   * mutual-exclusion shape.
   */
  async setHolder(
    ticketId: string,
    roleId: string,
    holder: HolderRef,
  ): Promise<TicketRoleAssignment | null> {
    const { agent_id, user_id, runtime } = this.normalizeHolderInput(holder);

    // Manager(type='manager')는 role holder 가 될 수 없다 (ticket 941c72d3).
    // manager 만 지정된 경우는 무시 — 명시적 clear(둘 다 null)와 달리 기존
    // holder 를 지우지 않고 현 상태를 그대로 보존한다(엉뚱한 wipe 방지).
    if (agent_id && await this.isManagerAgent(agent_id)) {
      return this.getOne(ticketId, roleId);
    }
    if (agent_id) await this.assertAgentsVisibleForTicket(ticketId, [agent_id]);

    // Validate role exists (cheap; prevents orphan assignment rows)
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    // Authoritative: drop every existing holder of this role first, so the end
    // state is exactly "this one holder" (or vacant). Delete-then-insert also
    // sidesteps the (ticket_id, role_id, holder_key) unique key when switching
    // between holders.
    await this.assignRepo.delete({ ticket_id: ticketId, role_id: roleId });
    let saved: TicketRoleAssignment | null = null;
    if (agent_id || user_id || runtime) {
      // P4c-4: agent 홀더 스냅샷 없음 (Agent 행 없음 — runtime holder 만
      // spec 을 들고 간다).
      saved = await this.assignRepo.save(this.assignRepo.create({
        ticket_id: ticketId,
        role_id: roleId,
        agent_id,
        user_id,
        holder_key: computeHolderKey({ agent_id, user_id, runtime: runtime ?? undefined }),
        runtime_spec: runtime
          ? { ...runtime }
          : null,
      }));
    }
    // Keep the flat legacy columns in lockstep with the normalized write
    // (ticket da39d1da) — role already loaded above, so no extra role query.
    // Covers both set and clear (both null → columns blanked).
    await this.syncFlatColumnsForRole(ticketId, role);
    return saved;
  }

  /**
   * MULTI-holder: add one holder to a role WITHOUT disturbing existing holders.
   * Idempotent on (ticket, role, holder) — re-adding the same holder returns
   * the existing row instead of creating a duplicate (the unique key would
   * reject it anyway). Passing both null is a no-op. Mutually exclusive
   * agent_id / user_id.
   */
  async addHolder(
    ticketId: string,
    roleId: string,
    holder: HolderRef,
  ): Promise<TicketRoleAssignment | null> {
    const { agent_id, user_id, runtime } = this.normalizeHolderInput(holder);
    if (!agent_id && !user_id && !runtime) return null;
    // Manager(type='manager')는 role holder 가 될 수 없다 (ticket 941c72d3) — 무시.
    if (agent_id && await this.isManagerAgent(agent_id)) return null;
    if (agent_id) await this.assertAgentsVisibleForTicket(ticketId, [agent_id]);

    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    const holder_key = computeHolderKey({ agent_id, user_id, runtime: runtime ?? undefined });
    const existing = await this.assignRepo.findOne({
      where: { ticket_id: ticketId, role_id: roleId, holder_key },
    });
    if (existing) return existing; // no-op — first holder unchanged, flat already correct

    // P4c-4: agent 홀더 스냅샷 없음 (Agent 행 없음).
    const inserted = await this.assignRepo.save(this.assignRepo.create({
      ticket_id: ticketId,
      role_id: roleId,
      agent_id,
      user_id,
      holder_key,
      runtime_spec: runtime
        ? { ...runtime }
        : null,
    }));
    // Adding the FIRST holder of a vacant role changes the flat projection;
    // adding a later holder re-writes the same first-holder value (idempotent).
    // Either way keep the flat legacy columns in sync (ticket da39d1da).
    await this.syncFlatColumnsForRole(ticketId, role);
    return inserted;
  }

  /**
   * MULTI-holder: remove one specific holder from a role, leaving the rest in
   * place. No-op if that holder isn't currently on the role. Returns true iff a
   * row was actually deleted.
   */
  async removeHolder(
    ticketId: string,
    roleId: string,
    holder: HolderRef,
  ): Promise<boolean> {
    let holder_key: string;
    try {
      const n = this.normalizeHolderInput(holder);
      holder_key = computeHolderKey({ agent_id: n.agent_id, user_id: n.user_id, runtime: n.runtime ?? undefined });
    } catch {
      return false;
    }
    if (!holder_key) return false;
    const res = await this.assignRepo.delete({ ticket_id: ticketId, role_id: roleId, holder_key });
    const removed = (res.affected || 0) > 0;
    if (removed) {
      // Removing a holder can promote a new first holder or empty the role —
      // re-project the flat legacy columns (ticket da39d1da). role is not
      // loaded on this path, so fetch it (cheap; only when something changed).
      const role = await this.roleRepo.findOne({ where: { id: roleId } });
      if (role) await this.syncFlatColumnsForRole(ticketId, role);
    }
    return removed;
  }

  /**
   * MULTI-holder: replace the ENTIRE holder set of a role with `holders`.
   * Deletes holders no longer present and inserts new ones, leaving unchanged
   * holders untouched (so their created_at — the getOne "first holder" tiebreak
   * — is preserved). Passing `[]` clears the role. Duplicate holders in the
   * input are de-duplicated by holder_key. Mutually exclusive agent_id/user_id
   * per entry.
   */
  async setHolders(
    ticketId: string,
    roleId: string,
    holders: HolderRef[],
  ): Promise<TicketRoleAssignment[]> {
    const role = await this.roleRepo.findOne({ where: { id: roleId } });
    if (!role) throw makeError(404, `role ${roleId} not found`);

    // Manager(type='manager')는 role holder 가 될 수 없다 (ticket 941c72d3).
    // 교체 집합에서 미리 걸러낸다 — manager 만 넘어오면 결과적으로 슬롯이 빈다.
    const managerIds = await this.managerAgentIdSet(holders.map(h => h.agent_id));
    await this.assertAgentsVisibleForTicket(
      ticketId,
      holders.map(h => h.agent_id || '').filter(id => id && !managerIds.has(id)),
    );

    // Normalize + de-dupe the desired set, keeping the first occurrence.
    // P4c-2b: runtime 홀더는 정규화된 spec까지 함께 들고 다닌다.
    const desired = new Map<string, { agent_id: string | null; user_id: string | null; runtime: RuntimeSpec | null }>();
    for (const h of holders) {
      const { agent_id, user_id, runtime } = this.normalizeHolderInput(h);
      if (agent_id && managerIds.has(agent_id)) continue; // manager 는 holder 불가
      const key = computeHolderKey({ agent_id, user_id, runtime: runtime ?? undefined });
      if (!key) continue; // skip vacant entries
      if (!desired.has(key)) desired.set(key, { agent_id, user_id, runtime });
    }

    const existing = await this.getAll(ticketId, roleId);
    const existingKeys = new Set(existing.map(r => r.holder_key));

    // Delete rows whose holder is no longer desired.
    const toDelete = existing.filter(r => !desired.has(r.holder_key));
    if (toDelete.length) {
      await this.assignRepo.delete(toDelete.map(r => r.id));
    }

    // Insert rows for newly-desired holders.
    // P4c-4: agent 홀더 스냅샷 없음 (Agent 행 없음).
    const toInsert: TicketRoleAssignment[] = [];
    for (const [key, h] of desired) {
      if (existingKeys.has(key)) continue;
      toInsert.push(this.assignRepo.create({
        ticket_id: ticketId,
        role_id: roleId,
        agent_id: h.agent_id,
        user_id: h.user_id,
        holder_key: key,
        // P4c-4: agent 홀더 스냅샷 없음 (Agent 행 없음).
        runtime_spec: h.runtime
          ? { ...h.runtime }
          : null,
      }));
    }
    if (toInsert.length) await this.assignRepo.save(toInsert);

    // Replacing the holder set can change the first holder — re-project the
    // flat legacy columns (ticket da39d1da). role already loaded above. Only
    // when the set actually changed (avoids a redundant write on a no-op
    // replace); applyBoardDefaults reaches the flat columns through here.
    if (toDelete.length || toInsert.length) {
      await this.syncFlatColumnsForRole(ticketId, role);
    }

    return this.getAll(ticketId, roleId);
  }

  /** Holder lookup keyed by role slug — convenience for the trigger loop. */
  async getHolderBySlug(
    ticketId: string,
    workspaceId: string,
    slug: string,
  ): Promise<{ agent_id: string | null; user_id: string | null; role_id: string } | null> {
    const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
    if (!role) return null;
    const a = await this.getOne(ticketId, role.id);
    if (!a) return { agent_id: null, user_id: null, role_id: role.id };
    return { agent_id: a.agent_id, user_id: a.user_id, role_id: role.id };
  }

  /**
   * Mirror the v1 `(assignee_id, reporter_id, reviewer_id)` triple onto the
   * assignment table. Used by ticket create/update endpoints so newly
   * written tickets stay queryable by the trigger loop / allocation
   * service (which now read TicketRoleAssignment, not the legacy columns).
   *
   * Each of the three slug arguments is independently optional —
   * `undefined` means "leave the existing assignment untouched", empty
   * string means "clear the slot". This matches how the REST controller
   * receives `body.assignee_id` (string with empty = clear, missing =
   * unchanged on update). Holder type is auto-detected against agents/users.
   */
  async syncBuiltinTrio(
    ticketId: string,
    workspaceId: string,
    legacy: { assignee_id?: string; reporter_id?: string; reviewer_id?: string },
  ): Promise<void> {
    if (!workspaceId) return;
    const slugs: Array<[keyof typeof legacy, string]> = [
      ['assignee_id', 'assignee'],
      ['reporter_id', 'reporter'],
      ['reviewer_id', 'reviewer'],
    ];
    for (const [field, slug] of slugs) {
      const raw = legacy[field];
      if (raw === undefined) continue; // not in payload — preserve existing
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) continue; // workspace missing the builtin (shouldn't happen post-migration)
      if (!raw) {
        // Empty string → clear the slot
        await this.setHolder(ticketId, role.id, { agent_id: null, user_id: null });
        continue;
      }
      // Auto-detect agent vs user. Agents are checked first to match the
      // v1 default-fallback (legacy columns historically only stored agent IDs).
      // P4c-4: Host/링크 해소 (Agent 행 없음).
      const agentExists = await resolveCallerIdentityRow(this.dataSource, raw);
      if (agentExists) {
        await this.setHolder(ticketId, role.id, { agent_id: raw, user_id: null });
        continue;
      }
      const userExists = await this.userRepo.findOne({ where: { id: raw } });
      if (userExists) {
        await this.setHolder(ticketId, role.id, { agent_id: null, user_id: raw });
        continue;
      }
      // Orphan ID — store as agent_id to mirror v1 column semantics.
      await this.setHolder(ticketId, role.id, { agent_id: raw, user_id: null });
    }
  }

  /**
   * Keep only the holders whose agent/user still exists. A stale board default
   * config must never manufacture an orphan assignment row pointing at a
   * deleted agent/user. Batched (2 queries max). Agent-vs-user is mutually
   * exclusive per entry — an entry that names an agent that no longer exists is
   * dropped even if a user_id is also (illegally) present.
   */
  private async filterExistingHolders(
    holders: Array<{ agent_id?: string | null; user_id?: string | null; runtime?: unknown }>,
    workspaceId: string,
  ): Promise<HolderRef[]> {
    const agentIds = [...new Set(holders.map(h => (h.agent_id || '').trim()).filter(Boolean))];
    const userIds = [...new Set(holders.map(h => (h.user_id || '').trim()).filter(Boolean))];
    const users = userIds.length ? await this.userRepo.find({ where: { id: In(userIds) }, select: ['id'] }) : [];
    // P4c-4: Host/링크 해소 + workspace 가시성 (Agent 행 없음, manager 타입
    // 검사 없음 — Host uuid holder 허용).
    const agentSet = new Set<string>();
    for (const id of agentIds) {
      const row = await resolveCallerIdentityRow(this.dataSource, id);
      if (row && agentIsVisibleInWorkspace(row.workspace_id, workspaceId)) agentSet.add(id);
    }
    const userSet = new Set(users.map(u => u.id));
    const out: HolderRef[] = [];
    for (const h of holders) {
      const agent_id = (h.agent_id || '').trim();
      const user_id = (h.user_id || '').trim();
      // P4c-3b: runtime holders pass through (shape already normalized by
      // parseDefaultRoleAssignments; host existence was checked at board-save
      // by validateBoardDefaults).
      if (h.runtime !== undefined && h.runtime !== null) {
        out.push({ agent_id: null, user_id: null, runtime: h.runtime });
      } else if (agent_id && agentSet.has(agent_id)) out.push({ agent_id, user_id: null });
      else if (user_id && userSet.has(user_id)) out.push({ agent_id: null, user_id });
    }
    return out;
  }

  /**
   * Apply a board's DEFAULT role holders (ticket d94a1b87) to a freshly-created
   * ticket. For each slug in `defaults`, if the ticket currently has NO holder
   * for that role, the default holders are written; a role that already carries
   * ≥1 holder (an explicit assignment already synced via syncBuiltinTrio /
   * setHolders at the creation site) is left untouched. This encodes the
   * create-time priority **explicit holder > board default > unassigned**.
   *
   * Contract for callers: run this AFTER the explicit-assignment writes at
   * every root-ticket creation site (MCP create_ticket, REST POST, QA/Security
   * auto-ticket, feature chain). `defaults` is the already-parsed/normalized
   * map from `parseDefaultRoleAssignments(board.default_role_assignments)`.
   * Holders whose agent/user no longer exists are dropped (a stale board config
   * must never manufacture an orphan). Never touches existing tickets — only
   * the one just created. Returns a per-slug summary of what was applied (for
   * the caller's activity/log line); a slug absent from the result was already
   * held or had no valid default holder.
   */
  async applyBoardDefaults(
    ticketId: string,
    workspaceId: string,
    defaults: DefaultRoleAssignments,
  ): Promise<Array<{ slug: string; applied: number }>> {
    if (!workspaceId || !defaults) return [];
    const slugs = Object.keys(defaults);
    if (slugs.length === 0) return [];

    const summary: Array<{ slug: string; applied: number }> = [];
    for (const slug of slugs) {
      const holders = defaults[slug] || [];
      if (holders.length === 0) continue;
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) continue; // board default names a slug this workspace doesn't have
      // Priority: explicit holder wins — only fill a role that is currently vacant.
      const existing = await this.getAll(ticketId, role.id);
      if (existing.length > 0) continue;
      const valid = await this.filterExistingHolders(holders, workspaceId);
      if (valid.length === 0) continue;
      const rows = await this.setHolders(ticketId, role.id, valid);
      if (rows.length > 0) summary.push({ slug, applied: rows.length });
    }
    return summary;
  }

  /**
   * Backfill ONE vacant role slug from a board's `default_role_assignments`
   * (ticket 1e002acb). Thin single-slug wrapper around `applyBoardDefaults` —
   * the shared write path (never overwrite an existing holder, drop
   * default-holder ids that no longer resolve to a real agent/user) two very
   * differently-paced callers both need:
   *   - `BacklogPromotionService._maybeBackfillVacantRole` — intake only,
   *     gated behind a 30min-since-first-skip-audit-row threshold so normal
   *     staffing gets a chance first.
   *   - `TriggerLoopService` halt-policy entry into an active column (Review /
   *     Merging) — no sweep ever revisits an edge-triggered halt, so the
   *     attempt is immediate, right before the ticket would otherwise flag
   *     `_flagPolicyHalt` and go silent.
   * Returns false with no write when the board has no default for this slug —
   * callers read that as "cannot auto-recover, leave the real halt/skip in
   * place."
   */
  async backfillVacantRoleFromBoardDefaults(
    ticketId: string,
    workspaceId: string,
    boardDefaultRoleAssignments: string | null | undefined,
    slug: string,
  ): Promise<boolean> {
    const defaults = parseDefaultRoleAssignments(boardDefaultRoleAssignments);
    const holders = defaults[slug];
    if (!holders || holders.length === 0) return false;
    const applied = await this.applyBoardDefaults(ticketId, workspaceId, { [slug]: holders });
    return applied.some(a => a.slug === slug && a.applied > 0);
  }

  /**
   * Write-path (update_board) DB existence check for a board default config.
   * The JSON SHAPE is already validated by validateDefaultRoleAssignmentsInput;
   * this adds the layer that needs the DB — every slug must be a real role in
   * the board's workspace and every holder id a real agent/user. Returns the
   * first problem as an error string so the caller can 400, or `{ ok: true }`.
   * An empty config is trivially valid.
   */
  async validateBoardDefaults(
    workspaceId: string,
    defaults: DefaultRoleAssignments,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!workspaceId) return { ok: false, error: 'cannot validate default_role_assignments — board has no workspace' };
    for (const [slug, holders] of Object.entries(defaults)) {
      const role = await this.roleRepo.findOne({ where: { workspace_id: workspaceId, slug } });
      if (!role) return { ok: false, error: `default_role_assignments: unknown role slug "${slug}" for this workspace` };
      for (const h of holders) {
        const agent_id = (h.agent_id || '').trim();
        const user_id = (h.user_id || '').trim();
        // P4c-3b: runtime holders — shape already normalized; check the host.
        if ((h as any).runtime !== undefined && (h as any).runtime !== null) {
          const spec = (h as any).runtime as Record<string, any>;
          const hostId = String(spec.manager_agent_id || '');
          const host = hostId ? await this.dataSource.getRepository(RuntimeHost).findOne({ where: { id: hostId } }) : null;
          if (!host) {
            return { ok: false, error: `default_role_assignments["${slug}"]: runtime references an unknown Runtime Host` };
          }
        } else if (agent_id) {
          // P4c-4: Host/링크 해소 (Agent 행 없음, manager 타입 검사 없음).
          const a = await resolveCallerIdentityRow(this.dataSource, agent_id);
          if (!a) return { ok: false, error: `default_role_assignments["${slug}"]: agent ${agent_id} not found` };
          if (!agentIsVisibleInWorkspace(a.workspace_id, workspaceId)) {
            return { ok: false, error: `default_role_assignments["${slug}"]: agent ${agent_id} belongs to a different workspace` };
          }
        } else if (user_id) {
          const u = await this.userRepo.findOne({ where: { id: user_id }, select: ['id'] });
          if (!u) return { ok: false, error: `default_role_assignments["${slug}"]: user ${user_id} not found` };
        }
      }
    }
    return { ok: true };
  }

  /** All tickets where the given agent (or user) holds at least one role. */
  async listTicketIdsForHolder(holder: { agent_id?: string; user_id?: string }): Promise<string[]> {
    const where = holder.agent_id
      ? { agent_id: holder.agent_id }
      : holder.user_id
        ? { user_id: holder.user_id }
        : null;
    if (!where) return [];
    const rows = await this.assignRepo.find({ where, select: ['ticket_id'] });
    return [...new Set(rows.map(r => r.ticket_id))];
  }
}
