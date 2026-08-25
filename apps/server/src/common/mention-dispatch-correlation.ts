import { randomUUID } from 'crypto';
import type { DataSource } from 'typeorm';
import { ActivityLog } from '../entities/ActivityLog';

/**
 * comment_mention도 실제 매니저 dispatch이므로 agent_trigger와 같은
 * trigger_emitted 원장에 먼저 기록한다. 반환 ID를 SSE에 실어 보내면 매니저의
 * suppressed ACK가 코멘트 ID를 트리거 ID로 오인하지 않고 정확히 상관된다.
 */
export async function recordCommentMentionDispatch(
  dataSource: DataSource,
  args: { ticketId: string; workspaceId: string; agentId: string; role: string },
): Promise<string> {
  const triggerId = randomUUID();
  await dataSource.getRepository(ActivityLog).save({
    entity_type: 'ticket',
    entity_id: args.ticketId,
    ticket_id: args.ticketId,
    workspace_id: args.workspaceId,
    actor_id: 'system',
    actor_name: 'MentionDispatch',
    action: 'trigger_emitted',
    field_changed: triggerId,
    new_value: JSON.stringify({ target_agent_id: args.agentId }),
    role: args.role,
    trigger_source: 'comment_mention',
  });
  return triggerId;
}
