export type BusinessStage = 'formation' | 'trademark' | 'banking' | 'payments' | 'accounting' | 'support' | 'growth';
export type BusinessTaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export interface BusinessCompany {
  self_service?: Record<string, { answers: Record<string, boolean>; version: string; confirmed_at: string; actor_id: string }>;
  id: string; account_id: string; name: string; entity_type: 'LLC' | 'CCorp' | 'other'; country: string;
  service_choices: Partial<Record<BusinessStage, { provider: string; plan: string }>>;
  jurisdiction: string; description: string; campaign_ids: string[]; revision: number;
  created_at: string; updated_at: string; task_count?: number; done_count?: number;
}
export interface BusinessTask {
  id: string; company_id: string; account_id: string; title: string; stage: BusinessStage; status: BusinessTaskStatus;
  description: string; notes: string; owner: string; due_on: string | null; depends_on: string[]; blocked_by: string[];
  ticket_id: string | null; ticket: { id: string; title: string; status: string } | null; position: number;
}
export interface ServiceOffering {
  best_for: string; features: string[]; api_access: 'public' | 'partner' | 'unverified' | 'not_applicable'; api_note: string; external_steps: string[];
  pricing: { plans: Array<{ id: string; name: string; price: string; detail: string }>; extra: string; url: string; checked_at: string };
}
export interface BusinessConnector {
  offering?: ServiceOffering; formation?: { states: string[]; entity_types: string[] };
  id: string; name: string; stage: BusinessStage; color: string; monogram: string; mode: 'api' | 'handoff' | 'manual';
  summary: string; capabilities: string[]; setup_note: string; docs_url: string; portal_url: string;
  credential_provider?: string; secret_fields: string[];
  fields: Array<{ key: string; label: string; placeholder: string }>; environments: Array<'live' | 'sandbox'>;
}
export interface BusinessSnapshot {
  metrics: Array<{ label: string; value: string | number; amount_minor?: number; currency?: string }>;
  records: Array<{ id: string; label: string; status: string; date?: string; amount_minor?: number; currency?: string }>;
  note: string;
}
export interface BusinessConnection {
  id: string; company_id: string; provider: string; credential_id: string; environment: 'live' | 'sandbox';
  config: Record<string, string>; status: 'configured' | 'syncing' | 'connected' | 'error';
  snapshot: BusinessSnapshot | null; last_error: string; synced_at: string | null; attempted_at: string | null; revision: number;
}
export interface BusinessDetail {
  company: BusinessCompany; formations: BusinessFormation[]; tasks: BusinessTask[]; connections: BusinessConnection[];
  campaigns: Array<{ id: string; name: string; status: string; goal: string; cycle_count: number; next_cycle_at: string | null }>;
  events: Array<{ id: string; message: string; kind: string; created_at: string }>;
}
export type BusinessCompanyInput = Pick<BusinessCompany, 'name' | 'entity_type' | 'country' | 'jurisdiction' | 'description' | 'campaign_ids'>;
export type BusinessTaskInput = Partial<Pick<BusinessTask, 'title' | 'stage' | 'status' | 'description' | 'notes' | 'owner' | 'due_on' | 'depends_on' | 'ticket_id'>>;

export interface SelfServiceAssessment {
  residency: Array<{ subject: string; status: string; condition: string }>;
  provider: string; plan: string; checked_at: string; scope: string; eligible: boolean; stale: boolean; company_revision: number; confirmed_at: string | null;
  questions: Array<{ key: string; label: string; detail: string; required_yes: boolean }>;
  answers: Record<string, boolean>; unanswered: string[]; blockers: string[]; notices: string[];
  ein_route: 'online' | 'international' | 'ss4' | 'unknown' | null;
  steps: Array<{ title: string; where: string; detail: string; url: string }>;
  sources: Array<{ label: string; url: string }>;
}
export type CashKind = 'income' | 'expense' | 'capital_in' | 'capital_out' | 'loan_in' | 'loan_out' | 'transfer_in' | 'transfer_out' | 'refund_in' | 'refund_out';
export interface CashEntryInput { request_id: string; date: string; kind: CashKind; amount_minor: number; currency: 'USD'; description: string; evidence: string }
export interface CashEntry extends CashEntryInput { id: string; reconciled: boolean; voided: boolean; void_reason: string }
export interface CashPeriod { month: string; opening_minor: number; closing_minor: number; statement_reference: string; closed: boolean; closed_at: string; reopen_reason: string }
export interface Cashbook {
  month: string; currency: 'USD'; company_revision: number; entries: CashEntry[]; period: CashPeriod | null; note: string;
  summary: { inflow_minor: number; outflow_minor: number; net_minor: number; operating_in_minor: number; operating_out_minor: number; active_count: number; unreconciled_count: number };
}

