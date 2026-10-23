export interface MailEndpoint { host: string; port: number; tls: 'implicit' | 'starttls'; username: string; folder?: string }
export interface MailConfig { addresses: string[]; smtp?: MailEndpoint; imap?: MailEndpoint; jmap_url?: string; jmap_account_id?: string }
export interface MailConnectionInput {
  id?: string; revision?: number; company_id: string | null; name: string; provider: 'smtp_imap' | 'jmap'; purpose: string;
  credential_id: string; config: MailConfig; enabled: boolean; interval_minutes: number;
}
export interface MailConnection extends MailConnectionInput {
  id: string; account_id: string; revision: number; status: string; synced_at: string; last_error: string; busy: boolean;
}
export interface MailConnections {
  connectors: Array<{ id: string; name: string; credential_provider: string; note: string }>;
  connections: MailConnection[]; credentials: Array<{ id: string; name: string; account_id: string }>;
}
export interface BusinessMailMessage {
  id: string; connection_id: string; direction: 'inbound' | 'outbound'; status: 'received' | 'sending' | 'accepted' | 'uncertain';
  from: string; to: string[]; subject: string; text?: string; preview?: string; date: string; created_at: string;
  confirmed: boolean; confirmed_at: string; confirmed_by: string; note?: string; revision: number;
  truncated?: boolean; last_error: string; attachments: Array<{ name: string; type: string; size: number }>;
}
export interface MailList { messages: BusinessMailMessage[]; total: number; offset: number; limit: number }
