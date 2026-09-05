import { Injectable } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository, In, IsNull } from 'typeorm';
import { ChatRoom } from '../../entities/ChatRoom';
import { ChatRoomParticipant } from '../../entities/ChatRoomParticipant';
import { User } from '../../entities/User';
import { Agent } from '../../entities/Agent';
import { OrchestrationMission } from '../../entities/OrchestrationMission';
import { activityEvents } from '../../services/activity.service';
import { resolveAgentDisplayName } from '../../utils/agent-name';
import { hasPermission, PERMISSIONS } from '../../common/types/permissions';
import {
  UserChatMode,
  isTerminalMissionStatus,
  normalizeUserChatMode,
} from '../orchestration/orchestration.constants';

const PARTICIPANT_CAP = 50;

/**
 * mission 방 하나에 대해 해석된 chat 정책(티켓 9cfd8161).
 *
 * `mode` 는 미션의 `user_chat_mode` 를 정규화한 값이고, `terminal` 은 미션이 이미
 * 끝났는가다. 둘을 한 번에 돌려주는 이유는 호출부(발화 게이트, 자유 참여 완화)가
 * 항상 둘 다 필요로 하는데 미션 조회는 한 번이면 충분하기 때문이다.
 */
export interface MissionChatPolicy {
  mission_id: string;
  mode: UserChatMode;
  /** 미션이 completed/failed/cancelled 인가 — 그렇다면 대화는 읽기 전용이다. */
  terminal: boolean;
}

/**
 * RFC-4122 shape. A participant/sender id that isn't a uuid (the synthetic
 * 'system' author QA/Action dispatch uses) must never reach a uuid-typed
 * column lookup — see resolveParticipantName for the full rationale.
 */
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function makeError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

/**
 * Owns participant (membership) state for chat rooms.
 *
 * Responsibilities:
 *  - add / remove (leave) participants
 *  - list active member ids (users / agents) for SSE filtering
 *  - shared membership helpers (`requireActiveParticipant`, name resolution, DB-dialect text coercion)
 *    used by the sibling CRUD and Messaging services so they don't duplicate participant lookups.
 *
 * Kept separate from message I/O (RoomMessagingService) and room CRUD (RoomCrudService / facade)
 * so the participant invariants (50-cap transaction, soft-delete via left_at) live in one place.
 */
@Injectable()
export class RoomMembershipService {
  constructor(
    @InjectRepository(ChatRoom)
    private readonly roomRepo: Repository<ChatRoom>,

    @InjectRepository(ChatRoomParticipant)
    private readonly participantRepo: Repository<ChatRoomParticipant>,

    @InjectRepository(User)
    private readonly userRepo: Repository<User>,

    @InjectRepository(Agent)
    private readonly agentRepo: Repository<Agent>,

    @InjectDataSource() private readonly dataSource: DataSource,

    // 새 의존성은 **맨 뒤에** 붙인다 — 이 서비스를 위치 인자로 만드는 테스트가 있어
    // 중간 삽입은 뒤 인자를 한 칸씩 밀어 조용히 undefined 를 만든다.
    // 서비스가 아니라 **엔티티 저장소**만 가져오므로 orchestration 모듈과의 순환은 없다.
    @InjectRepository(OrchestrationMission)
    private readonly missionRepo: Repository<OrchestrationMission>,
  ) {}

  /** Wraps a column reference with ::text on postgres to avoid varchar/uuid mismatch */
  toText(col: string): string {
    return this.dataSource.options.type === 'postgres' ? `${col}::text` : col;
  }