export interface BusinessFormation {
  id: string; company_id: string; provider: string; credential_id: string; environment: 'sandbox' | 'live';
  payload_digest: string; revision: number; status: 'draft' | 'submitting' | 'uncertain' | 'submitted';
  summary: { name: string; state: string; entity_type: string; industry: string };
  state_fee_cents: number; quoted_at: string; attempted_at: string | null;
  external_company_id: string; provider_status: string; last_error: string;
}
export interface FormationAddress { line1: string; line2: string; city: string; state: string; postalCode: string; country: string; phone: string }
export interface FormationApplication {
  name: string; state: string; industry: string; description: string; first_name: string; last_name: string; email: string; address: FormationAddress;
}
export interface FormationReferences { industries: string[]; fees: Array<{ state: string; price_in_cents: number }> }
export interface FormationReview {
  formation: BusinessFormation;
  request: { customer: { firstName: string; lastName: string; email: string; countryOfResidence: string }; company: { description: string; responsibleParty: { address: FormationAddress } } } | null;
}

export type TrademarkPhase = 'preparing' | 'counsel' | 'contract' | 'filing' | 'examination' | 'registered';
export type TrademarkMailKind = 'quote' | 'engagement' | 'filing' | 'status' | 'office_action';
export interface TrademarkInput {
  mark: string; mark_type: 'word' | 'design'; owner_name: string; domicile_country: string;
  goods_services: string; classes: number[]; filing_basis: 'undecided' | 'use' | 'intent' | 'foreign' | 'madrid';
  evidence_notes: string; phase: TrademarkPhase; attorney_name: string; attorney_email: string; attorney_notes: string;
  engagement_url: string; serial_number: string; registration_number: string; next_due_on: string; deadline_source: string; notes: string;
}
export interface BusinessTrademark extends TrademarkInput {
  id: string; account_id: string; company_id: string; revision: number; created_at: string; updated_at: string;
}
export interface TrademarkMailPayload { from: string; to: string; reply_to: string; subject: string; text: string }
export interface TrademarkMail {
  id: string; company_id: string; trademark_id: string; trademark_revision: number; provider: string; credential_id: string;
  payload_digest: string; revision: number; status: 'draft' | 'sending' | 'sent' | 'uncertain'; subject: string; to: string;
  provider_message_id: string; delivery_status: string; checked_at: string | null; first_attempted_at: string | null;
  attempted_at: string | null; last_error: string; created_at: string;
}
export interface TrademarkMailReview { mail: TrademarkMail; payload: TrademarkMailPayload }
export interface TrademarkList { cases: BusinessTrademark[]; mail: TrademarkMail[] }

export interface TrademarkConnectorDefinition {
  id: string; name: string; icon: string; credential_provider: string; secret_fields: string[];
  auth: 'oauth' | 'api_key'; capabilities: string[]; setup: string; docs_url: string;
  fields: Array<{ key: string; label: string; placeholder?: string; options?: string[] }>;
  action?: 'mail' | 'contract'; webhook?: string;
}
export interface TrademarkIntegration {
  id: string; provider: string; credential_id: string; config: Record<string, string>; identity: Record<string, string> | null;
  status: 'configured' | 'connected' | 'error' | 'disconnected'; ready: boolean; auto_sync: boolean; interval_minutes: number;
  synced_at: string | null; next_sync_at: string | null; last_error: string; revision: number; summary: string;
  callback_url: string; webhook_url: string; reply_address: string; public_url_configured: boolean;
}
export interface TrademarkIntegrationInput { provider: string; credential_id: string; config: Record<string, string>; auto_sync: boolean; interval_minutes: number; revision?: number }
export interface TrademarkSourceRecord {
  id: string; integration_id: string; source_id: string; kind: 'email' | 'contract' | 'matter' | 'document' | 'deadline' | 'status';
  title: string; status: string; date?: string; text?: string; from?: string; to?: string[]; url?: string; details?: Record<string, string>;
}
export interface TrademarkIntegrationAction {
  id: string; integration_id: string; kind: 'mail' | 'contract'; status: 'draft' | 'sending' | 'sent' | 'uncertain'; external_id: string; external_status: string;
  payload_digest: string; revision: number; attempted_at: string | null; last_error: string; created_at: string; title: string;
  review?: { subject: string; from?: string; to?: string; reply_to?: string; text?: string; roles?: Array<{ role: string; name: string; email: string }>; template_name?: string; template_id?: string; documents?: string[] };
}
export interface TrademarkIntegrationsView { connectors: TrademarkConnectorDefinition[]; connections: TrademarkIntegration[]; records: TrademarkSourceRecord[]; actions: TrademarkIntegrationAction[] }
