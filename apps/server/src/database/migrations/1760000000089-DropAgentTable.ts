import { MigrationInterface, QueryRunner } from 'typeorm';
import { bindParams } from '../action-cron-timezone';
import { RuntimeHost } from '../../entities/RuntimeHost';
import { TicketRoleAssignment } from '../../entities/TicketRoleAssignment';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { OrchestrationTeam } from '../../entities/OrchestrationTeam';
import { OrchestrationTeamMember } from '../../entities/OrchestrationTeamMember';
import { OrchestrationStep } from '../../entities/OrchestrationStep';
import { Action } from '../../entities/Action';
import { QaScenario } from '../../entities/QaScenario';
import { SecurityProfile } from '../../entities/SecurityProfile';
import { WorkspaceSchedule } from '../../entities/WorkspaceSchedule';
import { Feature } from '../../entities/Feature';

/**
 * P4c-4: Agent 테이블 제거.
 *
 * 순서:
 *  1. 저장된 RuntimeSpec 스냅샷의 manager_agent_id 를 legacy manager Agent
 *     uuid → 페어링 Host id 로 re-key (api_keys agent_id/host_id 쌍 기준).
 *     dispatch/SSE/카탈로그가 Host id 로 합류하므로, re-key 전에도 돌아가던
 *     것은 계속 돌고 이후에는 정본 id 만 남는다. 링크 없는 dead uuid 는
 *     손대지 않는다 (어차피 dispatch 불가).
 *  2. api_keys.agent_id 실FK 제거 (컬럼 자체는 audit 용도로 유지, 항상 NULL).
 *  3. agents 테이블 삭제.
 *
 * down(): no-op (이 저장소 관례 — 되돌리면서 데이터를 지우지 않는다).
 * 재실행 안전: 전부 존재 검사 + 값 비교 후 기록한다.
 */
export class DropAgentTable1760000000089 implements MigrationInterface {
  name = 'DropAgentTable1760000000089';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Pre-P0 pairing never stamped host_id. Preserve those manager identities
    // while their Agent rows and key links still exist; dropping agents first
    // can SET NULL the only link and permanently strand their credentials.
    if (await queryRunner.hasTable('agents')) {
      const managers: Array<{ id: string; name: string; is_active: number; last_seen_at: Date | null }> =
        await queryRunner.query("SELECT id, name, is_active, last_seen_at FROM agents WHERE type = 'manager'");
      const hostRepo = queryRunner.manager.getRepository(RuntimeHost);

      for (const manager of managers) {
        const managerKeys = await bindParams(queryRunner, 'SELECT * FROM api_keys WHERE agent_id = ?', [manager.id]);
        const hostIds = [...new Set(managerKeys.map((key) => key.host_id).filter((id): id is string => !!id))];
        if (hostIds.length > 1) {
          throw new Error(`Manager ${manager.id} has conflicting Runtime Host bindings; refusing to drop agents`);
        }
        const hostId = hostIds[0] || manager.id;
        if (!(await hostRepo.findOne({ where: { id: hostId } }))) {
          await hostRepo.save(hostRepo.create({
            id: hostId,
            name: manager.name,
            hostname: '',
            workspace_id: managerKeys[0]?.workspace_id || null,
            is_active: manager.is_active,
            last_seen_at: manager.last_seen_at,
          }));
        }
        for (const key of managerKeys) {
          if (!key.host_id) {
            key.host_id = hostId;
            await bindParams(queryRunner, 'UPDATE api_keys SET host_id = ? WHERE id = ?', [key.host_id, key.id]);
          }
        }
      }
    }
    // ── 1. spec re-key ──────────────────────────────────────────────

