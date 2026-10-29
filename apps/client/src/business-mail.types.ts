export interface MailEndpoint { host: string; port: number; tls: 'implicit' | 'starttls'; username: string; folder?: string }
export interface MailConfig { addresses: string[]; smtp?: MailEndpoint; imap?: MailEndpoint; jmap_url?: string; jmap_account_id?: string }
export interface MailAutomation { mode: 'off' | 'review' | 'automatic'; agent_runtime: Record<string, any> | null; objective: string; from?: string; max_replies_per_day: number }
export interface MailConnectionInput {
  id?: string; revision?: number; company_id: string | null; name: string; provider: 'smtp_imap' | 'jmap'; purpose: string;
  credential_id: string; config: MailConfig; enabled: boolean; interval_minutes: number;
  notify_incoming?: boolean; automation?: MailAutomation;
}
export interface MailConnection extends MailConnectionInput {
  id: string; account_id: string; revision: number; status: string; synced_at: string; last_error: string; busy: boolean;
  receiving?: { mode: 'idle' | 'push' | 'polling'; error?: string };
}
export interface MailConnections {
  connectors: Array<{ id: string; name: string; credential_provider: string; note: string }>;
  connections: MailConnection[]; credentials: Array<{ id: string; name: string; account_id: string }>;
}
export interface BusinessMailMessage {
  id: string; connection_id: string; direction: 'inbound' | 'outbound'; status: 'received' | 'sending' | 'accepted' | 'uncertain';
  from: string; to: string[]; reply_to?: string; subject: string; text?: string; preview?: string; date: string; created_at: string;
  message_id?: string; in_reply_to?: string; references?: string[];
  confirmed: boolean; confirmed_at: string; confirmed_by: string; note?: string; revision: number;
  truncated?: boolean; last_error: string; attachments: Array<{ name: string; type: string; size: number }>;
  reply?: { id: string; status: MailReply['status'] } | null;
}
export interface MailList { messages: BusinessMailMessage[]; total: number; offset: number; limit: number }
/** A conversation (replies and forwards grouped). Its summary covers all of its mail, not only the filtered ones. */
export interface MailThread {
  id: string; latest_id: string; subject: string; preview: string; last_at: string;
  count: number; inbound: number; outbound: number; unconfirmed: number; attachments: number;
  senders: string[]; connection_ids: string[];
  statuses: Array<BusinessMailMessage['status']>; replies: Array<MailReply['status']>;
}
export interface MailThreadList { view: 'threads'; threads: MailThread[]; total: number; offset: number; limit: number }
export interface BusinessMailWithThread extends BusinessMailMessage {
  thread: { id: string; total: number; messages: BusinessMailMessage[] };
}
export interface MailSendInput {
  request_id: string; from: string; to: string[]; subject: string; text: string;
  reply_to_message_id?: string; forward_message_id?: string; confirm: true;
}
export interface MailReply {
  id: string; message_id: string; connection_id: string;
  status: 'queued' | 'drafting' | 'review' | 'sending' | 'sent' | 'uncertain' | 'skipped' | 'failed' | 'cancelled';
  mode: MailAutomation['mode']; objective: string; from: string; to: string; subject: string; text: string; note: string;
  revision: number; last_error: string; room_id: string; outbound_message_id: string; notification_state: string; review_notification_state: string;
}
