import { IsNull, MigrationInterface, QueryRunner } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { normalizeUserChatMode, openJoinForUserChatMode } from '../../modules/orchestration/orchestration.constants';

/**
 * 종료 상태 집합. `isTerminalMissionStatus` 를 쓰지 않고 여기 리터럴로 두는 이유는
 * 마이그레이션이 **그때 그 시점의 의미**로 고정돼야 하기 때문이다 — 나중에 상태 어휘가
 * 늘어나도 이미 실행된 조사의 해석이 소급해 바뀌면 안 된다.
 */
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * RFC-4122 모양. `chat_room_participants.participant_id` 에는 의사 user `system` 처럼
 * UUID 가 아닌 값이 섞여 있고 그것은 엔진 자신이다 — "사람 참여자" 를 셀 때 제외한다.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Backfill: 기존 미션 방을 새 `user_chat_mode` 옵션의 기본값에 맞춘다 (티켓 9cfd8161).
 *
 * 왜 필요한가 — 미션 방의 자유 참여(`ChatRoom.open_join`)는 컬럼 기본값이 `false` 이고,
 * `true` 로 켜지는 곳은 **미션을 새로 시작할 때 생성되는 방 하나뿐**이었다(티켓 995a9519).
 * 그 기능이 들어가기 전에 시작된 미션 방은 예외 없이 `open_join=false` 로 남았고, 그것을
 * 되돌려 줄 경로가 코드 어디에도 없었다 — 마이그레이션 87개를 통틀어 `open_join` 을 다루는
 * 것이 0건이었다. 사람 참여자 등록도 미션 시작 시점 1회뿐이라, 그 이전 미션 방에는 사람
 * 참여자 행 자체가 없다. 두 구멍 다 "이미 만들어진 행"의 문제라 런타임 수정으로는 절대
 * 메워지지 않는다.
 *
 * 하는 일 두 가지:
 *
 *   1. 미션 방의 `open_join` 을 그 미션의 `user_chat_mode` 에서 계산한 값으로 맞춘다.
 *      기존 행은 모드가 `''`/NULL 이라 `normalizeUserChatMode` 가 기본값 `open` 으로
 *      접고, 따라서 `open_join=true` 로 정렬된다 — 즉 이 기능 도입 이후 새로 시작된
 *      미션과 같은 상태가 된다.
 *   2. 미션 생성자(`created_by_type='user'`)를 그 방의 참여자로 등록한다.
 *
 * 범위와 안전장치:
 *
 * - **step 방은 건드리지 않는다.** 순회 대상이 `mission.room_id` 가 가리키는 방뿐이라
 *   구조적으로 step 방에 닿을 수 없다 — 조건으로 거르는 것이 아니라 애초에 후보에
 *   들어오지 않는다. step 방의 자유 참여를 켜지 않는다는 기존 정책(티켓 995a9519)이
 *   그대로 유지된다.
 * - **종료된 미션도 정렬 대상이다.** `open_join` 은 "참여자 명단에 없어도 되는가"를
 *   뜻하는 채팅 레이어 플래그이고, 종료 미션의 대화는 **읽기가 항상 가능해야** 한다는 것이
 *   이 티켓의 규칙이다. 정렬해 두면 기록 열람이 관전 모드로 떨어지지 않고 정상 읽기로
 *   된다. 종료 미션에서 **발화**가 막히는 것은 이 플래그가 아니라
 *   `requireMissionRoomSpeaker` 의 종료 검사가 보장하므로, 여기서 켠다고 끝난 미션에
 *   새 지시가 들어가지는 않는다.
 * - **탈퇴를 되돌리지 않는다.** 참여자 등록은 (room, user) 행이 **하나도 없을 때만**
 *   한다. `left_at` 이 찍힌 행이 있으면 그 사람은 의도적으로 방을 나간 것이므로 건너뛴다 —
 *   `left_at IS NULL` 만 보고 판단하면 나간 사람을 마이그레이션이 매번 다시 끌어들인다.
 * - **참여자 상한(50)을 넘기지 않는다.** 서비스 계층의 불변식을 마이그레이션이 우회해
 *   깨뜨리지 않도록, 이미 활성 참여자가 상한에 도달한 방은 등록을 건너뛴다.
 *
 * 재실행 안전(idempotent):
 * - 이미 값이 같은 방은 UPDATE 하지 않는다.
 * - 참여자는 행 존재 여부로 판정하므로 두 번째 실행에서 **중복 행이 생기지 않는다**.
 *   회귀 테스트가 up() 을 연속 두 번 돌려 이 성질을 단언한다.
 *
 * 전수 조사(티켓 9cfd8161 요구사항 B)도 여기서 낸다. 조사 대상은 서버가 들고 있는 미션
 * 전체인데, 그 목록을 워크스페이스 단위로 열어 주는 표면이 에이전트 쪽에는 없다
 * (`list_orchestration_missions` 는 자신이 orchestrator/팀원인 미션만, `list_chat_rooms`
 * 는 자신이 참여 중인 방만 돌려준다). 반대로 이 마이그레이션은 이미 미션 전 행을 한 번씩
 * 지나가므로, 조사를 여기서 하면 별도 조회 경로를 새로 뚫지 않고도 **백필이 실제로 도는
 * 그 순간의 값**으로 집계된다. 결과는 카운트만 담긴 한 줄로 서버 로그에 남는다
 * (미션 제목·본문 등 내용은 싣지 않는다).
 *
 * 조사 항목은 요구사항이 지정한 세 축을 **변경 전 상태로** 찍는다 (리뷰 지적 2):
 *   - 미션 방의 `open_join` 분포 (`before_open_join_on` / `_off`)
 *   - **사람 참여자 유무** (`with_human_participant` / `without_`) — 생성자만이 아니라 그 방의
 *     활성 사람 참여자 전체를 본다. 의사 user `system` 은 엔진 자신이라 사람으로 세지 않는다
 *     (UUID 모양이 아닌 participant_id 를 제외하는 것으로 걸러진다).
 *   - 미션 상태 (`terminal`, `started`)
 * 여기에 생성자 행의 상태를 셋으로 쪼개 붙인다 — `owner_active`(이미 활성 참여자),
 * `owner_left`(스스로 나감 → 되돌리지 않음), `owner_absent`(행 없음 → 등록 대상).
 *
 * **백필 대상 수는 `open_join_misaligned` 와 `owner_absent` 다.** 실제로 수행한 양
 * (`open_join_aligned` / `owners_registered`)과 따로 찍어 둬야 "대상이 있었는데 안 했다" 를
 * 구분할 수 있다.
 *
 * `before_open_join` 의 off 수는 **대상 수가 아니다**(리뷰 지적). 그것은 현재 상태의 분포일
 * 뿐이고, 정렬 대상은 "현재값이 그 미션의 모드가 요구하는 값과 다른 방"이다 —
 * `participants_only`/`off` 미션의 방은 `open_join=false` 가 이미 정답이라 off 에 세어져도
 * 고칠 것이 없다. 모드 분포와 on/off 분포는 각각의 주변분포(marginal)라 교차표가 아니므로,
 * 둘을 조합해도 불일치 수를 복원할 수 없다. 그래서 불일치를 **쓰기 전에 직접** 센다. 반대로 `mode_column_unset` 은 **대상 수가 아니다** — `synchronize` 가
 * 컬럼을 default `'open'` 으로 추가하면서 기존 행까지 채우므로 보통 0 이다. 레거시 미션 수를
 * 이 값으로 식별하려던 초안이 틀렸고(리뷰 지적 2), 진단용으로만 남긴다.
 *
 * DATA only, no DDL — `user_chat_mode` 컬럼 자체는 엔티티 default + `synchronize` 로
 * 생기고, 그 단계는 DatabaseModule.onModuleInit 에서 이 마이그레이션보다 먼저 끝난다
 * (db.ts 의 D-01/D-02/P-03).
 *
 * down() 은 no-op 이다. 되돌리려면 "이 마이그레이션이 켠 방"과 "원래 켜져 있던 방"을
 * 구분해야 하는데 그 정보를 남기지 않았고, 구분 없이 전부 끄면 이 기능 도입 이후 정상적으로
 * 시작된 미션 방까지 함께 닫혀 대화가 죽는다. 참여자 행도 마찬가지로 이 마이그레이션이
 * 넣은 것인지 사람이 직접 참여한 것인지 구분할 수 없어, 지우면 실제 참여를 파괴한다.
 */