    let links: Array<{ agent_id: string | null; host_id: string | null }> = [];
    try {
      if (await queryRunner.hasColumn('api_keys', 'agent_id')) {
        links = await queryRunner.query('SELECT agent_id, host_id FROM api_keys');
      }
    } catch {
      links = [];
    }
    const hostByAgent = new Map<string, string>();
    for (const l of links) {
      if (l.agent_id && l.host_id && !hostByAgent.has(l.agent_id)) {
        hostByAgent.set(l.agent_id, l.host_id);
      }
    }
    if (hostByAgent.size > 0) {
      const rekey = (spec: unknown): boolean => {
        if (!spec || typeof spec !== 'object') return false;
        const s = spec as Record<string, unknown>;
        const cur = typeof s.manager_agent_id === 'string' ? s.manager_agent_id : '';
        const next = cur ? hostByAgent.get(cur) : undefined;
        if (next && next !== cur) {
          s.manager_agent_id = next;
          return true;
        }
        return false;
      };
      const single: Array<[string, string]> = [
        ['ticket_role_assignments', 'runtime_spec'],
        ['chat_room_participants', 'runtime_spec'],
        ['orchestration_teams', 'orchestrator_spec'],
        ['orchestration_team_members', 'spec'],
        ['orchestration_steps', 'assignee_spec'],
        ['qa_scenarios', 'target_runtime'],
        ['security_profiles', 'target_runtime'],
        ['workspace_schedules', 'target_runtime'],
        ['features', 'planner_runtime'],
      ];
      const repos: Record<string, { find(): Promise<Array<{ id: string } & Record<string, unknown>>>; save(r: unknown): Promise<unknown> }> = {
        ticket_role_assignments: queryRunner.manager.getRepository(TicketRoleAssignment) as never,
        chat_room_participants: queryRunner.manager.getRepository(ChatRoomParticipant) as never,
        orchestration_teams: queryRunner.manager.getRepository(OrchestrationTeam) as never,
        orchestration_team_members: queryRunner.manager.getRepository(OrchestrationTeamMember) as never,
        orchestration_steps: queryRunner.manager.getRepository(OrchestrationStep) as never,
        qa_scenarios: queryRunner.manager.getRepository(QaScenario) as never,
        security_profiles: queryRunner.manager.getRepository(SecurityProfile) as never,
        workspace_schedules: queryRunner.manager.getRepository(WorkspaceSchedule) as never,
        features: queryRunner.manager.getRepository(Feature) as never,
      };
      for (const [table, column] of single) {
        try {
          if (!(await queryRunner.hasTable(table))) continue;
          const repo = repos[table];
          const rows = await repo.find();
          let touched = 0;
          for (const row of rows) {
            if (rekey((row as Record<string, unknown>)[column])) {
              await repo.save(row);
              touched += 1;
            }
          }
          if (touched > 0) console.log(`[P4c-4 migration] re-keyed ${touched} ${table}.${column} spec(s) to Host ids`);
        } catch (e) {
          console.log(`[P4c-4 migration] spec re-key skipped for ${table}.${column}: ${String(e)}`);
        }
      }
      // actions.target_runtimes — JSON 배열.
      try {
        if (await queryRunner.hasTable('actions')) {
          const actionRepo = queryRunner.manager.getRepository(Action);
          const actions = await actionRepo.find();
          let touched = 0;
          for (const a of actions) {
            const arr = (a as unknown as Record<string, unknown>).target_runtimes;
            if (!Array.isArray(arr)) continue;
            let dirty = false;
            for (const s of arr) {
              if (rekey(s)) dirty = true;
            }
            if (dirty) {
              await actionRepo.save(a);
              touched += 1;
            }
          }
          if (touched > 0) console.log(`[P4c-4 migration] re-keyed ${touched} actions.target_runtimes spec(s) to Host ids`);
        }
      } catch (e) {
        console.log(`[P4c-4 migration] spec re-key skipped for actions.target_runtimes: ${String(e)}`);
      }
    }

    // ── 2. api_keys.agent_id 실FK 제거 ───────────────────────────────
    try {
      const table = await queryRunner.getTable('api_keys');
      const fk = table?.foreignKeys.find((f) => f.columnNames.includes('agent_id'));
      if (fk) {
        await queryRunner.dropForeignKey('api_keys', fk);
        console.log('[P4c-4 migration] dropped FK api_keys.agent_id');
      }
    } catch (e) {
      // sql.js 등 FK drop 미지원 드라이버 — 아래 DROP TABLE 이 판정한다.
      console.log(`[P4c-4 migration] FK drop skipped: ${String(e)}`);
    }

    // ── 3. agents 테이블 삭제 ─────────────────────────────────────────
    try {
      if (await queryRunner.hasTable('agents')) {
        await queryRunner.dropTable('agents');
        console.log('[P4c-4 migration] dropped table agents');
      }
    } catch (e) {
      console.log(`[P4c-4 migration] DROP TABLE agents failed: ${String(e)}`);
      throw e;
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // no-op (되돌리면서 데이터를 지우지 않는다 — 저장소 관례).
  }
}
