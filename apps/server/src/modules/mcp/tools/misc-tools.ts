/**
 * Miscellaneous MCP tools — things that don't fit a dedicated domain file.
 *
 * Tools:
 *   - Notification channels: list_channels, create_channel, update_channel,
 *     delete_channel (4 tools)
 *   - batch_operations: transactional bundle of ticket/comment mutations
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Channel } from '../../../entities/Channel';
import { Comment } from '../../../entities/Comment';
import { Ticket } from '../../../entities/Ticket';
import { ok, err } from '../shared/helpers';
import { findColumnByName, maxTicketPosition, maxChildPosition, shiftTicketPositions } from '../shared/ticket-helpers';
import { evaluateConsensusMoveGate } from '../../../services/consensus.service';
import { enforceAutoResponseBudget } from '../../../common/hard-budget-guard';
import type { ToolContext } from './context';

export function registerMiscTools(server: McpServer, ctx: ToolContext): void {
  const { dataSource, ticketRoleAssignmentService, activityService, roomMessagingService, logger } = ctx;
  const hardBudgetDeps = { dataSource, activityService, roomMessagingService, logger };

  // ─── Channels ──────────────────────────────────────────

  server.tool(
    'list_channels',
    'List all notification channels (Discord etc.)',
    {},
    async () => {
      const channels = await dataSource.getRepository(Channel).find({ order: { name: 'ASC' } });
      const masked = channels.map(ch => ({
        ...ch,
        bot_token: ch.bot_token ? '***' + ch.bot_token.slice(-4) : '',
      }));
      return ok(masked);
    }
  );

  server.tool(
    'create_channel',
    'Create a notification channel (e.g. Discord)',
    {
      name: z.string().describe('Channel name'),
      type: z.string().optional().default('discord').describe('Channel type'),
      bot_token: z.string().optional().default('').describe('Bot token'),
      channel_id: z.string().optional().default('').describe('External channel ID'),
      is_active: z.number().optional().default(1).describe('Active (1) or inactive (0)'),
      notify_on_status_change: z.number().optional().default(1).describe('Notify on status change'),
      notify_on_update: z.number().optional().default(1).describe('Notify on updates'),
      notify_on_comment: z.number().optional().default(1).describe('Notify on comments'),
    },
    async ({ name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment }) => {
      const channelRepo = dataSource.getRepository(Channel);
      const channel = await channelRepo.save(channelRepo.create({
        name, type, bot_token, channel_id, is_active,
        notify_on_status_change, notify_on_update, notify_on_comment,
      }));
      return ok({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
    }
  );

  server.tool(
    'update_channel',
    'Update a notification channel',
    {
      channel_db_id: z.string().describe('Channel DB ID'),
      name: z.string().optional().describe('New name'),
      type: z.string().optional().describe('New type'),
      bot_token: z.string().optional().describe('New bot token'),
      channel_id: z.string().optional().describe('New external channel ID'),
      is_active: z.number().optional().describe('Active (1) or inactive (0)'),
      notify_on_status_change: z.number().optional().describe('Notify on status change'),
      notify_on_update: z.number().optional().describe('Notify on updates'),
      notify_on_comment: z.number().optional().describe('Notify on comments'),
    },
    async ({ channel_db_id, name, type, bot_token, channel_id, is_active, notify_on_status_change, notify_on_update, notify_on_comment }) => {
      const channelRepo = dataSource.getRepository(Channel);
      const channel = await channelRepo.findOne({ where: { id: channel_db_id } });
      if (!channel) return err('Channel not found');

      if (name !== undefined) channel.name = name;
      if (type !== undefined) channel.type = type;
      if (bot_token !== undefined && bot_token !== '') channel.bot_token = bot_token;
      if (channel_id !== undefined) channel.channel_id = channel_id;
      if (is_active !== undefined) channel.is_active = is_active;
      if (notify_on_status_change !== undefined) channel.notify_on_status_change = notify_on_status_change;
      if (notify_on_update !== undefined) channel.notify_on_update = notify_on_update;
      if (notify_on_comment !== undefined) channel.notify_on_comment = notify_on_comment;

      await channelRepo.save(channel);
      return ok({ ...channel, bot_token: channel.bot_token ? '***' + channel.bot_token.slice(-4) : '' });
    }
  );

  server.tool(
    'delete_channel',
    'Delete a notification channel',
    { channel_db_id: z.string().describe('Channel DB ID') },
    async ({ channel_db_id }) => {
      const channelRepo = dataSource.getRepository(Channel);
      const channel = await channelRepo.findOne({ where: { id: channel_db_id } });
      if (!channel) return err('Channel not found');
      await channelRepo.delete(channel.id);
      return ok({ success: true });
    }
  );

  // ─── Batch operations ──────────────────────────────────────────

  server.tool(
    'batch_operations',
    `Execute multiple operations in a single transaction. Each operation object has an "action" field.
Supported actions:
  - create-ticket: { action, boardId?, column, title, description?, priority?, assignee? }
  - move-ticket: { action, boardId?, ticketId, toColumn, position?, force? }
  - add-child: { action, ticketId, title } (also accepts legacy "add-subtask")
  - update-child: { action, ticketId, title?, status? } (also accepts legacy "update-subtask" with subtaskId)
  - add-comment: { action, ticketId, author, content, authorType?, authorId? } (authorType defaults to 'agent' —
    hard-budget ceiling applies same as add_comment/ask_question/etc; pass authorType:'user' for a human-authored note)

CONSENSUS GATE — a move-ticket op that takes a MULTI-HOLDER ticket (its current column's routing
role has >=2 holders) OUT of its column (toColumn != current column) is rejected with a
"consensus_required" error on that op, same as the move_ticket tool. Advance such a ticket through
propose_move + record_agreement instead. Pass force:true on the op to bypass the gate — a deliberate
human/operator escape hatch, not an agent's way around consensus.`,
    {
      operations: z.array(z.record(z.string(), z.unknown())).describe('Array of operation objects'),
    },
    async ({ operations }) => {
      const results: any[] = [];

      await dataSource.transaction(async (manager) => {
        const tRepo = manager.getRepository(Ticket);
        const cRepo = manager.getRepository(Comment);

        for (const op of operations) {
          try {
            switch (op.action) {
              case 'create-ticket': {
                const col = await findColumnByName(manager, String(op.boardId), String(op.column));
                if (!col) { results.push({ error: `Column "${op.column}" not found` }); continue; }
                const pos = await maxTicketPosition(manager, col.id);
                const r = await tRepo.save(tRepo.create({
                  column_id: col.id, title: String(op.title), description: String(op.description || ''),
                  priority: String(op.priority || 'medium'), assignee: String(op.assignee || ''), labels: '[]', position: pos,
                }));
                results.push({ success: true, ticketId: r.id });
                break;
              }
              case 'move-ticket': {
                const col = await findColumnByName(manager, String(op.boardId), String(op.toColumn));
                if (!col) { results.push({ error: `Column "${op.toColumn}" not found` }); continue; }
                const t = await tRepo.findOne({ where: { id: String(op.ticketId) } });
                if (!t) { results.push({ error: 'Ticket not found' }); continue; }

                // 다중담당자·합의 게이트(T5, 잔여 경화 #3). batch_operations 의 raw 컬럼
                // 이동도 move_ticket 과 동일하게 게이트한다 — 홀더 ≥2 인 티켓을 컬럼 밖
                // (또는 다른 보드)으로 옮기는 우회를 봉쇄. move_ticket 과 같은 3개 조건:
                //   (1) op.force===true 는 우회(operator escape hatch),
                //   (2) ticketRoleAssignmentService 존재(standalone MCP 는 면제),
                //   (3) 대상컬럼 ≠ 현재컬럼(같은 컬럼 재정렬은 이탈이 아니라 면제).
                // 판정 실패는 이동을 막지 않는다(가용성 우선) — move_ticket 동일.
                if (op.force !== true && ticketRoleAssignmentService && col.id !== t.column_id) {
                  try {
                    const gate = await evaluateConsensusMoveGate(
                      { dataSource, ticketRoleAssignmentService },
                      t,
                    );
                    if (gate.blocked) {
                      const pending = gate.state.pending.map((p) => `${p.type}:${p.id}`).join(', ');
                      // 'consensus_required' 리터럴은 move_ticket(MCP)·REST 409·프롬프트
                      // 안내와 동일 토큰 — 소비자가 한 번의 grep 으로 모든 표면을 잡는다.
                      results.push({
                        error:
                          `consensus_required — 합의 필요(T5): 이 컬럼의 라우팅 역할 홀더 ${gate.state.required.length}명 ` +
                          `전원이 합의해야 이동할 수 있습니다. 아직 미성립 — 대기 중: [${pending || '없음'}]. ` +
                          `propose_move(target) 로 제안을 열고 전 홀더가 record_agreement(agree) 하면 자동 이동합니다. ` +
                          `op 에 force:true 또는 reporter override 로 우회할 수 있습니다.`,
                      });
                      continue;
                    }
                  } catch (e) {
                    logger?.warn?.('Consensus', `batch move-ticket gate eval failed: ${e instanceof Error ? e.message : String(e)}`);
                  }
                }

                await shiftTicketPositions(tRepo, { column_id: t.column_id }, t.position, -1);

                const cnt = await tRepo.createQueryBuilder('t')
                  .where('t.column_id = :colId AND t.id != :id AND t.parent_id IS NULL', { colId: col.id, id: t.id }).getCount();
                const pos = Number(op.position) || cnt;

                await shiftTicketPositions(tRepo, { column_id: col.id }, pos, +1, { inclusive: true, excludeId: t.id });

                await tRepo.update(t.id, { column_id: col.id, position: pos });
                results.push({ success: true, ticketId: String(op.ticketId), movedTo: op.toColumn });
                break;
              }
              case 'add-child':
              case 'add-subtask': {
                const parentTicket = await tRepo.findOne({ where: { id: String(op.ticketId) } });
                if (!parentTicket) { results.push({ error: `Parent ticket not found: ${op.ticketId}` }); break; }
                const newDepth = (parentTicket.depth || 0) + 1;
                if (newDepth > 2) { results.push({ error: `Max nesting depth (2) exceeded` }); break; }
                const position = await maxChildPosition(manager, String(op.ticketId));
                const r = await tRepo.save(tRepo.create({
                  parent_id: String(op.ticketId), depth: newDepth, column_id: null as any,
                  title: String(op.title), position, status: 'todo',
                }));
                results.push({ success: true, ticketId: r.id });
                break;
              }
              case 'update-child':
              case 'update-subtask': {
                const updates: any = {};
                if (op.done !== undefined) updates.status = op.done ? 'done' : 'todo';
                if (op.title !== undefined) updates.title = String(op.title);
                if (op.status !== undefined) updates.status = String(op.status);
                const childId = String(op.subtaskId || op.ticketId);
                await tRepo.update(childId, updates);
                results.push({ success: true, ticketId: childId });
                break;
              }
              case 'add-comment': {
                const ticketId = String(op.ticketId);
                const t = await tRepo.findOne({ where: { id: ticketId } });
                if (!t) { results.push({ error: 'Ticket not found' }); continue; }

                // Hard-budget guard (티켓 a940d75b, 잔여 우회 경로 50b92d71). 이 MCP
                // batch 경로는 REST agent-api.controller.ts 의 batch add-comment op 과
                // 동일하게 author_type 미지정 시 Comment 컬럼 기본값('user')으로 저장되어
                // agent 댓글이 사람 댓글로 오분류 → (a) 자동응답 캡을 완전히 우회했다.
                // ctx.dataSource(트랜잭션의 manager 아님)로 조회 — 하드버짓 초과 여부는
                // 이 배치 호출의 commit/rollback 과 무관하게 티켓의 누적 이력에 대한
                // 사실이므로, REST 배치 add-comment 와 동일하게 외부 dataSource 기준.
                const authorType = String(op.authorType || 'agent');
                if (authorType === 'agent') {
                  const budget = await enforceAutoResponseBudget(hardBudgetDeps, t);
                  if (budget.blocked) { results.push({ suppressed: true, reason: budget.reason }); continue; }
                }
                const r = await cRepo.save(cRepo.create({
                  ticket_id: ticketId,
                  author_type: authorType,
                  author_id: String(op.authorId || ''),
                  author: String(op.author || ''),
                  content: String(op.content),
                }));
                results.push({ success: true, commentId: r.id });
                break;
              }
              default:
                results.push({ error: `Unknown action: ${op.action}` });
            }
          } catch (opErr: any) {
            results.push({ error: opErr.message });
          }
        }
      });

      return ok({ results });
    }
  );
}
