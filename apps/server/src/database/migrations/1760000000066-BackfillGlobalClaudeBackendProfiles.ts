import { MigrationInterface, QueryRunner } from 'typeorm';
import { createHash } from 'crypto';
import { parseCliRuntimeProfiles } from '../../common/cli-runtime-profiles';
import { runtimeToProfileEntity } from '../../common/claude-backend-registry';

/**
 * Data-only migration; synchronize creates the additive schema first.
 *
 * 이력 파일이지만 티켓 e616dbfc 에서 한 번 손댔다. 원본은
 * `WorkspaceClaudeBackendProfile` 엔티티와 `workspaces.default_claude_backend_profile_id`
 * / `claude_backend_profiles_migrated` 컬럼을 엔티티 리포지토리로 직접 읽고 썼는데,
 * 그 엔티티와 컬럼이 제거되면서 두 가지가 깨진다. (a) 컴파일이 실패하고,
 * (b) 마이그레이션은 synchronize **이후**에 돌기 때문에(db.ts D-02) 아직 이
 * 마이그레이션을 실행하지 않은 DB 에서는 synchronize 가 방금 떨어뜨린 컬럼을
 * 읽으려다 부팅 자체가 터진다. 그래서 엔티티에 의존하지 않는 테이블명 기반
 * 쿼리로 재작성하고, 워크스페이스 배정/기본값을 다루던 절반은 제거했다.
 *
 * 남긴 절반은 여전히 의미가 있다: 레거시 `workspaces.cli_runtime_profiles` JSON 을
 * 전역 `claude_backend_profiles` 행으로 승격하고(fingerprint dedupe), 그 과정에서
 * 레거시 id 가 다른 전역 id 로 접히면 board/agent/ticket 의 프로필 핀도 함께
 * 리맵해 기존 선택이 깨지지 않게 한다. 멱등성은 이제 사라진
 * `claude_backend_profiles_migrated` 플래그가 아니라 fingerprint dedupe 가
 * 보장한다 — 같은 payload 는 두 번 만들어지지 않는다.
 */
export class BackfillGlobalClaudeBackendProfiles1760000000066 implements MigrationInterface {
  name = 'BackfillGlobalClaudeBackendProfiles1760000000066';

