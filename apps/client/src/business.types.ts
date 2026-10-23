export type BusinessStage = 'formation' | 'banking' | 'payments' | 'accounting' | 'support' | 'growth';
export type BusinessTaskStatus = 'todo' | 'in_progress' | 'waiting' | 'done';
export interface BusinessCompany {
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
  best_for: string; features: string[]; api_access: 'public' | 'partner' | 'unverified'; api_note: string; external_steps: string[];
  pricing: { plans: Array<{ id: string; name: string; price: string; detail: string }>; extra: string; url: string; checked_at: string };
}
export interface BusinessConnector {
  offering?: ServiceOffering; formation?: { states: string[]; entity_types: string[] };
  id: string; name: string; stage: BusinessStage; color: string; monogram: string; mode: 'api' | 'handoff';
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
