import { MigrationInterface, QueryRunner } from 'typeorm';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { normalizeUserChatMode, openJoinForUserChatMode } from '../../modules/orchestration/orchestration.constants';

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

    for (const mission of missions) {
      const roomId = (mission.room_id || '').trim();
      if (!roomId) continue; // 아직 시작되지 않은 미션 — 방이 없다.

      const room = await roomRepo.findOne({ where: { id: roomId } });
      if (!room) continue; // 방이 지워진 미션 — 맞출 대상이 없다.

      const desired = openJoinForUserChatMode(normalizeUserChatMode(mission.user_chat_mode));
      if (room.open_join !== desired) {
        await roomRepo.update(room.id, { open_join: desired });
        openJoinAligned++;
      }

      const ownerId = mission.created_by_type === 'user' ? (mission.created_by || '').trim() : '';
      if (!ownerId) continue; // MCP 로 만든 미션 — 사람 소유자가 없다(missionHumanOwner 와 같은 규칙).

      // 활성 여부가 아니라 **행 존재 여부**로 본다 — 헤더의 "탈퇴를 되돌리지 않는다" 참고.
      const anyRow = await participantRepo.findOne({
        where: { room_id: room.id, participant_id: ownerId, participant_type: 'user' },
      });
      if (anyRow) continue;

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

    if (openJoinAligned > 0 || participantsAdded > 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[Migration] BackfillMissionRoomUserChat: aligned open_join on ${openJoinAligned} mission room(s), ` +
          `registered ${participantsAdded} mission owner(s) as participants`,
      );
    }
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {
    // 되돌릴 수 없다 — 헤더 참고.
  }
}