export class BackfillMissionRoomUserChat1760000000084 implements MigrationInterface {
  name = 'BackfillMissionRoomUserChat1760000000084';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const manager = queryRunner.manager;
    const missionRepo = manager.getRepository(OrchestrationMission);
    const roomRepo = manager.getRepository(ChatRoom);
    const participantRepo = manager.getRepository(ChatRoomParticipant);

    const missions = await missionRepo.find();
    let openJoinAligned = 0;
    let participantsAdded = 0;

    // ── 전수 조사 집계 (요구사항 B) ────────────────────────────────────────
    const modeCounts: Record<string, number> = { open: 0, participants_only: 0, off: 0 };
    /**
     * 컬럼이 ''/NULL 로 남은 행. **백필 대상 수가 아니다** — synchronize 가 default 로
     * 기존 행까지 채우므로 보통 0 이다(헤더 참고). 0 이 아니면 스키마 동기화가 기대와
     * 다르게 돌았다는 신호라 진단용으로만 남긴다.
     */
    let modeColumnUnset = 0;
    let started = 0;       // room_id 가 있는 미션(= 실제로 시작된 것)
    let terminal = 0;      // completed / failed / cancelled
    let missingRoom = 0;   // room_id 는 있는데 방 행이 사라진 미션
    let noHumanOwner = 0;  // MCP 로 만들어 사람 소유자가 없는 미션

    // 변경 **전** 상태 스냅샷 — 백필이 무엇을 만났는지가 조사의 내용이다.
    let beforeOpenJoinOn = 0;
    let beforeOpenJoinOff = 0;
    let withHumanParticipant = 0;
    let withoutHumanParticipant = 0;
    let ownerActive = 0;   // 생성자가 이미 활성 참여자
    let ownerLeft = 0;     // 생성자 행은 있으나 스스로 나감 — 되돌리지 않는다
    let ownerAbsent = 0;   // 생성자 행이 아예 없음 = 등록 대상