  async up(queryRunner: QueryRunner): Promise<void> {
    // 레거시 원본이나 목적지가 없으면 조용히 no-op — 신규 DB 는 승격할 JSON 이 없다.
    if (!(await queryRunner.hasTable('workspaces'))) return;
    if (!(await queryRunner.hasTable('claude_backend_profiles'))) return;
    if (!(await queryRunner.hasColumn('workspaces', 'cli_runtime_profiles'))) return;

    const fingerprint = (input: {
      protocol: string; base_url: string; model: string;
      credential_ref: string | null; config: string;
    }) => createHash('sha256').update(JSON.stringify({
      protocol: input.protocol, base_url: input.base_url, model: input.model,
      credential_ref: input.credential_ref, config: JSON.parse(input.config || '{}'),
    })).digest('hex');

    const existingProfiles: Array<{
      id: string; protocol: string; base_url: string; model: string;
      credential_ref: string | null; config: string;
    }> = await queryRunner.query(
      'SELECT id, protocol, base_url, model, credential_ref, config FROM claude_backend_profiles',
    );
    const fingerprintToId = new Map<string, string>();
    const takenIds = new Set<string>();
    const takenNames = new Set<string>();
    for (const row of existingProfiles) {
      fingerprintToId.set(fingerprint(row), row.id);
      takenIds.add(row.id);
    }
    for (const row of await queryRunner.query('SELECT name FROM claude_backend_profiles') as Array<{ name: string }>) {
      takenNames.add(row.name);
    }

    const workspaces: Array<{ id: string; cli_runtime_profiles: string | null }> =
      await queryRunner.query('SELECT id, cli_runtime_profiles FROM workspaces');

    for (const workspace of workspaces) {
      const legacy = parseCliRuntimeProfiles(workspace.cli_runtime_profiles);
      if (!legacy.length) continue;
      const idMap = new Map<string, string>();
      for (const runtime of legacy) {
        const candidate = runtimeToProfileEntity(runtime, runtime.id);
        const print = fingerprint(candidate);
        let globalId = fingerprintToId.get(print);
        if (!globalId) {
          globalId = takenIds.has(runtime.id) ? `legacy-${print.slice(0, 24)}` : runtime.id;
          const name = takenNames.has(runtime.id) ? `${runtime.id}-${print.slice(0, 8)}` : runtime.id;
          const now = new Date();
          await queryRunner.manager.createQueryBuilder()
            .insert()
            .into('claude_backend_profiles')
            .values({
              id: globalId,
              name,
              protocol: candidate.protocol,
              base_url: candidate.base_url,
              model: candidate.model,
              credential_ref: candidate.credential_ref,
              config: candidate.config,
              created_at: now,
              updated_at: now,
            })
            .execute();
          fingerprintToId.set(print, globalId);
          takenIds.add(globalId);
          takenNames.add(name);
        }
        idMap.set(runtime.id, globalId);
      }
      // 안정적인 레거시 id 라도 워크스페이스마다 다른 payload 를 가리킬 수 있다.
      // 그 때문에 전역 id 에 결정적 suffix 가 붙으면, 스코프된 selector 도 함께
      // 옮겨야 원래 payload 를 계속 가리킨다.
      for (const [legacyId, globalId] of idMap) {
        if (legacyId === globalId) continue;
        for (const table of ['boards', 'agents', 'tickets']) {
          await queryRunner.manager.createQueryBuilder()
            .update(table)
            .set({ cli_runtime_profile: globalId })
            .where('workspace_id = :workspaceId AND cli_runtime_profile = :legacyId', {
              workspaceId: workspace.id, legacyId,
            })
            .execute();
        }
      }
    }
  }

  /**
   * 명시적 no-op — 되돌릴 수 없어서가 아니라, **안전하게** 되돌릴 수 없어서다.
   *
   * 이 마이그레이션의 up() 은 두 가지를 한다: (a) 레거시 JSON 을 전역
   * `claude_backend_profiles` 행으로 승격하고, (b) 레거시 id 가 다른 전역 id 로
   * 접힐 때 board/agent/ticket 의 프로필 핀을 리맵한다. 둘 다 되돌리려면 무엇이
   * 이 마이그레이션 산물인지 식별할 수 있어야 하는데, 그럴 방법이 없다.
   *
   * - 승격된 행은 대개 레거시 id 를 **그대로** 쓴다(충돌할 때만 `legacy-` 접두).
   *   즉 운영자가 관리 UI/MCP 로 직접 만든 전역 프로필과 행 모양이 구분되지 않는다.
   *   `DELETE FROM claude_backend_profiles` 로 지우면 이 마이그레이션과 무관하게
   *   존재하던 운영자 프로필까지 함께 사라진다.
   * - 리맵된 핀은 이전 값을 어디에도 기록하지 않으므로 복원할 수 없다. 행만 지우면
   *   board/agent/ticket 에 존재하지 않는 프로필을 가리키는 dangling selector 가
   *   남아, 디스패치가 fail-closed 로 막힌다.
   *
   * 생성 provenance 컬럼이 생기기 전까지는 "아무것도 하지 않는 것"이 가장 안전한
   * 롤백이다. 승격된 행이 남아 있어도 무해하다 — 재실행 시 fingerprint dedupe 가
   * 같은 payload 를 다시 만들지 않는다. 스키마 자체는 synchronize 소유이므로
   * (db.ts D-01/D-02) 여기서 되돌릴 DDL 도 없다.
   */
  async down(): Promise<void> {
    // 의도적으로 비어 있다. 위 주석의 근거 없이 삭제 구문을 되살리지 말 것.
  }
}
