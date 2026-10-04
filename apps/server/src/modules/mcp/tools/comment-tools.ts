/**
 * Comment MCP tools.
 *
 * Tools: add_comment, ask_question, answer_question, record_decision
 *
 * Agent comments never wake anyone by themselves (TicketDispatchService only
 * re-sends a ticket on a HUMAN comment), so the old ping-pong / hard-budget
 * comment guards are gone with the role fan-out they protected.
 *
 * The three typed-intent tools (ask_question / answer_question / record_decision)
 * are thin wrappers around the same Comment.save() that add_comment uses, but
 * they pin the `type` discriminator at the tool boundary so the agent's intent
 * is encoded in the call itself. This makes prompt design clearer than
 * "use add_comment with type='question'" and avoids agents drifting back to
 * type='note' by forgetting to pass the field.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { In } from 'typeorm';
import { Comment, CommentType, COMMENT_TYPES } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { User } from '../../../entities/User';
import { UserMention } from '../../../entities/UserMention';
import { Resource } from '../../../entities/Resource';
import { activityEvents } from '../../../services/activity.service';
import { ok, err, MENTION_SYNTAX_DOC, sanitizeHarnessMarkers } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import { resolveCallerIdentityRow } from '../shared/authz';
import { RuntimeHost } from '../../../entities/RuntimeHost';
import { resolveAgentDisplayName, isUuidShapedId } from '../../../utils/agent-name';
import { agentIsVisibleInWorkspace } from '../../../common/agent-workspace-scope';
import { resolveAuthorRole, mergeAuthorRoleIntoMetadata } from './author-role';
import { TicketArchivedError } from '../shared/archive-helpers';
import type { ToolContext } from './context';
import { computeTicketCommentChainDepth } from '../../../common/agent-chain-depth';
import { lockTicketCommentWrites } from '../../../common/ticket-comment-write-lock';
import { tiedCreatedAtWhere } from '../../../common/created-at-since-param';
import { resolveMentionTarget } from '../../../common/mention-dispatch-profile';

// ticket e341bcc2: silent-exit 엔드포인트의 fingerprint 기반 합치기
// (agent-api.controller.ts computeSystemFingerprint) 를 `metadata.dedupe_key`
// 로 옵트인하는 모든 add_comment 호출자에게 일반화한다. 메모리 상의
// metadata 객체(호출자의 요청)와 Comment row 가 저장하는 raw JSON 문자열
// 양쪽 모두 같은 헬퍼로 읽을 수 있다.
function parseCommentMetadata(metadata: unknown): Record<string, unknown> {
  if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata === 'string') {
    try {
      const parsed = JSON.parse(metadata);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
  return {};
}

function extractDedupeKey(metadata: unknown): string | null {
  const key = parseCommentMetadata(metadata).dedupe_key;
  return typeof key === 'string' && key ? key : null;
}

// 리뷰 라운드2/3(ticket e341bcc2): "티켓의 마지막 코멘트"를 created_at 하나로만
// 정렬하면 sql.js 에서 비결정적이다 — @CreateDateColumn 이 DB 기본값
// datetime('now') 에 맡겨질 때 초 단위로 truncate 되므로(common/created-at-
// since-param.ts 의 근본원인 설명 참고), 같은 초에 여러 건이 insert 되면
// 순서가 정해지지 않는다. TypeORM `@Generated('increment')` 로 진짜
// auto-increment 컬럼을 추가하는 방안은 이 티켓에서 직접 검증한 결과 sqljs
// 드라이버가 세컨더리(비-PK) 컬럼에도 `AUTOINCREMENT` DDL 을 내려 "near
// AUTOINCREMENT: syntax error" 로 스키마 동기화 자체가 깨져서 폐기했다.
//
// 라운드2 에서는 프로세스-내 단조 카운터로 이 tie 를 깼으나, 라운드3 리뷰가
// 지적한 대로 그 카운터는 (1) 프로세스 재시작에 리셋되어 영속적이지 않고,
// (2) "마지막 코멘트" 조회를 `take:20` 윈도우로 제한해 같은 초에 21건 이상
// 몰리면 진짜 마지막 row 가 창 밖으로 빠질 수 있었다. 지금은 DB 상태에서
// 그때그때 유도하는 값으로 교체한다:
//   1. `lockTicketCommentWrites` 로 같은 티켓 코멘트 쓰기가 이미 직렬화된
//      상태에서, 그 시점 이 티켓의 가장 최근 created_at 을 조회한다.
//   2. 그 created_at 과 같은 시각의 row 를 (LIMIT 없이) 전부 가져온다 —
//      같은 초에 몇 건이 몰리든 개수와 무관하게 전량 조회된다. "같은 시각"
//      판정은 드라이버 저장 정밀도에 맞춰야 한다(ticket 62407d4e): 단순 등호는
//      Postgres 의 마이크로초 꼬리가 JS Date 왕복에서 잘려 0건이 되므로
//      tiedCreatedAtWhere() 가 sqljs 는 초 단위 등호, 그 외는 [t, t+1ms)
//      반개구간으로 갈라 준다.
//   3. 그 tied-group 안에서 `_comment_write_seq` 최댓값 + 1 을 다음 값으로
//      쓰고, 최댓값을 가진 row 를 "진짜 마지막 코멘트"로 채택한다.
// 매 insert 가 그 순간의 DB 값으로부터 새로 계산되므로(프로세스 메모리에
// 의존하지 않음) 재시작과 무관하게 항상 올바르고, tied-group 을 개수 제한
// 없이 통째로 가져오므로 같은 초 burst 크기와도 무관하다. "seq 가 가장 큰
// row 는 항상 created_at 도 가장 최신인 tied-group 안에 있다"는 불변식은
// 매 insert 가 쓰기 직렬화 하에 그 시점 MAX(seq)+1 을 부여하기 때문에
// 성립한다 — 삽입 순서상 나중 row 는 seq 가 항상 엄격히 더 크고 created_at
// 은 항상 같거나 더 크므로, 전역 최대 seq 를 가진 row 가 가장 오래된
// created_at 그룹에 속할 수 없다.
function extractWriteSeq(metadata: unknown): number {
  const seq = parseCommentMetadata(metadata)._comment_write_seq;
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : -1;
}

export function registerCommentTools(server: McpServer, ctx: ToolContext): void {
  const {
    dataSource, activityService, mentionService, logger, artifactRefsService,
  } = ctx;

  const resolveAuthorRoleFor = async (
    ticketId: string,
    requestedRole: string | undefined,
    authorType: 'user' | 'agent',
    authorId: string,
    sessionRole: string | undefined,
    sessionTicketId: string | undefined,
  ): Promise<string | null> => {
    const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticketId }, select: ['id', 'assignee_key'] });
    return resolveAuthorRole(ticket ?? { id: ticketId }, requestedRole, authorType, authorId, sessionRole, sessionTicketId);
  };

  server.tool(
    'add_comment',
    'Add a comment to a ticket. When authenticated as an agent, author fields are auto-filled if omitted. ' +
      'Optional `type`/`parent_id`/`metadata` mirror the REST endpoint so an agent can post note/chat/handoff/etc. ' +
      'directly without falling back to the more opinionated ask_question/answer_question/record_decision tools. ' +
      'type=\'system\' is reserved for SystemCommentService and rejected here.\n\n' +
      MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID'),
      author_type: z.enum(['user', 'agent']).optional().describe('Comment author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved from auth/ID if omitted)'),
      content: z.string().describe('Comment content'),
      type: z.enum(['note', 'question', 'answer', 'decision', 'chat', 'handoff']).optional()
        .describe("Comment type discriminator (default 'note'). type='answer' requires parent_id and auto-resolves the parent question."),
      parent_id: z.string().optional()
        .describe("Parent comment id for threading. Must belong to the same ticket. Required for type='answer'."),
      metadata: z.record(z.string(), z.unknown()).optional()
        .describe('Type-specific extension bag (e.g. handoff target_agent_id, decision references[]). Stored as JSON on the row. ' +
          'Set `dedupe_key` (any stable string you control) to collapse repeats — eligible ONLY for plain type=\'note\' calls ' +
          'with no attachment_resource_ids and no @-mentions in content (other combinations always insert a fresh row, since ' +
          'bumping in place would silently skip their side effects): when eligible, if the ticket\'s LAST comment was written ' +
          'by the same author with the same type and dedupe_key, this call bumps its repeat_count/last_repeated_at in place ' +
          'instead of adding a new row — use this for noisy auto-generated notices that may fire many times in a row (a ' +
          'different author/type/dedupe_key, or an unrelated reply, in between always starts a fresh row). ' +
          'Set `auto_notice: true` when this comment is itself a manager-generated automatic notice (e.g. a provisioning-blocker ' +
          'notification) — its activity-log row is stamped actor_id=\'system\'. Honored only for the Runtime Host\'s own session.'),
      author_role: z.string().optional()
        .describe("Role the comment is authored as. Auto-filled ('assignee' when you are the ticket's assignee, or the subagent session pin) when omitted. Stored on metadata.author_role."),
      attachment_resource_ids: z.array(z.string()).optional()
        .describe("Resource ids to attach. Each must already exist with type='comment_attachment' in the ticket's workspace — create them first via save_resource. MCP does not accept inline base64 here (cap payload size, keep upload/transaction logic in one place)."),
    },
    async ({ ticket_id, author_type, author_id, author, content, type, parent_id, metadata, author_role, attachment_resource_ids }, extra: { sessionId?: string }) => {
      const ticketRepo = dataSource.getRepository(Ticket);
      const ticket = await ticketRepo.findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      // Strip any `<system-reminder>…</system-reminder>` or sibling harness
      // markers a confused CLI subagent echoed from its model context into
      // the comment body (ticket ce6c8d58). Pre-resolve the caller for the
      // log line so we know which agent is leaking.
      const __callerForSanitize = getCallerAgent(extra);
      content = sanitizeHarnessMarkers(content, { logger, toolName: 'add_comment', fieldName: 'content', agentId: __callerForSanitize?.agentId });
      if (artifactRefsService && ticket.workspace_id) {
        content = await artifactRefsService.normalizeStoredOutput(ticket.workspace_id, content);
      }

      // 리뷰 라운드2(ticket e341bcc2): 아래 dedupe 옵트인 판정과 파일 하단의
      // mention 디스패치 블록이 같은 파싱 결과를 재사용하도록 한 번만 계산한다.
      const mentionRefs = mentionService.parseMentions(content);

      // Validate type — REST endpoint shape parity. Zod already restricts to the
      // allowed enum, but we also reject 'system' explicitly so an agent can't
      // forge audit-log entries by claiming type=system.
      if (type !== undefined && !COMMENT_TYPES.includes(type as CommentType)) {
        return err(`Unsupported comment type: ${type}`);
      }
      const resolvedType: CommentType = (type as CommentType | undefined) || 'note';
      if (resolvedType === 'system') {
        return err("type='system' is reserved for SystemCommentService");
      }

      // Validate parent_id (when given): must exist and belong to the same ticket.
      const commentRepo = dataSource.getRepository(Comment);
      let resolvedParentId: string | null = null;
      if (parent_id) {
        const parent = await commentRepo.findOne({ where: { id: parent_id } });
        if (!parent) return err('parent_id references a non-existent comment');
        if (parent.ticket_id !== ticket_id) return err('parent comment belongs to a different ticket');
        resolvedParentId = parent.id;
      }
      if (resolvedType === 'answer' && !resolvedParentId) {
        return err("type='answer' requires parent_id pointing to the question being answered");
      }

      // Auto-fill from authenticated agent if fields are missing
      const caller = getCallerAgent(extra);
      const resolvedAuthorType = author_type || (caller?.agentId ? 'agent' : 'user');
      const resolvedAuthorId = author_id || caller?.runtimeKey || caller?.agentId || '';

      if (!resolvedAuthorId) return err('author_id is required (or authenticate with an agent API key)');

      // Resolve author name if not provided. For agents always go through
      // `resolveAgentDisplayName` so the denormalized `author` snapshot picks
      // up the `<Manager>/<Agent>` prefix — `caller.agentName` carries only
      // the bare API-key name.
      let authorName = author || '';
      if (!authorName) {
        if (resolvedAuthorType === 'agent') {
          const display = await resolveAgentDisplayName(dataSource, resolvedAuthorId);
          authorName = display || caller?.agentName || `Agent #${resolvedAuthorId}`;
        } else {
          // Postgres 에서 `User.id` 는 real uuid 컬럼이라(`entities/User.ts` 의
          // `@PrimaryGeneratedColumn('uuid')`) 비-uuid author_id 로 findOne 하면
          // `invalid input syntax for type uuid` 로 **throw** 해 add_comment
          // 자체가 실패한다 — sqlite 는 매칭 0건으로 조용히 아래 폴백을 쓴다.
          // ticket a825872b: dedff9a3 이 Agent.id 에 적용한 것과 같은 결함
          // 클래스이고, 같은 술어로 uuid 모양이 아니면 쿼리 없이 폴백해 두
          // 백엔드의 동작을 일치시킨다. author_id 는 원래부터 실존 사용자인지
          // 검증하지 않는 인자라 권한 약화도 없다.
          const user = isUuidShapedId(resolvedAuthorId)
            ? await dataSource.getRepository(User).findOne({ where: { id: resolvedAuthorId } })
            : null;
          authorName = user?.name || `User #${resolvedAuthorId}`;
        }
      }

      // Validate any attachment_resource_ids so agents can't cross-workspace
      // or mistakenly wire a generic resource into a comment.
      const resolvedAttachmentIds: string[] = Array.isArray(attachment_resource_ids)
        ? attachment_resource_ids.filter((v): v is string => typeof v === 'string' && !!v)
        : [];
      if (resolvedAttachmentIds.length > 0) {
        const rows = await dataSource.getRepository(Resource).findBy({ id: In(resolvedAttachmentIds) } as any);
        const found = new Map(rows.map(r => [r.id, r]));
        for (const rid of resolvedAttachmentIds) {
          const r = found.get(rid);
          if (!r) return err(`attachment_resource_ids contains unknown id: ${rid}`);
          if (r.workspace_id !== ticket.workspace_id) return err(`attachment resource ${rid} belongs to a different workspace`);
          if (r.type !== 'comment_attachment') return err(`attachment resource ${rid} is type=${r.type}; expected comment_attachment`);
        }
      }

      const resolvedAuthorRole = await resolveAuthorRoleFor(
        ticket_id,
        author_role,
        resolvedAuthorType,
        resolvedAuthorId,
        caller?.subagentRole,
        caller?.subagentTicketId,
      );
      const finalMetadata = stampCycleProvenance(
        mergeAuthorRoleIntoMetadata(metadata, resolvedAuthorRole),
        caller,
      );

      // 합치기(dedupe merge, ticket e341bcc2): `metadata.dedupe_key` 를 찍은
      // 호출자는 silent-exit 엔드포인트가 (reason, exit_code, author_role)
      // fingerprint 에 쓰는 것과 같은 in-place bump 에 옵트인한다 — 예를 들어
      // agent-manager 의 dispatch 억제 코멘트는 이게 없으면 억제될 때마다
      // 새 row 를 쌓는다. 합치기는 티켓의 마지막 코멘트에만 적용된다
      // (silent-exit 과 동일한 계약) — 중간에 무관한 답글이 끼면 항상 새
      // occurrence row 로 시작해 타임라인 가독성을 유지한다.
      //
      // 리뷰 라운드2(ticket e341bcc2) 반영 — 옵트인 범위를 이 티켓이 실제로
      // 쓰는 자동 억제 note 로 제한한다: type='note' 이고 첨부/멘션이 없는
      // 호출만 합치기 후보다. answer 의 부모-resolve, mention 디스패치, 첨부
      // 연결처럼 bump 의 조기 반환(성공 시 그대로 return, 아래 deduped 분기)이
      // 건너뛰는 부수효과가 있는 호출은 애초에 후보에서 제외해 그 부수효과가
      // 조용히 유실되지 않게 한다.
      const dedupeKey = extractDedupeKey(finalMetadata);
      const dedupeEligible = !!dedupeKey && resolvedType === 'note'
        && resolvedAttachmentIds.length === 0 && mentionRefs.length === 0;
      let comment: Comment;
      let deduped = false;
      try {
        comment = await dataSource.transaction(async (manager) => {
          await lockTicketCommentWrites(manager, ticket_id);
          const lockedRepo = manager.getRepository(Comment);

          // "마지막 코멘트" 판정 + 다음 write-seq 채번을 모두 이 tied-group
          // 조회 하나로 처리한다(파일 상단 extractWriteSeq 주석 참고, 리뷰
          // 라운드3). 프로세스-로컬 카운터도 take:N 윈도우도 없다: 이 티켓의
          // 현재 최신 created_at 을 먼저 찾고, 그와 같은 시각의 row 를 LIMIT
          // 없이 전부 가져와 그 안에서 write-seq 최댓값과 그 보유자를 고른다.
          // "같은 시각" 판정은 드라이버마다 저장 정밀도가 달라 등호 하나로는
          // 성립하지 않는다 — sqljs 는 초 단위 문자열, Postgres 는 마이크로초라
          // JS Date 왕복에서 꼬리가 잘린다. 양쪽을 tiedCreatedAtWhere 가 각각
          // 맞는 조건으로 만든다(ticket 62407d4e).
          const mostRecent = await lockedRepo.findOne({
            where: { ticket_id },
            order: { created_at: 'DESC' },
          });
          let lastComment: Comment | null = null;
          let maxWriteSeq = 0;
          if (mostRecent) {
            const tied = tiedCreatedAtWhere(dataSource, 'c', mostRecent.created_at);
            const tiedRows = await lockedRepo.createQueryBuilder('c')
              .where('c.ticket_id = :ticket_id', { ticket_id })
              .andWhere(`(${tied.clause})`, tied.params)
              .getMany();
            // fail-safe: mostRecent 는 정의상 이 티켓의 최대 created_at row 이므로
            // tied group 의 원소여야 한다. 조회가 그것조차 못 집으면(= 어떤
            // 드라이버가 위 창보다도 큰 정밀도를 잃는 경우) 티켓이 비어 있는 것과
            // 구별되지 않아 합치기가 조용히 죽는다 — 바로 이번 결함의 실패 모드다.
            // 그 상태를 다시 만들지 않도록 여기서 항상 자기 자신을 포함시킨다.
            const tiedGroup = tiedRows.some((c) => c.id === mostRecent.id)
              ? tiedRows
              : [...tiedRows, mostRecent];
            for (const c of tiedGroup) {
              const seq = extractWriteSeq(c.metadata);
              if (seq > maxWriteSeq) maxWriteSeq = seq;
              if (!lastComment || seq > extractWriteSeq(lastComment.metadata)) lastComment = c;
            }
          }
          // 모든 저장(합치기든 신규 insert 든)에 이 값을 찍는다 — 이 호출
          // 자체는 dedupe_key 가 없어도, 나중에 같은 티켓에 dedupe_key 를
          // 실은 호출이 와서 "마지막 코멘트"를 찾을 때 이 행을 후보로 올바르게
          // 비교하려면 필요하다.
          finalMetadata._comment_write_seq = maxWriteSeq + 1;

          // 최소 요건(리뷰 지적): 후보 row 가 작성자(type+id)와 type 까지
          // 지금 이 호출과 완전히 같을 때만 합친다 — 다른 agent 가 우연히
          // 같은 dedupe_key 문자열을 재사용해도 남의 코멘트 작성자 이름
          // 아래 내용만 바뀌는 일이 없다.
          if (
            dedupeEligible
            && lastComment
            && lastComment.author_type === resolvedAuthorType
            && lastComment.author_id === resolvedAuthorId
            && lastComment.type === resolvedType
            && extractDedupeKey(lastComment.metadata) === dedupeKey
          ) {
            const nextCount = (lastComment.repeat_count ?? 1) + 1;
            await lockedRepo.update(lastComment.id, {
              content,
              metadata: JSON.stringify(finalMetadata),
              repeat_count: nextCount,
              last_repeated_at: new Date(),
            });
            deduped = true;
            return (await lockedRepo.findOne({ where: { id: lastComment.id } }))!;
          }

          const saved = await lockedRepo.save(lockedRepo.create({
            ticket_id,
            author_type: resolvedAuthorType,
            author_id: resolvedAuthorId,
            author: authorName,
            content,
            attachment_resource_ids: JSON.stringify(resolvedAttachmentIds),
            type: resolvedType,
            status: resolvedType === 'question' ? 'open' : null,
            parent_id: resolvedParentId,
            metadata: JSON.stringify(finalMetadata),
          }));
          if (resolvedType === 'answer' && resolvedParentId) {
            await lockedRepo.update({ id: resolvedParentId }, { status: 'resolved' });
          }
          return saved;
        });
      } catch (error) {
        throw error;
      }

      if (deduped) {
        // action:'updated' + actor_id:'system' — resolvedAuthorId/'created' 가
        // 아니다. silent-exit 선례의 131,068-사이클 런어웨이 인시던트
        // (2026-05-28) 가 못박은 바로 그 규칙이다: trigger-loop 의
        // system-actor 가드는 이 조합에서만 재디스패치를 건너뛰므로, bump 된
        // 합치기 row 는 원인 agent 를 절대 스스로 재트리거할 수 없다.
        await activityService.logActivity({
          entity_type: 'comment', entity_id: comment.id, action: 'updated',
          ticket_id, actor_id: 'system', actor_name: authorName,
          new_value: String(comment.repeat_count ?? 1),
          field_changed: 'repeat_count',
        });
        return ok(comment);
      }

      // Auto-resolve parent question on answer — same idempotent flip the REST
      // endpoint and answer_question tool perform, so all three surfaces agree.
      //
      // ticket 3c8b8026: metadata.auto_notice===true(system/manager 자동 알림,
      // 예: dispatch 억제 공지)은 이 첫 insert 에서도 위 deduped 분기와 동일하게
      // actor_id='system' 으로 남긴다 — trigger-loop.service.ts의 system-actor
      // 가드가 이 값 하나만으로 재트리거를 건너뛰므로, 접히지 않은(=새 row 로
      // 들어가는) 알림도 스스로를 재트리거할 수 없다. 코멘트 자체의
      // author/author_id는 실제 호출자(예: Manager 에이전트) 그대로 저장되어
      // 화면 귀속은 바뀌지 않는다 — 이 스탬프는 activity-log 의 트리거 판단에만
      // 영향을 준다. 리뷰 라운드1 지적1: 값 자체가 아니라 발신자를 검증한다
      // (인증 세션의 manager 신원과 저장 author 일치) — 임의 agent 의 요청값
      // 위조로는 이 경로를 탈 수 없다.
      const isAutoNotice = finalMetadata.auto_notice === true
        && await isAuthenticatedManagerAutoNotice(caller, resolvedAuthorType, resolvedAuthorId);
      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: isAutoNotice ? 'system' : resolvedAuthorId, actor_name: authorName,
        new_value: content,
        field_changed: resolvedType,
      });

      // Dispatch @-mentions just like the REST path
      // (tickets.controller._dispatchCommentMentions). Without this, a
      // subagent adding a comment via MCP with `@[agent:...|Name]` tokens
      // would only fire the ambient board_update — the target agent
      // never receives the targeted `comment_mention` event and so the
      // mention silently degrades to an update.
      try {
        const refs = mentionRefs;
        if (refs.length > 0) {
          // Self-exclusion: never a comment_mention back to the author.
          const resolved = await mentionService.resolveMentions(refs, ticket, {
            excludeActor: { type: resolvedAuthorType, id: resolvedAuthorId },
          });
          const preview = (content || '').slice(0, 500);
          const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
          const userMentionRepo = dataSource.getRepository(UserMention);
          // ticket 07402c57: chain-depth stamp for the agent-mention ping-pong
          // cap (event-dispatcher.ts). Computed once and reused across every
          // fan-out target — it reflects this ticket's comment history, not
          // the recipient.
          const agentChainDepth = await computeTicketCommentChainDepth(commentRepo, ticket.id);
          // Instance-wide quiesce gate (ticket 0f638509 — live pull import),
          // checked once outside the loop — a quiesced destination must not
          // spawn/wake an agent via an @-mention either.
          const quiescedForMentions = await ctx.instanceQuiesceService.isQuiesced();
          for (const m of resolved) {
            if (m.type === 'agent') {
              if (quiescedForMentions) continue;
              // P4c-4: uuid 행 / rt- spec 공통 해소 (workspace 검사 포함).
              const target = await resolveMentionTarget(dataSource, ticket, m.id);
              if (!target) continue;
              const { extras } = target;
              activityEvents.emit('comment_mention', {
                ticket_id: ticket.id,
                comment_id: comment.id,
                workspace_id: ticket.workspace_id,
                agent_id: target.agentId,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                content,
                role_prompt: target.rolePrompt,
                dispatch_trigger_id: '',
                dispatch_role: '',
                mention_source: 'direct',
                role_shortcut: '',
                timestamp: ts,
                agent_chain_depth: agentChainDepth,
                harness_config: extras.harness_config,
                cli_runtime_profile: extras.cli_runtime_profile,
                effort_preset: extras.effort_preset,
                environment_config: extras.environment_config,
                worktree_mode: extras.worktree_mode,
                // P4c-4: rt- 멘션의 spec (매니저 해소 + fan-out host-affinity용).
                ...(target.runtime ? { runtime: target.runtime } : {}),
              });
              logger.info('Mentions', `Agent @-mention routed via MCP add_comment: ${target.displayName} (${target.agentId}) on ticket ${ticket.id}`);
            } else {
              const row = await userMentionRepo.save(userMentionRepo.create({
                user_id: m.id,
                workspace_id: ticket.workspace_id,
                source_type: 'comment',
                source_id: comment.id,
                ticket_id: ticket.id,
                room_id: null,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                preview,
              }));
              activityEvents.emit('user_mention', {
                mention_id: row.id,
                user_id: row.user_id,
                workspace_id: row.workspace_id,
                source_type: 'comment',
                source_id: comment.id,
                ticket_id: ticket.id,
                room_id: null,
                actor_id: resolvedAuthorId,
                actor_type: resolvedAuthorType,
                actor_name: authorName,
                preview,
                created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
              });
              logger.info('Mentions', `User @-mention recorded via MCP add_comment: user ${row.user_id} on ticket ${ticket.id}`);
            }
          }
        }
      } catch (e) {
        // Never fail the comment save because mention dispatch blew up.
        logger.warn('Mentions', `MCP add_comment mention dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return ok(comment);
    }
  );

  // ─── Helper: resolve caller identity (auth + author resolution) ────
  // Centralizes the auto-fill logic that all 4 tools share. Returns the
  // resolved {authorType, authorId, authorName} or an error tuple.
  async function resolveAuthor(
    requestedType: 'user' | 'agent' | undefined,
    requestedId: string | undefined,
    requestedName: string | undefined,
    extra: { sessionId?: string },
  ): Promise<{ authorType: 'user' | 'agent'; authorId: string; authorName: string } | { error: string }> {
    const caller = getCallerAgent(extra);
    const authorType = requestedType || (caller?.agentId ? 'agent' : 'user');
    const authorId = requestedId || caller?.runtimeKey || caller?.agentId || '';
    if (!authorId) return { error: 'author_id is required (or authenticate with an agent API key)' };

    let authorName = requestedName || '';
    if (!authorName) {
      if (authorType === 'agent') {
        const display = await resolveAgentDisplayName(dataSource, authorId);
        authorName = display || caller?.agentName || `Agent #${authorId}`;
      } else {
        // 비-uuid id 를 real uuid 컬럼에 던지지 않는다 — add_comment 쪽 같은
        // 조회의 주석 참고(ticket a825872b). 이 헬퍼는 ask_question ·
        // answer_question · record_decision · record_agreement · propose_move ·
        // handoff_to_agent 가 공유하므로 여섯 툴이 같은 가드를 받는다.
        const user = isUuidShapedId(authorId)
          ? await dataSource.getRepository(User).findOne({ where: { id: authorId } })
          : null;
        authorName = user?.name || `User #${authorId}`;
      }
    }
    return { authorType, authorId, authorName };
  }

  // ─── Helper: auto_notice 발신자 검증 (ticket 3c8b8026 리뷰 라운드1 지적1) ──
  // metadata.auto_notice 는 값 자체만으로 activity-log actor_id 를 'system'
  // 으로 바꿔 코멘트→트리거 경로를 끊는, 행동에 실질적 영향을 주는 신호다.
  // 값을 자기선언만으로 신뢰하면 아무 agent 나 평범한 코멘트에 이 값을 실어
  // routed-role 의 정상 comment wake 를 조용히 숨길 수 있어, 티켓의 위험
  // 조건("판정은 작성자 종류(system/manager 자동 알림) 기준으로 좁게")을
  // 어긴다. 그래서 값이 아니라 "이 값을 존중해도 되는 발신자인가"를 검증한다
  // — 요청 author가 아니라 인증 세션을 기준으로 하며, agent-manager 가 이
  // 알림들을 남길 때 인증하는 신원은 항상 페어링으로
  // 발급된 매니저 전용 Agent(type='manager') 다(개별 티켓 역할 agent 의
  // per-agent 키가 아니라 EventDispatcher 자신의 공유 config.apiKey, 참고
  // apps/agent-manager/src/lib/mcp-client.ts 의 fireAndForgetTool). 그 외
  // caller 가 auto_notice 를 실어 보내면 에러 없이 조용히 무시하고(다른
  // 옵트인 메타데이터 필드들과 같은 관용 방식) 평범한 코멘트로 저장한다 —
  // 즉 activity-log 는 여전히 실제 caller 를 actor_id 로 남겨 정상 트리거된다.
  async function isAuthenticatedManagerAutoNotice(
    caller: ReturnType<typeof getCallerAgent>,
    authorType: 'user' | 'agent',
    authorId: string,
  ): Promise<boolean> {
    // 요청의 author_id는 호환성을 위해 호출자가 지정할 수 있으므로 권한 근거로
    // 삼지 않는다. 인증 세션의 agentId가 저장 author와 일치하는 경우에만 조회한다.
    if (authorType !== 'agent' || !caller?.agentId || caller.agentId !== authorId) return false;
    // P4c-4: host-keyed 매니저 세션 (agentId = Host uuid, Agent 행 없음).
    const host = await dataSource.getRepository(RuntimeHost).findOne({ where: { id: caller.agentId } });
    return !!host;
  }

  // ─── ask_question ────────────────────────────────────────────────
  server.tool(
    'ask_question',
    'Ask a question on a ticket — creates a comment with type=question, status=open. The ticket creator (or @mentioned user) is notified. Use this when you are blocked and need a human answer before continuing; the ticket detail UI surfaces the open question prominently.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID the question is about'),
      content: z.string().describe('Question body. Plain text or markdown. Embed @[user:id|Name] tokens to direct the question at a specific user.'),
      author_type: z.enum(['user', 'agent']).optional().describe('Author type (auto-detected from auth)'),
      author_id: z.string().optional().describe('Author ID (auto-filled from auth if omitted)'),
      author: z.string().optional().describe('Display name (auto-resolved if omitted)'),
      author_role: z.string().optional()
        .describe("Role the question is authored as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ ticket_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);



      content = sanitizeHarnessMarkers(content, { logger, toolName: 'ask_question', fieldName: 'content', agentId: resolved.authorId });

      const commentRepo = dataSource.getRepository(Comment);
      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRoleFor(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const askMetadata = stampCycleProvenance(
        mergeAuthorRoleIntoMetadata(undefined, resolvedAuthorRole),
        callerCtx,
      );


      const comment = await dataSource.transaction(async (manager) => {
        await lockTicketCommentWrites(manager, ticket_id);
        const lockedRepo = manager.getRepository(Comment);
        return lockedRepo.save(lockedRepo.create({
          ticket_id,
          author_type: resolved.authorType,
          author_id: resolved.authorId,
          author: resolved.authorName,
          content,
          type: 'question' as CommentType,
          status: 'open',
          metadata: JSON.stringify(askMetadata),
        }));
      });

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'question',
      });

      // Mention dispatch — same logic as the REST + add_comment paths so an
      // ask_question with @[user:...|Name] reaches the inbox + sidebar badge.
      try {
        const refs = mentionService.parseMentions(content);
        if (refs.length > 0) {
          // Self-exclusion (see add_comment): never a mention back to the author.
          const resolvedRefs = await mentionService.resolveMentions(refs, ticket, {
            excludeActor: { type: resolved.authorType, id: resolved.authorId },
          });
          const preview = (content || '').slice(0, 500);
          const ts = (comment.created_at instanceof Date ? comment.created_at : new Date()).toISOString();
          const userMentionRepo = dataSource.getRepository(UserMention);
          // ticket 07402c57: same chain-depth stamp as add_comment above.
          const agentChainDepth = await computeTicketCommentChainDepth(commentRepo, ticket.id);
          // Instance-wide quiesce gate (ticket 0f638509) — see add_comment above.
          const quiescedForMentions = await ctx.instanceQuiesceService.isQuiesced();
          for (const m of resolvedRefs) {
            if (m.type === 'agent') {
              if (quiescedForMentions) continue;
              // P4c-4: ask_question 멘션도 spec-direct 해소.
              const target = await resolveMentionTarget(dataSource, ticket, m.id);
              if (!target) continue;
              const { extras } = target;
              activityEvents.emit('comment_mention', {
                ticket_id: ticket.id, comment_id: comment.id, workspace_id: ticket.workspace_id,
                agent_id: target.agentId,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                content, role_prompt: target.rolePrompt,
                mention_source: 'direct', role_shortcut: '',
                dispatch_trigger_id: '', dispatch_role: '',
                timestamp: ts,
                agent_chain_depth: agentChainDepth,
                harness_config: extras.harness_config,
                cli_runtime_profile: extras.cli_runtime_profile,
                effort_preset: extras.effort_preset,
                environment_config: extras.environment_config,
                worktree_mode: extras.worktree_mode,
                ...(target.runtime ? { runtime: target.runtime } : {}),
              });
            } else {
              const row = await userMentionRepo.save(userMentionRepo.create({
                user_id: m.id, workspace_id: ticket.workspace_id,
                source_type: 'comment', source_id: comment.id,
                ticket_id: ticket.id, room_id: null,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                preview,
              }));
              activityEvents.emit('user_mention', {
                mention_id: row.id, user_id: row.user_id, workspace_id: row.workspace_id,
                source_type: 'comment', source_id: comment.id,
                ticket_id: ticket.id, room_id: null,
                actor_id: resolved.authorId, actor_type: resolved.authorType, actor_name: resolved.authorName,
                preview,
                created_at: (row.created_at instanceof Date ? row.created_at : new Date()).toISOString(),
              });
            }
          }
        }
      } catch (e) {
        logger.warn('Mentions', `ask_question mention dispatch failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      return ok(comment);
    }
  );

  // ─── answer_question ─────────────────────────────────────────────
  server.tool(
    'answer_question',
    'Answer a previously-asked question. Creates a comment with type=answer and parent_id pointing at the question; the parent question auto-resolves so the ticket no longer shows it as open. The original question must exist on the same ticket and have type=question.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      question_comment_id: z.string().describe("ID of the question comment being answered (Comment.id where type='question')"),
      content: z.string().describe('Answer body. Plain text or markdown.'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe("Role the answer is authored as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ question_comment_id, content, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const commentRepo = dataSource.getRepository(Comment);
      const question = await commentRepo.findOne({ where: { id: question_comment_id } });
      if (!question) return err('Question comment not found');
      if (question.type !== 'question') return err('Parent comment is not a question');
      // Refuse answers on archived tickets — the question + answer pair is a
      // mutation surface and the ticket is supposed to be read-only.
      const answerTicket = await dataSource.getRepository(Ticket).findOne({ where: { id: question.ticket_id } });
      if (answerTicket?.archived_at) return err(new TicketArchivedError(answerTicket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);

      content = sanitizeHarnessMarkers(content, { logger, toolName: 'answer_question', fieldName: 'content', agentId: resolved.authorId });

      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRoleFor(
        question.ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const answerMetadata = stampCycleProvenance(
        mergeAuthorRoleIntoMetadata(undefined, resolvedAuthorRole),
        callerCtx,
      );


      const answer = await dataSource.transaction(async (manager) => {
        await lockTicketCommentWrites(manager, question.ticket_id);
        const lockedRepo = manager.getRepository(Comment);
        const saved = await lockedRepo.save(lockedRepo.create({
          ticket_id: question.ticket_id,
          author_type: resolved.authorType,
          author_id: resolved.authorId,
          author: resolved.authorName,
          content,
          type: 'answer' as CommentType,
          parent_id: question.id,
          metadata: JSON.stringify(answerMetadata),
        }));
        // Keep the answer and the idempotent parent-resolution flip in the
        // same serialization boundary.
        await lockedRepo.update({ id: question.id }, { status: 'resolved' });
        return saved;
      });

      await activityService.logActivity({
        entity_type: 'comment', entity_id: answer.id, action: 'created',
        ticket_id: question.ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'answer',
      });

      return ok(answer);
    }
  );

  // ─── record_decision ─────────────────────────────────────────────
  server.tool(
    'record_decision',
    'Record a decision on a ticket — creates a comment with type=decision. Use this for resolved trade-offs, scope choices, or anything future readers should be able to find without scrolling the full discussion. Decisions render with a distinctive style and survive comment-filter toggles by default.\n\n' +
    MENTION_SYNTAX_DOC,
    {
      ticket_id: z.string().describe('Ticket ID'),
      content: z.string().describe('Decision text. Phrase as a statement: "We will use X because Y".'),
      references: z.array(z.string()).optional().describe('Optional comment ids the decision draws from (stored in metadata.references for later traceability).'),
      author_type: z.enum(['user', 'agent']).optional(),
      author_id: z.string().optional(),
      author: z.string().optional(),
      author_role: z.string().optional()
        .describe("Role the decision is recorded as. Auto-filled from subagent session pin or TicketRoleAssignment when omitted; stored on metadata.author_role."),
    },
    async ({ ticket_id, content, references, author_type, author_id, author, author_role }, extra: { sessionId?: string }) => {
      const ticket = await dataSource.getRepository(Ticket).findOne({ where: { id: ticket_id } });
      if (!ticket) return err('Ticket not found');
      if (ticket.archived_at) return err(new TicketArchivedError(ticket.id).message);

      const resolved = await resolveAuthor(author_type, author_id, author, extra);
      if ('error' in resolved) return err(resolved.error);



      content = sanitizeHarnessMarkers(content, { logger, toolName: 'record_decision', fieldName: 'content', agentId: resolved.authorId });

      const callerCtx = getCallerAgent(extra);
      const resolvedAuthorRole = await resolveAuthorRoleFor(
        ticket_id, author_role, resolved.authorType, resolved.authorId,
        callerCtx?.subagentRole, callerCtx?.subagentTicketId,
      );
      const decisionMetadata = stampCycleProvenance(mergeAuthorRoleIntoMetadata(
        references && references.length > 0 ? { references } : undefined,
        resolvedAuthorRole,
      ), callerCtx);


      const comment = await dataSource.transaction(async (manager) => {
        await lockTicketCommentWrites(manager, ticket_id);
        const lockedRepo = manager.getRepository(Comment);
        return lockedRepo.save(lockedRepo.create({
          ticket_id,
          author_type: resolved.authorType,
          author_id: resolved.authorId,
          author: resolved.authorName,
          content,
          type: 'decision' as CommentType,
          metadata: JSON.stringify(decisionMetadata),
        }));
      });

      await activityService.logActivity({
        entity_type: 'comment', entity_id: comment.id, action: 'created',
        ticket_id, actor_id: resolved.authorId, actor_name: resolved.authorName,
        new_value: content, field_changed: 'decision',
      });

      return ok(comment);
    }
  );
}

function stampCycleProvenance<T extends Record<string, unknown>>(
  metadata: T,
  caller: {
    subagentTriggerId?: string;
    subagentSessionId?: string;
    subagentTriggerSource?: string;
  } | null | undefined,
): T {
  return Object.assign(metadata, {
    ...(caller?.subagentTriggerId ? { cycle_trigger_id: caller.subagentTriggerId } : {}),
    ...(caller?.subagentSessionId ? { subagent_session_id: caller.subagentSessionId } : {}),
    ...(caller?.subagentTriggerSource ? { run_provenance: caller.subagentTriggerSource } : {}),
  });
}