  /**
   * Agent Manager(type='manager')는 chat 참가자가 될 수 없다 (ticket 941c72d3) —
   * 절대 작업하지 않으므로 대화에도 끼지 않는다. 참가자 목록에서 manager agent 를
   * 조용히 제거한다(user 참가자·비-manager agent 는 그대로 통과). manager 가 없으면
   * 입력 배열을 그대로 반환(추가 질의 없음). RoomCrudService 도 이 헬퍼를 공유한다.
   */
  async filterOutManagerParticipants(
    participants: { participant_type: string; participant_id: string }[],
  ): Promise<{ participant_type: string; participant_id: string }[]> {
    const agentIds = [...new Set(
      participants.filter(p => p.participant_type === 'agent').map(p => p.participant_id).filter(Boolean),
    )];
    if (agentIds.length === 0) return participants;
    const managers = await this.agentRepo.find({ where: { id: In(agentIds), type: 'manager' }, select: ['id'] });
    if (managers.length === 0) return participants;
    const managerSet = new Set(managers.map(a => a.id));
    return participants.filter(p => !(p.participant_type === 'agent' && managerSet.has(p.participant_id)));
  }

  /**
   * Add participants to a group room (not DM). Respects 50-participant cap.
   * Re-joining a previously left user creates a new participant row.
   */
  async addParticipants(
    roomId: string,
    caller: { type: 'user' | 'agent'; id: string } | string,
    newParticipants: { participant_type: string; participant_id: string }[],
  ): Promise<void> {
    // Back-compat: existing controller call site passes a bare userId string;
    // the new MCP path passes a typed caller. Normalize here so both work.
    const c = typeof caller === 'string' ? { type: 'user' as const, id: caller } : caller;
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room) {
      throw makeError(404, 'Room not found');
    }
    if (room.type === 'dm') {
      throw makeError(400, 'Cannot add participants to a direct message');
    }

    await this.requireActiveParticipant(roomId, c.id, c.type);

    // Manager(type='manager')는 chat 참가자가 될 수 없다 (ticket 941c72d3) — 조용히 제거.
    newParticipants = await this.filterOutManagerParticipants(newParticipants);

