import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { subscriptionInput } from '../../event-subscriptions/event-subscription-schema';
import { err, ok } from '../shared/helpers';
import { getCallerAgent } from '../shared/session-auth';
import type { ToolContext } from './context';

export function registerEventSubscriptionTools(server: McpServer, ctx: ToolContext): void {
  const run = async (fn: (svc: NonNullable<ToolContext['eventSubscriptionsService']>) => Promise<unknown>) => {
    if (!ctx.eventSubscriptionsService) return err('Event subscriptions require the NestJS-integrated AWB server.');
    try { return ok(await fn(ctx.eventSubscriptionsService)); }
    catch (e: any) { return err(e?.message || 'Event subscription failed', { code: e?.code, status: e?.status }); }
  };
  server.tool(
    'list_event_types',
    'Describe subscribable AWB events and source filters. Requires a DB-backed full-scope Host/runtime key. No transcripts or secrets are copied into events.',
    {},
    async () => ok({
      events: [
        { event_type: 'session.turn_completed', source: ['manager_id', 'cli', 'session_id'], optional_filters: ['turn_id'], description: 'A successful turn in an AWB-opened native session, including another Host/CLI in the same Account. Cancellation is not success.' },
        { event_type: 'session.turn_failed', source: ['manager_id', 'cli', 'session_id'], optional_filters: ['turn_id'], description: 'A failed or cancelled native session turn.' },
        { event_type: 'ticket.changed', source: ['ticket_id'], optional_filters: ['status', 'action'], description: 'Ticket/comment activity. Example: status=done (optionally action=moved).' },
        { event_type: 'chat.message', source: ['room_id'], optional_filters: ['sender_type'], description: 'A user/agent message in a room you can read. Excludes progress, system notices and your own runtime replies.' },
      ],
      delivery: 'subscribe_to_event wakes the calling native session, or the calling chat runtime in room_id. Busy native sessions wait; disconnected Hosts retry. No human approvals are granted.',
    }),
  );
  server.tool(
    'subscribe_to_event',
    'Save a bounded event wait and follow-up prompt, then return immediately so your current turn can finish. Requires a DB-backed full-scope native session or room runtime; source and recipient must remain in your Account. Native caller wakes itself; chat caller supplies its room_id. Default: one trigger, expires in 24h. Exact turn_id can match an already recorded completion; otherwise future events only. Delivery retries until expiry and may repeat after a crash: check delivery ID before side effects. Never creates tickets.',
    subscriptionInput.shape,
    async (args, extra) => run(svc => svc.create(getCallerAgent(extra), args)),
  );
  server.tool(
    'list_event_subscriptions',
    'List your own event waits and recent deliveries, including status, retry errors and expiry. Full-scope native session or chat runtime only; chat callers pass room_id.',
    { room_id: z.string().uuid().optional() },
    async (args, extra) => run(svc => svc.list(getCallerAgent(extra), args.room_id)),
  );
  server.tool(
    'cancel_event_subscription',
    'Cancel your own event wait and pending deliveries. Full-scope native session or chat runtime only; chat callers pass room_id. Already submitted work cannot be recalled.',
    { subscription_id: z.string().uuid(), room_id: z.string().uuid().optional() },
    async (args, extra) => run(svc => svc.cancel(getCallerAgent(extra), args.subscription_id, args.room_id)),
  );
}
