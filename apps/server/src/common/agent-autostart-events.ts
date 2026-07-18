// Internal (non-SSE) auto-start bus signal (ticket bfdd80b7).
//
// The chat path (RoomMessagingService, chat-rooms module) detects a message
// aimed at an offline/never-started agent, but it cannot inject the auto-start
// hub (AgentAutostartService, agents module) without reopening the module
// cycle. It fires this activityEvents signal instead; the hub consumes it.
//
// Lives in `common/` — imported by BOTH modules — so neither has to import the
// other's file (which would be a circular TS import, since the hub already
// imports RoomMessagingService).

export const AGENT_AUTOSTART_REQUESTED = 'agent_autostart_requested';

export interface AutostartRequestEvent {
  agent_id: string;
  agent_name?: string;
  room_id: string;
  workspace_id: string;
  source: 'chat';
}