    // Wrap cap-check and insert in a transaction to prevent concurrent requests from
    // exceeding the participant cap (read-check-then-write race condition).
    await this.participantRepo.manager.transaction(async (em) => {
      const currentCount = await em
        .createQueryBuilder(ChatRoomParticipant, 'p')
        .where('p.room_id = :roomId', { roomId })
        .andWhere('p.left_at IS NULL')
        .getCount();

      if (currentCount + newParticipants.length > PARTICIPANT_CAP) {
        throw makeError(400, 'This room is full (50 participant limit).');
      }

      // B2 fix: initialize last_read_at to NOW() so existing room history isn't
      // flagged as unread to the newly added participant. They see the backlog
      // when they scroll, but the room doesn't shout at them with a large badge.
      const joinedAt = new Date();
      const rows = newParticipants.map(p =>
        em.create(ChatRoomParticipant, {
          room_id: roomId,
          participant_type: p.participant_type,
          participant_id: p.participant_id,
          last_read_at: joinedAt,
          left_at: null,
        }),
      );
      await em.save(rows);
    });

    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'participant_added',
      participant_ids: newParticipants.map(p => p.participant_id),
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * 도메인이 소유한 room 에 참여자를 **멱등하게** 넣는다. 이미 active 면 아무것도 하지
   * 않고 `false` 를, 새로 넣었으면 `true` 를 돌려준다.
   *
   * `addParticipants` 와 갈라지는 지점은 딱 하나, **호출자의 자격**이다. 그쪽은 "이미
   * 방에 있는 사람이 남을 초대한다"라서 호출자의 active 참여를 요구하는데, 여기는
   * 정의상 호출자가 아직 참여자가 아닌 self-join 경로다(티켓 f6a0de0e — orchestration
   * mission 방에 사람이 들어가는 길). 그래서 호출자 검사를 하지 않는 대신 **권한 판정을
   * 도메인이 이미 끝냈다는 것이 전제**다. 새 호출부를 만들 때는 그 앞단에 실제 권한
   * 게이트가 있는지 먼저 확인할 것 — 게이트 없이 부르면 방 격리가 그대로 뚫린다.
   *
   * 50인 cap 은 그대로 적용한다: self-join 이라고 방 크기 계약을 면제받을 이유가 없다.
   * 재입장이 새 행을 만드는 것도 `addParticipants` 와 같은 정책이다 — 나갔던 이력을
   * 지우지 않는다.
   *
   * 동시성: check-then-insert 를 한 트랜잭션에 넣는 것만으로는 부족하다. Postgres 의
   * READ COMMITTED 에서는 두 요청이 동시에 "없음"을 읽고 **둘 다** 넣을 수 있고, 그
   * 중복 active 행은 관찰 가능한 고장을 만든다(리뷰 라운드1 지적 2): `leaveRoom` 이
   * 한 행만 정리하면 다른 active 행이 남아 **사용자가 방을 떠날 수 없고**, 서로 다른
   * 참여자의 동시 join 은 50인 cap 도 함께 넘길 수 있다.
   *
   * 그래서 방 단위 직렬화를 건다:
   *   - Postgres — `pg_advisory_xact_lock` 으로 **roomId** 를 잠근다. 키를 (room,
   *     participant) 로 좁히면 같은 사람의 중복은 막아도 cap 검사는 여전히 경합하므로,
   *     둘 다 지키려면 방 전체가 락 단위여야 한다. 트랜잭션 스코프라 커밋/롤백에서
   *     자동 해제되고, self-join 은 사람이 버튼을 누르는 빈도라 직렬화 비용이 없다.
   *   - sql.js — `serializeSqljsTransactions` 가 이미 트랜잭션을 FIFO 로 직렬화한다
   *     (db.ts). 락 문장을 보내면 그쪽 방언에 없어 실패하므로 걸지 않는다.
   *
   * 부분 UNIQUE 인덱스를 고르지 않은 이유: `addParticipants` 는 예전부터 중복 검사 없이
   * 행을 넣어 왔으므로 **기존 DB 에 이미 중복 active 행이 있을 수 있고**, `synchronize`
   * 가 인덱스를 만들려다 실패하면 부팅 자체가 깨진다. 락은 그 위험 없이 앞으로의
   * 단일성을 보장하고, 이미 있는 중복은 아래 `leaveRoom` 이 전부 정리한다.
   */
  async ensureActiveParticipant(
    roomId: string,
    participantType: 'user' | 'agent',
    participantId: string,
  ): Promise<boolean> {
    const added = await this.participantRepo.manager.transaction((em) =>
      this.ensureActiveParticipantInTransaction(em, roomId, participantType, participantId),
    );

    if (!added) return false;

    await this.emitParticipantAdded(roomId, participantId);
    return true;
  }

  /**
   * `ensureActiveParticipant` 의 알맹이 — **호출자가 연 트랜잭션 안에서** 실행한다
   * (티켓 995a9519 리뷰 라운드1 P1-1).
   *
   * 분리한 이유는 하나다: 참여자 등록이 **그것을 정당화한 쓰기와 함께 커밋되거나 함께
   * 롤백되어야** 하기 때문이다. sendMessage 의 자유 참여 auto-join 이 자체 트랜잭션으로
   * 먼저 커밋되면, 뒤이은 메시지 저장이 첨부 CAS 충돌(409)이나 DB 오류로 실패해도
   * 참여자 행은 남는다 — "첫 발언 시 참여자로 등록"이 아니라 "발언을 시도만 해도 등록"이
   * 되고, 되돌릴 경로도 없다.
   *
   * SSE 를 여기서 내지 않는 것도 같은 이유다. 트랜잭션 안에서 emit 하면 롤백된 참여를
   * 알리는 이벤트가 나가 버린다. 호출자가 **커밋에 성공한 뒤** `emitParticipantAdded` 를
   * 부른다.
   *
   * 동시성 규약(방 단위 직렬화)은 `ensureActiveParticipant` 주석 그대로다 — 락은 여전히
   * 트랜잭션 스코프이고, 이제 그 트랜잭션이 호출자의 것일 뿐이다.
   */
  async ensureActiveParticipantInTransaction(
    em: EntityManager,
    roomId: string,
    participantType: 'user' | 'agent',
    participantId: string,
  ): Promise<boolean> {
    if (this.dataSource.options.type === 'postgres') {
      await em.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [`chat_room_participants:${roomId}`]);
    }

