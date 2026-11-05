import { z } from 'zod';
import { TICKET_STATUSES } from '../../common/ticket-status';

export const EVENT_TYPES = ['session.turn_completed', 'session.turn_failed', 'ticket.changed', 'chat.message'] as const;
export const subscriptionInput = z.object({
  event_type: z.enum(EVENT_TYPES),
  source: z.object({
    manager_id: z.string().uuid().optional(),
    cli: z.string().trim().min(1).max(40).optional(),
    session_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional(),
    turn_id: z.string().min(1).max(64).optional(),
    ticket_id: z.string().uuid().optional(),
    room_id: z.string().uuid().optional(),
    status: z.enum(TICKET_STATUSES).optional(),
    action: z.string().max(80).optional(),
    sender_type: z.enum(['user', 'agent']).optional(),
  }).strict(),
  prompt: z.string().trim().min(1).max(6000),
  room_id: z.string().uuid().optional().describe('Chat caller: your recipient room. Native session callers omit this to wake themselves.'),
  max_triggers: z.number().int().min(1).max(100).default(1),
  cooldown_seconds: z.number().int().min(10).max(86400).default(60),
  expires_in_seconds: z.number().int().min(60).max(604800).default(86400),
}).strict();
export type SubscriptionInput = z.input<typeof subscriptionInput>;

export function sourceKey(type: string, source: Record<string, string>): string {
  const fields = type.startsWith('session.') ? ['manager_id', 'cli', 'session_id']
    : type === 'ticket.changed' ? ['ticket_id'] : ['room_id'];
  const allowed = new Set([...fields, ...(type.startsWith('session.') ? ['turn_id']
    : type === 'ticket.changed' ? ['status', 'action'] : ['sender_type'])]);
  if (fields.some(field => !source[field]) || Object.keys(source).some(field => !allowed.has(field))) {
    throw new Error(`Source for ${type} requires ${fields.join(', ')}; only its documented filters are allowed.`);
  }
  return fields.map(field => source[field]).join('/');
}
