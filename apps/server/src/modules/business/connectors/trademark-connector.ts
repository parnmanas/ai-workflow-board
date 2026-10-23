import type { TrademarkDetails } from '../trademark.types';

export interface TrademarkSourceRecord {
  source_id: string;
  kind: 'email' | 'contract' | 'matter' | 'document' | 'deadline' | 'status';
  title: string;
  status: string;
  date?: string;
  text?: string;
  from?: string;
  to?: string[];
  url?: string;
  details?: Record<string, string>;
}
export interface TrademarkConnectorDescriptor {
  id: string; name: string; icon: string; credential_provider: string; secret_fields: string[];
  auth: 'oauth' | 'api_key'; capabilities: string[]; setup: string; docs_url: string;
  fields: Array<{ key: string; label: string; placeholder?: string; options?: string[] }>;
  action?: 'mail' | 'contract'; webhook?: 'svix' | 'docusign';
}
export interface OAuthTokens { access_token: string; refresh_token: string; expires_at: number }
export interface IntegrationData {
  config: Record<string, string>;
  credential_digest: string;
  tokens?: OAuthTokens;
  identity?: Record<string, string>;
  cursor?: Record<string, string>;
  summary?: string;
  oauth?: { verifier: string; cookie_hash: string; expires: number; user_id: string; redirect_uri: string; credential_digest: string };
}
export interface TrademarkConnectorContext {
  id: string; data: IntegrationData; secrets: Record<string, string>; trademark: TrademarkDetails;
  external_ids: string[];
  request(url: string, options?: TrademarkHttpOptions): Promise<any>;
}
export interface TrademarkHttpOptions {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; json?: unknown;
  form?: Record<string, string>; response?: 'json' | 'text' | 'pdf' | 'empty';
}
export interface PreparedTrademarkAction {
  review: Record<string, any>;
  request: Record<string, any>;
  fingerprint?: string;
  documents?: Array<{ name: string; pdf: string }>;
}
export interface TrademarkActionResult { id: string; status: string; conversation_id?: string }
export interface TrademarkConnector {
  descriptor: TrademarkConnectorDescriptor;
  config(value: unknown): Record<string, string>;
  oauth?: {
    endpoints(config: Record<string, string>): { authorize: string; token: string; scope: string; pkce: boolean; basic?: boolean; extra?: Record<string, string> };
    identify(context: TrademarkConnectorContext): Promise<Record<string, string>>;
  };
  sync(context: TrademarkConnectorContext): Promise<{ records: TrademarkSourceRecord[]; summary: string; cursor?: Record<string, string> }>;
  options?(context: TrademarkConnectorContext): Promise<Record<string, any>>;
  receive?(context: TrademarkConnectorContext, event: any): Promise<TrademarkSourceRecord[]>;
  prepare?(context: TrademarkConnectorContext, input: unknown, actionId: string): Promise<PreparedTrademarkAction>;
  verify?(context: TrademarkConnectorContext, prepared: PreparedTrademarkAction): Promise<void>;
  execute?(context: TrademarkConnectorContext, prepared: PreparedTrademarkAction, actionId: string, checkpoint: (externalId: string) => Promise<void>): Promise<TrademarkActionResult>;
  reconcile?(context: TrademarkConnectorContext, prepared: PreparedTrademarkAction, actionId: string, externalId: string): Promise<TrademarkActionResult>;
  document?(context: TrademarkConnectorContext, externalId: string): Promise<Buffer>;
}