    const existing = await em
      .createQueryBuilder(ChatRoomParticipant, 'p')
      .where('p.room_id = :roomId', { roomId })
      .andWhere('p.participant_id = :participantId', { participantId })
      .andWhere('p.participant_type = :participantType', { participantType })
      .andWhere('p.left_at IS NULL')
      .getOne();
    if (existing) return false;

    const currentCount = await em
      .createQueryBuilder(ChatRoomParticipant, 'p')
      .where('p.room_id = :roomId', { roomId })
      .andWhere('p.left_at IS NULL')
      .getCount();
    if (currentCount + 1 > PARTICIPANT_CAP) {
      throw makeError(400, 'This room is full (50 participant limit).');
    }

    // last_read_at 을 지금으로 두는 이유는 addParticipants 와 같다 — 참여 전 이력이
    // 미읽음 배지로 쏟아지지 않게.
    await em.save(
      em.create(ChatRoomParticipant, {
        room_id: roomId,
        participant_type: participantType,
        participant_id: participantId,
        last_read_at: new Date(),
        left_at: null,
      }),
    );
    return true;
  }

  /**
   * 참여자 추가를 방에 알린다. `ensureActiveParticipantInTransaction` 을 직접 쓴 호출자가
   * **커밋 성공 뒤에** 부르는 짝이다 — 트랜잭션 안에서 부르면 롤백된 참여가 이벤트로
   * 새어 나간다.
   */
  async emitParticipantAdded(roomId: string, participantId: string): Promise<void> {
    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'participant_added',
      participant_ids: [participantId],
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Leave a room by soft-deleting the participant row (sets left_at).
   *
   * **모든** active 행을 한 문장으로 정리한다. 예전에는 `findOne` 으로 한 행만 골라
   * `left_at` 을 찍었는데, 이 테이블은 같은 (room, user) 에 대해 행이 여러 개일 수 있어
   * 두 가지로 고장났다(리뷰 라운드1 지적 2):
   *
   *   - 재입장은 정책상 **새 행**을 만든다(`addParticipants` 주석). 그러면 나갔던 옛
   *     행과 지금의 active 행이 공존하는데, `findOne` 이 옛 행을 먼저 고르면
   *     `left_at !== null` 이라 **active 참여자인데도 400** 이 났다.
   *   - 동시 join 으로 active 행이 둘 생기면 하나만 정리돼 **나가지지 않았다**.
   *
   * 조건부 UPDATE 는 두 경우를 한꺼번에 없앤다 — `left_at IS NULL` 인 행만, 전부.
   * `affected` 가 0 이면 애초에 active 행이 없었다는 뜻이므로 그대로 400 이다.
   *
   * 조건에 리터럴 `null` 이 아니라 `IsNull()` 을 쓰는 것은 필수다: 이 스택에서 where 의
   * `left_at: null` 은 `IS NULL` 로 변환되지 않고 **조건 자체가 조용히 빠진다**(그러면
   * 이 UPDATE 는 이미 나간 행까지 다시 건드린다).
   */
  async leaveRoom(roomId: string, userId: string): Promise<void> {
    const result = await this.participantRepo.update(
      {
        room_id: roomId,
        participant_id: userId,
        participant_type: 'user',
        left_at: IsNull(),
      },
      { left_at: new Date() },
    );

    if (!result.affected) {
      throw makeError(400, 'Not an active participant in this room');
    }

    // Get updated member IDs after the leave
    const memberIds = await this.getRoomMemberIds(roomId);
    const agentMemberIds = await this.getRoomAgentMemberIds(roomId);
    activityEvents.emit('chat_room_update', {
      room_id: roomId,
      update_type: 'participant_left',
      participant_id: userId,
      member_ids: memberIds,
      agent_member_ids: agentMemberIds,
    });
  }

  /**
   * Helper: Returns a Set of active user participant IDs for a room.
   * Used to populate member_ids in SSE events for synchronous filtering.
   */
  async getRoomMemberIds(roomId: string): Promise<Set<string>> {
    const participants = await this.participantRepo
      .createQueryBuilder('p')
      .select('p.participant_id')
      .where('p.room_id = :roomId', { roomId })
      .andWhere("p.participant_type = 'user'")
      .andWhere('p.left_at IS NULL')
      .getMany();

    return new Set(participants.map(p => p.participant_id));
  }

  /**
   * Helper: Returns a Set of active agent participant IDs for a room.
   * Used to allow agent proxies to receive chat_room_message via SSE.
   */
  async getRoomAgentMemberIds(roomId: string): Promise<Set<string>> {
    const participants = await this.participantRepo
      .createQueryBuilder('p')
      .select('p.participant_id')
      .where('p.room_id = :roomId', { roomId })
      .andWhere("p.participant_type = 'agent'")
      .andWhere('p.left_at IS NULL')
      .getMany();

    return new Set(participants.map(p => p.participant_id));
  }

  /**
   * Shared helper: throw 403 unless (participantId, participantType) is an active
   * participant of roomId. Used by CRUD/Messaging siblings as well.
   */
  async requireActiveParticipant(
    roomId: string,
    participantId: string,
    participantType: string = 'user',
  ): Promise<void> {
    const participant = await this.participantRepo
      .createQueryBuilder('p')
      .where('p.room_id = :roomId', { roomId })
      .andWhere('p.participant_id = :participantId', { participantId })
      .andWhere('p.participant_type = :participantType', { participantType })
      .andWhere('p.left_at IS NULL')
      .getOne();

    if (!participant) {
      throw makeError(403, 'Not an active participant in this room');
    }
  }

  /**
   * 이 방을 지배하는 미션 chat 정책을 읽는다 — mission 방이 아니면 `null` (티켓 9cfd8161).
   *
   * **단일 기준은 미션 컬럼이지 방의 `open_join` 이 아니다.** 방 플래그는 옵션에서 파생돼
   * 동기화되는 캐시라, 판정까지 거기에 걸면 둘이 어긋난 순간(수동 DDL, 백필 이전 행,
   * 부분 실패) 사용자가 보는 옵션과 실제 동작이 갈라진다. 그래서 게이트도, 자유 참여
   * 완화도 이 함수 하나를 통해 미션 값을 직접 읽는다.
   *
   * step 방은 대상이 아니다 — `orchestration_step_id` 가 있는 방은 사람이 읽는 대화가
   * 아니라 멤버 에이전트에게 내리는 작업 지시 채널이고, 미션 하나가 수십 개를 만든다
   * (티켓 995a9519 의 판단 그대로).
   *
   * 미션 행이 사라졌는데 방이 아직 그것을 가리키는 경우 `null` 을 돌려준다 — 정책을 알 수
   * 없을 때 완화하지 않는 것이 안전한 실패이고, 뒤따르는 MANAGE_ACTIONS 검사는 그대로 돈다.
   */
  async resolveMissionChatPolicy(
    room: { orchestration_mission_id?: string | null; orchestration_step_id?: string | null } | null | undefined,
  ): Promise<MissionChatPolicy | null> {
    const missionId = room?.orchestration_mission_id;
    if (!missionId) return null;
    if (room?.orchestration_step_id) return null;
    const mission = await this.missionRepo.findOne({ where: { id: missionId } });
    if (!mission) return null;
    return {
      mission_id: mission.id,
      mode: normalizeUserChatMode(mission.user_chat_mode),
      terminal: isTerminalMissionStatus(mission.status),
    };
  }

  /**
   * Orchestration mission/step room 은 **발화 시점에도** 권한을 다시 본다 (티켓 f6a0de0e,
   * 리뷰 라운드1 지적 1).
   *
   * participant 행은 한 번 생기면 남는다. 그래서 join 시점의 `MANAGE_ACTIONS` 검사만으로는
   * 경계가 지속되지 않는다 — 관리자가 참여한 뒤 일반 사용자로 강등되거나 권한이 회수돼도
   * 행이 그대로라 계속 발화하고 orchestrator 를 깨울 수 있었다. 티켓의 "권한 없는 사용자는
   * 여전히 차단" 은 join 순간이 아니라 **매 발화**에 걸리는 조건이다.
   *
   * 권한을 세션 스냅샷이 아니라 `users` 행에서 직접 읽는 이유도 같다: 회수가 즉시 반영돼야
   * 하고, 이 경로는 REST 세션 밖(MCP·agent-api)에서도 통과할 수 있어야 한다.
   *
   * 통과시키는 두 경우:
   *   - agent 발화 — 신원 검사는 orchestration 런너가 lease/orchestrator id 로 따로 한다.
   *     여기서 사람 권한을 요구하면 정상 디스패치가 죽는다.
   *   - 의사 user `system` (비-uuid) — 엔진 자신의 브리핑·wake 발화다. `users` 행이 없다.
   *
   * 티켓 9cfd8161 이후로는 권한 앞에 **미션 단위 규칙 두 개**가 더 붙는다 — 미션이 이미
   * 끝났는가, 그리고 미션의 `user_chat_mode` 가 `off` 인가. 셋은 서로 다른 사유이므로 서로
   * 다른 메시지를 던진다: 화면이 "참여자가 아님"으로 뭉뚱그리던 것이 바로 그 티켓의
   * 요구사항 C 였다.
   *
   * 그 두 규칙의 적용 범위는 **mission 방 하나**다. step 방(`orchestration_step_id` 가
   * 있는 방)에도 `orchestration_mission_id` 가 찍히지만, 그쪽은 사람이 읽는 대화가 아니라
   * 에이전트 작업 지시 채널이라 이 옵션이 다루는 표면이 아니다 —
   * `resolveMissionChatPolicy` 가 step 방에 `null` 을 돌려주므로 step 방의 계약은
   * 이 티켓 이전과 정확히 같게 남는다(MANAGE_ACTIONS 검사는 그대로).
   */
  async requireMissionRoomSpeaker(
    room: { orchestration_mission_id?: string | null; orchestration_step_id?: string | null } | null | undefined,
    senderType: string,
    senderId: string,
    /**
     * 호출자가 이미 해석해 둔 정책(`resolveMissionChatPolicy` 의 결과). `sendMessage` 는
     * 자유 참여 완화를 계산하느라 어차피 한 번 읽으므로, 같은 요청 안에서 미션을 두 번
     * 조회하지 않도록 넘겨받는다. 생략하면 여기서 직접 읽는다 — 다른 호출부와 테스트가
     * 기존 3-인자 시그니처 그대로 동작해야 하기 때문이다.
     */
    policy?: MissionChatPolicy | null,
  ): Promise<void> {
    if (!room?.orchestration_mission_id) return;
    if (senderType !== 'user') return;
    if (!UUID_RE.test(senderId)) return;

    // ── 미션 단위 chat 옵션(티켓 9cfd8161) ─────────────────────────────────
    //
    // 사용자 개인의 권한보다 **먼저** 본다. 이 두 규칙은 관리자에게도 똑같이 걸리는
    // 미션 전체의 상태라서, 사유로서 더 정확하고 더 쓸모 있다 — "당신에게 권한이
    // 없다"보다 "이 방에서는 아무도 말할 수 없다"가 사용자가 할 수 있는 행동을
    // 정확히 알려준다(요구사항 C: 실제 사유를 드러낼 것).
    const resolved = policy !== undefined ? policy : await this.resolveMissionChatPolicy(room);
    if (resolved) {
      // 종료된 미션은 읽기 전용이다. `joinMissionConversation` 이 이미 같은 규칙으로
      // 종료 미션 참여를 409 로 거부하고 화면도 입력창을 감추는데, 발화 경로만 이
      // 규칙을 몰라 REST 를 직접 부르면 새 지시가 들어갔다. 세 표면이 같은 말을
      // 하도록 여기서 닫는다. 기록 열람은 관전 경로로 그대로 열려 있다.
      if (resolved.terminal) {
        throw makeError(403, 'This mission has finished — its conversation is read-only');
      }
      if (resolved.mode === 'off') {
        throw makeError(403, 'User chat is turned off for this mission');
      }
    }

    const user = await this.userRepo.findOne({ where: { id: senderId } });
    const customPermissions = (() => {
      try {
        const parsed = JSON.parse((user as any)?.permissions || '[]');
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    })();
    if (!user || !hasPermission(user.role, customPermissions, PERMISSIONS.MANAGE_ACTIONS)) {
      throw makeError(403, 'Not allowed to speak in this orchestration room');
    }
  }

  /**
   * Shared helper for read endpoints that are keyed only by roomId (e.g. GET
   * .../session-status): throw 404 if the room doesn't exist OR belongs to a
   * different workspace than the caller's current one (same status for both
   * so a foreign-workspace roomId doesn't confirm existence), and — unless
   * `observer` (the workspace-wide monitoring view, same bypass `getRoom`
   * grants via `?observer=true`) — 403 unless userId is an active participant.
   * `getRoomDetail` intentionally tolerates a non-member viewer for that same
   * observer flow but never checked workspace_id at all; this helper is the
   * one used by endpoints that need the workspace boundary actually enforced
   * (ticket e18be8ff review round 2, P1 #1).
   */
  async requireRoomAccess(
    roomId: string,
    workspaceId: string,
    userId: string,
    opts: { observer?: boolean } = {},
  ): Promise<void> {
    const room = await this.roomRepo.findOne({ where: { id: roomId } });
    if (!room || room.workspace_id !== workspaceId) {
      throw makeError(404, 'Room not found');
    }
    if (!opts.observer) {
      await this.requireActiveParticipant(roomId, userId, 'user');
    }
  }

  /**
   * Shared helper: resolve a (type, id) pair to a human-readable display name.
   * Returns 'Unknown User' / 'Unknown Agent' / 'Unknown' on miss (never throws).
   *
   * Synthetic non-uuid senders short-circuit BEFORE any DB lookup. QA-run and
   * scheduler-triggered Action dispatch author their first room message as the
   * literal `'system'` sender (see QaRunService.startQaRun / ActionsService.
   * dispatch). users.id / agents.id are uuid columns, so on Postgres the lookup
   * `WHERE id = 'system'` aborts the whole query with `invalid input syntax for
   * type uuid: "system"`. That doesn't just 500 a manual get_chat_room_messages
   * read — the agent-manager fetches a room's history (this same getMessages →
   * resolveParticipantName path, via GET /api/agent/chat-rooms/:id/messages)
   * BEFORE spawning a worker for a chat dispatch, so the throw made the dispatch
   * fall into its catch-and-drop branch and NO QA executor ever spawned. Guarding
   * the cast here fixes both the read and the silent no-spawn in one place, and
   * also covers every already-persisted 'system' row.
   */
  async resolveParticipantName(participantType: string, participantId: string): Promise<string> {
    if (!participantId || !UUID_RE.test(participantId)) {
      // 'system' is the known dispatch author; anything else non-uuid is a
      // malformed/legacy id — neither is a row in users/agents.
      return participantId === 'system' ? 'System' : 'Unknown';
    }
    if (participantType === 'user') {
      const user = await this.userRepo.findOne({ where: { id: participantId } });
      return user ? (user.name || user.email) : 'Unknown User';
    } else if (participantType === 'agent') {
      const display = await resolveAgentDisplayName(this.agentRepo, participantId);
      return display ?? 'Unknown Agent';
    }
    return 'Unknown';
  }
}