    // 정렬 **대상** 수 — 현재값이 모드가 요구하는 값과 다른 방. 쓰기 전에 센다.
    // 방향까지 나눠 두면 "닫혀 있던 것을 열었다"와 "열려 있던 것을 닫았다"가 구분된다.
    let misalignedToOn = 0;   // 현재 false → true 로 켜야 함
    let misalignedToOff = 0;  // 현재 true → false 로 꺼야 함

    for (const mission of missions) {
      const mode = normalizeUserChatMode(mission.user_chat_mode);
      modeCounts[mode] = (modeCounts[mode] ?? 0) + 1;
      if (!String(mission.user_chat_mode ?? '').trim()) modeColumnUnset++;
      if (TERMINAL_STATUSES.has(mission.status)) terminal++;
      const roomId = (mission.room_id || '').trim();
      if (!roomId) continue; // 아직 시작되지 않은 미션 — 방이 없다.
      started++;

      const room = await roomRepo.findOne({ where: { id: roomId } });
      if (!room) {
        missingRoom++;
        continue; // 방이 지워진 미션 — 맞출 대상이 없다.
      }

      // ── 변경 전 스냅샷 ────────────────────────────────────────────────
      // 반드시 쓰기 **전에** 찍는다. 정렬한 뒤에 세면 전부 "정렬돼 있었다"로 보인다.
      if (room.open_join) beforeOpenJoinOn++;
      else beforeOpenJoinOff++;

      // "사람 참여자 유무" — 생성자만이 아니라 활성 사람 참여자 전체를 본다. 의사 user
      // `system` 처럼 UUID 가 아닌 participant_id 는 엔진 자신이라 사람으로 세지 않는다.
      const activeHumanRows = await participantRepo.find({
        where: { room_id: room.id, participant_type: 'user', left_at: IsNull() },
      });
      const hasHuman = activeHumanRows.some((r) => UUID_RE.test(String(r.participant_id ?? '')));
      if (hasHuman) withHumanParticipant++;
      else withoutHumanParticipant++;

      const desired = openJoinForUserChatMode(mode);
      if (room.open_join !== desired) {
        if (desired) misalignedToOn++;
        else misalignedToOff++;
        await roomRepo.update(room.id, { open_join: desired });
        openJoinAligned++;
      }

      const ownerId = mission.created_by_type === 'user' ? (mission.created_by || '').trim() : '';
      if (!ownerId) {
        noHumanOwner++;
        continue; // MCP 로 만든 미션 — 사람 소유자가 없다(missionHumanOwner 와 같은 규칙).
      }

      // 활성 여부가 아니라 **행 존재 여부**로 등록을 판정한다(헤더의 "탈퇴를 되돌리지
      // 않는다"). 다만 조사는 활성/탈퇴를 **구분해서** 센다 — 둘을 뭉뚱그리면 "이미
      // 참여 중"과 "스스로 나감"이 같은 수에 섞여 운영자가 상태를 오해한다.
      const anyRow = await participantRepo.findOne({
        where: { room_id: room.id, participant_id: ownerId, participant_type: 'user' },
      });
      if (anyRow) {
        if (anyRow.left_at) ownerLeft++;
        else ownerActive++;
        continue;
      }
      ownerAbsent++;

      const activeCount = await participantRepo
        .createQueryBuilder('p')
        .where('p.room_id = :roomId', { roomId: room.id })
        .andWhere('p.left_at IS NULL')
        .getCount();
      if (activeCount >= 50) continue;

      await participantRepo.save(
        participantRepo.create({
          room_id: room.id,
          participant_type: 'user',
          participant_id: ownerId,
        }),
      );
      participantsAdded++;
    }

    // 조사 결과는 **항상** 낸다 — 0건이라는 사실도 조사 결과다. 마이그레이션은 한 번만
    // 돌므로 이 줄도 한 번만 남는다.
    // eslint-disable-next-line no-console
    console.log(
      '[Migration] BackfillMissionRoomUserChat survey: ' +
        `missions=${missions.length} started=${started} terminal=${terminal} room_missing=${missingRoom} ` +
        `mode(open=${modeCounts.open} participants_only=${modeCounts.participants_only} off=${modeCounts.off}) ` +
        `before_open_join(on=${beforeOpenJoinOn} off=${beforeOpenJoinOff}) ` +
        `open_join_misaligned(total=${misalignedToOn + misalignedToOff} ` +
        `to_on=${misalignedToOn} to_off=${misalignedToOff}) ` +
        `human_participant(with=${withHumanParticipant} without=${withoutHumanParticipant}) ` +
        `owner(active=${ownerActive} left=${ownerLeft} absent=${ownerAbsent} none=${noHumanOwner}) ` +
        `mode_column_unset=${modeColumnUnset} | ` +
        `backfilled: open_join_aligned=${openJoinAligned} owners_registered=${participantsAdded}`,
    );
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 되돌릴 수 없다 — 헤더 참고.
  }
}
